import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseStreamEvent,
  Tool as OpenAITool,
} from "openai/resources/responses/responses";

import {
  cloneJson,
  MODEL_PROGRESS_SIGNAL_TYPE,
  isJsonObject,
  parsePlanUpdateProposal,
  parseProgressUpdate,
  PLAN_CONTROL_NAME,
  PROGRESS_CONTROL_NAME,
  EMPTY_MODEL_ACCOUNTING,
} from "@jixu/core";
import type {
  DriverError,
  JsonValue,
  ModelDriver,
  ModelDriverContext,
  ModelGenerateEffect,
  ModelAccounting,
  ModelMessage,
  ModelOutcome,
  ModelResponse,
  PlanControlDescriptor,
  PlanUpdateProposal,
  ProgressControlDescriptor,
  ToolDescriptor,
} from "@jixu/core";

import { isOpenRouterBaseUrl, modelAccounting } from "./accounting.ts";
import type { ModelCostCalculator } from "./accounting.ts";
export type {
  ModelCostCalculationInput,
  ModelCostCalculator,
} from "./accounting.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenResponsesClient {
  create(
    body: ResponseCreateParamsStreaming,
    options?: { readonly signal?: AbortSignal },
  ): PromiseLike<AsyncIterable<unknown>>;
}

export interface OpenChatCompletionsClient {
  create(
    body: ChatCompletionCreateParamsStreaming,
    options?: { readonly signal?: AbortSignal },
  ): PromiseLike<AsyncIterable<unknown>>;
}

export type OpenAICompatibleApiFormat = "chat-completions" | "responses";

export interface OpenAICompatibleModelDriverConfig {
  readonly apiFormat: OpenAICompatibleApiFormat;
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly chatCompletionsClient?: OpenChatCompletionsClient;
  readonly costCalculator?: ModelCostCalculator;
  readonly fetch?: typeof fetch;
  readonly provider?: string;
  readonly providerReportsUsdCost?: boolean;
  readonly redactError?: (message: string) => string;
  readonly responsesClient?: OpenResponsesClient;
  readonly store?: boolean;
  readonly useThreadPromptCacheKey?: boolean;
}

interface SharedProviderConfig {
  readonly apiKey?: string;
  readonly client?: OpenResponsesClient;
  readonly costCalculator?: ModelCostCalculator;
  readonly fetch?: typeof fetch;
  readonly redactError?: (message: string) => string;
  readonly useThreadPromptCacheKey?: boolean;
}

export interface OpenAIModelDriverConfig extends SharedProviderConfig {
  readonly baseURL?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly store?: boolean;
}

export interface OpenRouterModelDriverConfig extends SharedProviderConfig {
  readonly appName?: string;
  readonly appUrl?: string;
  readonly baseURL?: string;
}

export type LLMAdapter = Readonly<Record<string, ModelDriver>>;

interface OpenResponsesModelDriverConfig {
  readonly client: OpenResponsesClient;
  readonly costCalculator?: ModelCostCalculator;
  readonly provider: string;
  readonly providerReportsUsdCost: boolean;
  readonly promptCacheKey: boolean;
  readonly redactError?: (message: string) => string;
  readonly secret?: string;
  readonly store: boolean;
}

function jsonString(value: JsonValue): string {
  return JSON.stringify(value);
}

function activePlanContext(
  activePlan: ModelGenerateEffect["input"]["activePlan"],
): string | null {
  if (activePlan === null) return null;
  return [
    "Jixu runtime context. This is accepted coordination data, not a new user request, and it grants no permission.",
    "Current active Plan:",
    JSON.stringify(activePlan),
  ].join("\n");
}

function toInput(
  messages: readonly ModelMessage[],
  activePlan: ModelGenerateEffect["input"]["activePlan"],
): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ content: message.content, role: "user" });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content.length > 0) {
        input.push({ content: message.content, role: "assistant" });
      }
      for (const call of message.toolCalls) {
        input.push({
          arguments: jsonString(call.arguments),
          call_id: call.id,
          name: call.name,
          type: "function_call",
        });
      }
      continue;
    }
    input.push({
      call_id: message.toolCallId,
      name: message.name,
      output: jsonString(message.output),
      type: "function_call_output",
    });
  }
  const planContext = activePlanContext(activePlan);
  if (planContext !== null) {
    input.push({ content: planContext, role: "system" });
  }
  return input;
}

function toTool(
  tool: ToolDescriptor | PlanControlDescriptor | ProgressControlDescriptor,
): OpenAITool {
  return {
    description: tool.description,
    name: tool.name,
    parameters: cloneJson(tool.inputSchema),
    strict: false,
    type: "function",
  };
}

function toChatMessages(
  instructions: string,
  messages: readonly ModelMessage[],
  activePlan: ModelGenerateEffect["input"]["activePlan"],
): ChatCompletionMessageParam[] {
  const input: ChatCompletionMessageParam[] = [];
  if (instructions.length > 0) {
    input.push({ content: instructions, role: "system" });
  }
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ content: message.content, role: "user" });
      continue;
    }
    if (message.role === "assistant") {
      input.push({
        content: message.content.length === 0 ? null : message.content,
        role: "assistant",
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                function: {
                  arguments: jsonString(call.arguments),
                  name: call.name,
                },
                id: call.id,
                type: "function" as const,
              })),
            }),
      });
      continue;
    }
    input.push({
      content: jsonString(message.output),
      role: "tool",
      tool_call_id: message.toolCallId,
    });
  }
  const planContext = activePlanContext(activePlan);
  if (planContext !== null) {
    input.push({ content: planContext, role: "system" });
  }
  return input;
}

function toChatTool(
  tool: ToolDescriptor | PlanControlDescriptor | ProgressControlDescriptor,
): ChatCompletionTool {
  return {
    function: {
      description: tool.description,
      name: tool.name,
      parameters: cloneJson(tool.inputSchema),
      strict: false,
    },
    type: "function",
  };
}

function toModelResponse(
  response: Response,
  onProgress: (message: string) => void,
): ModelResponse {
  if (!Array.isArray(response.output)) {
    throw new TypeError("OpenResponses response.output must be an array");
  }
  const content: string[] = [];
  const planUpdates: PlanUpdateProposal[] = [];
  const toolCalls: ModelResponse["toolCalls"][number][] = [];

  for (const item of response.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        content.push(part.type === "output_text" ? part.text : part.refusal);
      }
      continue;
    }
    if (item.type !== "function_call") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(item.arguments) as unknown;
    } catch (error) {
      if (item.name === PROGRESS_CONTROL_NAME) continue;
      throw error;
    }
    if (!isJsonObject(parsed)) {
      if (item.name === PROGRESS_CONTROL_NAME) continue;
      throw new TypeError(
        `Function call ${item.call_id} arguments must be a JSON object`,
      );
    }
    if (item.name === PROGRESS_CONTROL_NAME) {
      try {
        onProgress(
          parseProgressUpdate(parsed, `Progress control ${item.call_id}`).message,
        );
      } catch {
        // Progress is cosmetic and cannot invalidate an otherwise usable response.
      }
      continue;
    }
    if (item.name === PLAN_CONTROL_NAME) {
      planUpdates.push(
        parsePlanUpdateProposal(parsed, `Plan control ${item.call_id}`),
      );
    } else {
      toolCalls.push({
        arguments: cloneJson(parsed),
        id: item.call_id,
        name: item.name,
      });
    }
  }

  return { content: content.join(""), planUpdates, toolCalls };
}

function emitModelProgress(
  effect: ModelGenerateEffect,
  context: ModelDriverContext,
  message: string,
): void {
  context.signals.emit({
    data: { message },
    kind: "signal",
    threadId: effect.threadId,
    type: MODEL_PROGRESS_SIGNAL_TYPE,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function errorMessage(error: unknown, provider: string): string {
  return error instanceof Error ? error.message : `Unknown ${provider} error`;
}

function statusCode(error: unknown): number | undefined {
  return number(record(error)?.status);
}

function failed(
  error: DriverError,
  accounting: ModelAccounting = EMPTY_MODEL_ACCOUNTING,
): ModelOutcome {
  return { accounting, error, status: "failed" };
}

function providerHeaders(config: OpenRouterModelDriverConfig): Record<string, string> {
  return {
    ...(config.appUrl === undefined ? {} : { "HTTP-Referer": config.appUrl }),
    ...(config.appName === undefined
      ? {}
      : { "X-OpenRouter-Title": config.appName }),
  };
}

function isOpenAIBaseUrl(baseURL: string): boolean {
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    return hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");
  } catch {
    return false;
  }
}

function supportsPromptCacheKey(baseURL: string): boolean {
  return isOpenRouterBaseUrl(baseURL) || isOpenAIBaseUrl(baseURL);
}

export class OpenResponsesModelDriver implements ModelDriver {
  readonly #client: OpenResponsesClient;
  readonly #costCalculator: ModelCostCalculator | undefined;
  readonly #provider: string;
  readonly #providerReportsUsdCost: boolean;
  readonly #promptCacheKey: boolean;
  readonly #redactError: (message: string) => string;
  readonly #store: boolean;

  constructor(config: OpenResponsesModelDriverConfig) {
    this.#client = config.client;
    this.#costCalculator = config.costCalculator;
    this.#provider = config.provider;
    this.#providerReportsUsdCost = config.providerReportsUsdCost;
    this.#promptCacheKey = config.promptCacheKey;
    this.#store = config.store;
    this.#redactError = (message) => {
      const withoutSecret =
        config.secret === undefined || config.secret.length === 0
          ? message
          : message.replaceAll(config.secret, "[REDACTED]");
      return config.redactError?.(withoutSecret) ?? withoutSecret;
    };
  }

  async generate(
    effect: ModelGenerateEffect,
    context: ModelDriverContext,
  ): Promise<ModelOutcome> {
    let stream: AsyncIterable<unknown>;
    try {
      stream = await this.#client.create(
        {
          input: toInput(effect.input.messages, effect.input.activePlan),
          instructions: effect.input.instructions,
          model: effect.input.model.model,
          ...(this.#promptCacheKey
            ? { prompt_cache_key: effect.threadId }
            : {}),
          store: this.#store,
          stream: true,
          tools: [
            ...effect.input.tools,
            effect.input.planControl,
            effect.input.progressControl,
          ].map(toTool),
        },
        { signal: context.cancellation },
      );
    } catch (error) {
      return this.#requestFailure(error);
    }

    try {
      for await (const rawEvent of stream) {
        const raw = record(rawEvent);
        const type = string(raw?.type);
        if (raw === null || type === undefined) {
          return this.#invalidEvent("Stream emitted a non-event value");
        }

        if (type === "error" || type === "response.error") {
          const nested = record(raw.error);
          return failed({
            code:
              string(raw.code) ??
              string(nested?.code) ??
              `${this.#provider}_stream_error`,
            message: this.#redactError(
              string(raw.message) ??
                string(nested?.message) ??
                `${this.#provider} stream failed`,
            ),
            retryable: true,
          });
        }

        const event = rawEvent as ResponseStreamEvent;
        switch (event.type) {
          case "response.output_text.delta":
            context.signals.emit({
              data: {
                delta: event.delta,
                itemId: event.item_id,
                sequence: event.sequence_number,
              },
              kind: "signal",
              threadId: effect.threadId,
              type: "model.output_text.delta",
            });
            break;
          case "response.function_call_arguments.delta":
            context.signals.emit({
              data: {
                delta: event.delta,
                itemId: event.item_id,
                sequence: event.sequence_number,
              },
              kind: "signal",
              threadId: effect.threadId,
              type: "model.tool_arguments.delta",
            });
            break;
          case "response.completed": {
            const accounting = modelAccounting(
              event.response.usage,
              "responses",
              {
                costCalculator: this.#costCalculator,
                model: effect.input.model.model,
                provider: this.#provider,
                providerReportsUsdCost: this.#providerReportsUsdCost,
              },
            );
            try {
              return {
                accounting,
                status: "succeeded",
                value: toModelResponse(event.response, (message) => {
                  emitModelProgress(effect, context, message);
                }),
              };
            } catch (error) {
              return this.#invalidEvent(
                errorMessage(error, this.#provider),
                accounting,
              );
            }
          }
          case "response.failed":
          case "response.incomplete":
            return failed(
              {
                code:
                  event.response.error?.code ??
                  (event.type === "response.failed"
                    ? `${this.#provider}_response_failed`
                    : `${this.#provider}_response_incomplete`),
                message: this.#redactError(
                  event.response.error?.message ??
                    event.response.incomplete_details?.reason ??
                    `${this.#provider} did not complete the response`,
                ),
                retryable: event.response.error?.code !== "invalid_prompt",
              },
              modelAccounting(event.response.usage, "responses", {
                costCalculator: this.#costCalculator,
                model: effect.input.model.model,
                provider: this.#provider,
                providerReportsUsdCost: this.#providerReportsUsdCost,
              }),
            );
          default:
            break;
        }
      }
    } catch (error) {
      return this.#requestFailure(error);
    }

    return {
      error: {
        code: `${this.#provider}_stream_ended`,
        message: `${this.#provider} stream ended without a terminal response`,
        retryable: true,
      },
      status: "indeterminate",
    };
  }

  #invalidEvent(
    message: string,
    accounting: ModelAccounting = EMPTY_MODEL_ACCOUNTING,
  ): ModelOutcome {
    return failed(
      {
        code: `${this.#provider}_response_invalid`,
        message: this.#redactError(message),
        retryable: false,
      },
      accounting,
    );
  }

  #requestFailure(error: unknown): ModelOutcome {
    const status = statusCode(error);
    const knownRejection = status !== undefined && status >= 400 && status < 500;
    return {
      error: {
        code:
          status === undefined
            ? `${this.#provider}_request_error`
            : `${this.#provider}_http_${status}`,
        message: this.#redactError(errorMessage(error, this.#provider)),
        retryable:
          status === undefined || status === 408 || status === 409 || status === 429,
      },
      status: knownRejection ? "failed" : "indeterminate",
    };
  }
}

interface PendingChatToolCall {
  arguments: string;
  id?: string;
  name?: string;
}

export class OpenChatCompletionsModelDriver implements ModelDriver {
  readonly #client: OpenChatCompletionsClient;
  readonly #costCalculator: ModelCostCalculator | undefined;
  readonly #provider: string;
  readonly #providerReportsUsdCost: boolean;
  readonly #promptCacheKey: boolean;
  readonly #redactError: (message: string) => string;

  constructor(config: {
    readonly client: OpenChatCompletionsClient;
    readonly costCalculator?: ModelCostCalculator;
    readonly provider: string;
    readonly providerReportsUsdCost: boolean;
    readonly promptCacheKey: boolean;
    readonly redactError?: (message: string) => string;
    readonly secret?: string;
  }) {
    this.#client = config.client;
    this.#costCalculator = config.costCalculator;
    this.#provider = config.provider;
    this.#providerReportsUsdCost = config.providerReportsUsdCost;
    this.#promptCacheKey = config.promptCacheKey;
    this.#redactError = (message) => {
      const withoutSecret =
        config.secret === undefined || config.secret.length === 0
          ? message
          : message.replaceAll(config.secret, "[REDACTED]");
      return config.redactError?.(withoutSecret) ?? withoutSecret;
    };
  }

  async generate(
    effect: ModelGenerateEffect,
    context: ModelDriverContext,
  ): Promise<ModelOutcome> {
    const tools = [
      ...effect.input.tools,
      effect.input.planControl,
      effect.input.progressControl,
    ].map(toChatTool);
    let stream: AsyncIterable<unknown>;
    try {
      stream = await this.#client.create(
        {
          messages: toChatMessages(
            effect.input.instructions,
            effect.input.messages,
            effect.input.activePlan,
          ),
          model: effect.input.model.model,
          ...(this.#promptCacheKey
            ? { prompt_cache_key: effect.threadId }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length === 0 ? {} : { tools }),
        },
        { signal: context.cancellation },
      );
    } catch (error) {
      return this.#requestFailure(error);
    }

    let content = "";
    let accounting = EMPTY_MODEL_ACCOUNTING;
    let finishReason: string | null = null;
    let sawChoice = false;
    let signalSequence = 0;
    const pendingTools = new Map<number, PendingChatToolCall>();

    try {
      for await (const rawChunk of stream) {
        const chunk = record(rawChunk);
        if (chunk === null || !Array.isArray(chunk.choices)) {
          return this.#invalidEvent(
            "Chat Completions emitted an invalid chunk",
            accounting,
          );
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          accounting = modelAccounting(chunk.usage, "chat-completions", {
            costCalculator: this.#costCalculator,
            model: effect.input.model.model,
            provider: this.#provider,
            providerReportsUsdCost: this.#providerReportsUsdCost,
          });
        }
        for (const rawChoice of chunk.choices) {
          const choice = record(rawChoice);
          if (choice === null) {
            return this.#invalidEvent(
              "Chat Completions emitted an invalid choice",
              accounting,
            );
          }
          if (number(choice.index) !== 0) continue;
          const delta = record(choice.delta);
          if (delta === null) {
            return this.#invalidEvent(
              "Chat Completions choice has no delta",
              accounting,
            );
          }
          sawChoice = true;
          finishReason = string(choice.finish_reason) ?? finishReason;

          const textDelta = string(delta.content) ?? string(delta.refusal);
          if (textDelta !== undefined && textDelta.length > 0) {
            content += textDelta;
            context.signals.emit({
              data: {
                delta: textDelta,
                sequence: signalSequence,
              },
              kind: "signal",
              threadId: effect.threadId,
              type: "model.output_text.delta",
            });
            signalSequence += 1;
          }

          if (delta.tool_calls === undefined) continue;
          if (!Array.isArray(delta.tool_calls)) {
            return this.#invalidEvent(
              "Chat Completions tool_calls is invalid",
              accounting,
            );
          }
          for (const rawTool of delta.tool_calls) {
            const tool = record(rawTool);
            const index = number(tool?.index);
            if (tool === null || index === undefined) {
              return this.#invalidEvent(
                "Chat Completions Tool delta is invalid",
                accounting,
              );
            }
            if (tool.type !== undefined && tool.type !== "function") {
              return this.#invalidEvent(
                "Only function Tool calls are supported",
                accounting,
              );
            }
            const current = pendingTools.get(index) ?? { arguments: "" };
            const functionDelta = record(tool.function);
            const argumentsDelta = string(functionDelta?.arguments) ?? "";
            pendingTools.set(index, {
              arguments: `${current.arguments}${argumentsDelta}`,
              ...(string(tool.id) === undefined && current.id === undefined
                ? {}
                : { id: string(tool.id) ?? current.id }),
              ...(string(functionDelta?.name) === undefined && current.name === undefined
                ? {}
                : { name: string(functionDelta?.name) ?? current.name }),
            });
            if (argumentsDelta.length > 0) {
              context.signals.emit({
                data: {
                  delta: argumentsDelta,
                  itemId: string(tool.id) ?? current.id ?? `tool-${index}`,
                  sequence: signalSequence,
                },
                kind: "signal",
                threadId: effect.threadId,
                type: "model.tool_arguments.delta",
              });
              signalSequence += 1;
            }
          }
        }
      }
    } catch (error) {
      return this.#requestFailure(error, accounting);
    }

    if (!sawChoice) {
      return {
        accounting,
        error: {
          code: `${this.#provider}_stream_ended`,
          message: `${this.#provider} stream ended without a completion choice`,
          retryable: true,
        },
        status: "indeterminate",
      };
    }
    if (finishReason === "content_filter" || finishReason === "length") {
      return failed({
        code: `${this.#provider}_response_incomplete`,
        message: `${this.#provider} stopped with ${finishReason}`,
        retryable: false,
      }, accounting);
    }

    const toolCalls: ModelResponse["toolCalls"][number][] = [];
    const planUpdates: PlanUpdateProposal[] = [];
    for (const [index, pending] of [...pendingTools].sort(
      ([left], [right]) => left - right,
    )) {
      if (pending.id === undefined || pending.name === undefined) {
        return this.#invalidEvent(`Tool call ${index} is incomplete`, accounting);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(pending.arguments) as unknown;
      } catch {
        if (pending.name === PROGRESS_CONTROL_NAME) continue;
        return this.#invalidEvent(
          `Tool call ${pending.id} arguments are invalid JSON`,
          accounting,
        );
      }
      if (!isJsonObject(parsed)) {
        if (pending.name === PROGRESS_CONTROL_NAME) continue;
        return this.#invalidEvent(
          `Tool call ${pending.id} arguments must be a JSON object`,
          accounting,
        );
      }
      if (pending.name === PROGRESS_CONTROL_NAME) {
        try {
          const update = parseProgressUpdate(
            parsed,
            `Progress control ${pending.id}`,
          );
          emitModelProgress(effect, context, update.message);
        } catch {
          // Progress is cosmetic and cannot invalidate an otherwise usable response.
        }
      } else if (pending.name === PLAN_CONTROL_NAME) {
        planUpdates.push(
          parsePlanUpdateProposal(parsed, `Plan control ${pending.id}`),
        );
      } else {
        toolCalls.push({
          arguments: cloneJson(parsed),
          id: pending.id,
          name: pending.name,
        });
      }
    }
    return {
      accounting,
      status: "succeeded",
      value: { content, planUpdates, toolCalls },
    };
  }

  #invalidEvent(
    message: string,
    accounting: ModelAccounting = EMPTY_MODEL_ACCOUNTING,
  ): ModelOutcome {
    return failed(
      {
        code: `${this.#provider}_response_invalid`,
        message: this.#redactError(message),
        retryable: false,
      },
      accounting,
    );
  }

  #requestFailure(
    error: unknown,
    accounting: ModelAccounting = EMPTY_MODEL_ACCOUNTING,
  ): ModelOutcome {
    const status = statusCode(error);
    const knownRejection = status !== undefined && status >= 400 && status < 500;
    return {
      accounting,
      error: {
        code:
          status === undefined
            ? `${this.#provider}_request_error`
            : `${this.#provider}_http_${status}`,
        message: this.#redactError(errorMessage(error, this.#provider)),
        retryable:
          status === undefined || status === 408 || status === 409 || status === 429,
      },
      status: knownRejection ? "failed" : "indeterminate",
    };
  }
}

export function createOpenAIModelDriver(
  config: OpenAIModelDriverConfig = {},
): OpenResponsesModelDriver {
  const client =
    config.client ??
    new OpenAI({
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      ...(config.organization === undefined
        ? {}
        : { organization: config.organization }),
      ...(config.project === undefined ? {} : { project: config.project }),
    }).responses;
  return new OpenResponsesModelDriver({
    client,
    ...(config.costCalculator === undefined
      ? {}
      : { costCalculator: config.costCalculator }),
    provider: "openai",
    providerReportsUsdCost: false,
    promptCacheKey: config.useThreadPromptCacheKey ?? true,
    ...(config.redactError === undefined
      ? {}
      : { redactError: config.redactError }),
    ...(config.apiKey === undefined ? {} : { secret: config.apiKey }),
    store: config.store ?? false,
  });
}

export function createOpenRouterModelDriver(
  config: OpenRouterModelDriverConfig = {},
): OpenResponsesModelDriver {
  if (config.client === undefined && config.apiKey === undefined) {
    throw new TypeError("OpenRouter apiKey is required when no client is supplied");
  }
  const client =
    config.client ??
    new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? OPENROUTER_BASE_URL,
      defaultHeaders: providerHeaders(config),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    }).responses;
  return new OpenResponsesModelDriver({
    client,
    ...(config.costCalculator === undefined
      ? {}
      : { costCalculator: config.costCalculator }),
    provider: "openrouter",
    providerReportsUsdCost: true,
    promptCacheKey: config.useThreadPromptCacheKey ?? true,
    ...(config.redactError === undefined
      ? {}
      : { redactError: config.redactError }),
    ...(config.apiKey === undefined ? {} : { secret: config.apiKey }),
    store: false,
  });
}

export function createOpenAICompatibleModelDriver(
  config: OpenAICompatibleModelDriverConfig,
): ModelDriver {
  const provider = config.provider?.trim() || "openai-compatible";
  if (
    config.apiKey === undefined &&
    config.responsesClient === undefined &&
    config.chatCompletionsClient === undefined
  ) {
    throw new TypeError(
      "OpenAI-compatible apiKey is required when no client is supplied",
    );
  }

  if (config.apiFormat === "responses") {
    const client =
      config.responsesClient ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      }).responses;
    return new OpenResponsesModelDriver({
      client,
      ...(config.costCalculator === undefined
        ? {}
        : { costCalculator: config.costCalculator }),
      provider,
      providerReportsUsdCost:
        config.providerReportsUsdCost ?? isOpenRouterBaseUrl(config.baseURL),
      promptCacheKey:
        config.useThreadPromptCacheKey ?? supportsPromptCacheKey(config.baseURL),
      ...(config.redactError === undefined
        ? {}
        : { redactError: config.redactError }),
      ...(config.apiKey === undefined ? {} : { secret: config.apiKey }),
      store: config.store ?? false,
    });
  }

  const client =
    config.chatCompletionsClient ??
    new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    }).chat.completions;
  return new OpenChatCompletionsModelDriver({
    client,
    ...(config.costCalculator === undefined
      ? {}
      : { costCalculator: config.costCalculator }),
    provider,
    providerReportsUsdCost:
      config.providerReportsUsdCost ?? isOpenRouterBaseUrl(config.baseURL),
    promptCacheKey:
      config.useThreadPromptCacheKey ?? supportsPromptCacheKey(config.baseURL),
    ...(config.redactError === undefined
      ? {}
      : { redactError: config.redactError }),
    ...(config.apiKey === undefined ? {} : { secret: config.apiKey }),
  });
}

export function createLLMAdapter(
  drivers: Readonly<Record<string, ModelDriver>>,
): LLMAdapter {
  const entries = Object.entries(drivers);
  if (entries.length === 0) {
    throw new TypeError("LLM adapter requires at least one Model Driver");
  }
  for (const [provider, driver] of entries) {
    if (provider.trim().length === 0 || typeof driver.generate !== "function") {
      throw new TypeError(`Invalid Model Driver registration for ${provider}`);
    }
  }
  return Object.freeze({ ...drivers });
}
