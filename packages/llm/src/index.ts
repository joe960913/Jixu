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

import { cloneJson, isJsonObject } from "@jixu/core";
import type {
  DriverError,
  JsonValue,
  ModelDriver,
  ModelDriverContext,
  ModelGenerateEffect,
  ModelMessage,
  ModelOutcome,
  ModelResponse,
  ToolDescriptor,
} from "@jixu/core";

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
  readonly fetch?: typeof fetch;
  readonly provider?: string;
  readonly redactError?: (message: string) => string;
  readonly responsesClient?: OpenResponsesClient;
  readonly store?: boolean;
}

interface SharedProviderConfig {
  readonly apiKey?: string;
  readonly client?: OpenResponsesClient;
  readonly fetch?: typeof fetch;
  readonly redactError?: (message: string) => string;
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
  readonly provider: string;
  readonly redactError?: (message: string) => string;
  readonly secret?: string;
  readonly store: boolean;
}

function jsonString(value: JsonValue): string {
  return JSON.stringify(value);
}

function toInput(messages: readonly ModelMessage[]): ResponseInputItem[] {
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
  return input;
}

function toTool(tool: ToolDescriptor): OpenAITool {
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
  return input;
}

function toChatTool(tool: ToolDescriptor): ChatCompletionTool {
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

function toModelResponse(response: Response): ModelResponse {
  if (!Array.isArray(response.output)) {
    throw new TypeError("OpenResponses response.output must be an array");
  }
  const content: string[] = [];
  const toolCalls: ModelResponse["toolCalls"][number][] = [];

  for (const item of response.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        content.push(part.type === "output_text" ? part.text : part.refusal);
      }
      continue;
    }
    if (item.type !== "function_call") continue;

    const parsed: unknown = JSON.parse(item.arguments);
    if (!isJsonObject(parsed)) {
      throw new TypeError(
        `Function call ${item.call_id} arguments must be a JSON object`,
      );
    }
    toolCalls.push({
      arguments: cloneJson(parsed),
      id: item.call_id,
      name: item.name,
    });
  }

  return { content: content.join(""), toolCalls };
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

function failed(error: DriverError): ModelOutcome {
  return { error, status: "failed" };
}

function providerHeaders(config: OpenRouterModelDriverConfig): Record<string, string> {
  return {
    ...(config.appUrl === undefined ? {} : { "HTTP-Referer": config.appUrl }),
    ...(config.appName === undefined
      ? {}
      : { "X-OpenRouter-Title": config.appName }),
  };
}

export class OpenResponsesModelDriver implements ModelDriver {
  readonly #client: OpenResponsesClient;
  readonly #provider: string;
  readonly #redactError: (message: string) => string;
  readonly #store: boolean;

  constructor(config: OpenResponsesModelDriverConfig) {
    this.#client = config.client;
    this.#provider = config.provider;
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
          input: toInput(effect.input.messages),
          instructions: effect.input.instructions,
          model: effect.input.model.model,
          store: this.#store,
          stream: true,
          tools: effect.input.tools.map(toTool),
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
              runId: effect.runId,
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
              runId: effect.runId,
              type: "model.tool_arguments.delta",
            });
            break;
          case "response.completed":
            try {
              return { status: "succeeded", value: toModelResponse(event.response) };
            } catch (error) {
              return this.#invalidEvent(errorMessage(error, this.#provider));
            }
          case "response.failed":
          case "response.incomplete":
            return failed({
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
            });
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

  #invalidEvent(message: string): ModelOutcome {
    return failed({
      code: `${this.#provider}_response_invalid`,
      message: this.#redactError(message),
      retryable: false,
    });
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
  readonly #provider: string;
  readonly #redactError: (message: string) => string;

  constructor(config: {
    readonly client: OpenChatCompletionsClient;
    readonly provider: string;
    readonly redactError?: (message: string) => string;
    readonly secret?: string;
  }) {
    this.#client = config.client;
    this.#provider = config.provider;
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
    const tools = effect.input.tools.map(toChatTool);
    let stream: AsyncIterable<unknown>;
    try {
      stream = await this.#client.create(
        {
          messages: toChatMessages(
            effect.input.instructions,
            effect.input.messages,
          ),
          model: effect.input.model.model,
          stream: true,
          ...(tools.length === 0 ? {} : { tools }),
        },
        { signal: context.cancellation },
      );
    } catch (error) {
      return this.#requestFailure(error);
    }

    let content = "";
    let finishReason: string | null = null;
    let sawChoice = false;
    let signalSequence = 0;
    const pendingTools = new Map<number, PendingChatToolCall>();

    try {
      for await (const rawChunk of stream) {
        const chunk = record(rawChunk);
        if (chunk === null || !Array.isArray(chunk.choices)) {
          return this.#invalidEvent("Chat Completions emitted an invalid chunk");
        }
        for (const rawChoice of chunk.choices) {
          const choice = record(rawChoice);
          if (choice === null) {
            return this.#invalidEvent("Chat Completions emitted an invalid choice");
          }
          if (number(choice.index) !== 0) continue;
          const delta = record(choice.delta);
          if (delta === null) {
            return this.#invalidEvent("Chat Completions choice has no delta");
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
              runId: effect.runId,
              type: "model.output_text.delta",
            });
            signalSequence += 1;
          }

          if (delta.tool_calls === undefined) continue;
          if (!Array.isArray(delta.tool_calls)) {
            return this.#invalidEvent("Chat Completions tool_calls is invalid");
          }
          for (const rawTool of delta.tool_calls) {
            const tool = record(rawTool);
            const index = number(tool?.index);
            if (tool === null || index === undefined) {
              return this.#invalidEvent("Chat Completions Tool delta is invalid");
            }
            if (tool.type !== undefined && tool.type !== "function") {
              return this.#invalidEvent("Only function Tool calls are supported");
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
                runId: effect.runId,
                type: "model.tool_arguments.delta",
              });
              signalSequence += 1;
            }
          }
        }
      }
    } catch (error) {
      return this.#requestFailure(error);
    }

    if (!sawChoice) {
      return {
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
      });
    }

    const toolCalls: ModelResponse["toolCalls"][number][] = [];
    for (const [index, pending] of [...pendingTools].sort(
      ([left], [right]) => left - right,
    )) {
      if (pending.id === undefined || pending.name === undefined) {
        return this.#invalidEvent(`Tool call ${index} is incomplete`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(pending.arguments) as unknown;
      } catch {
        return this.#invalidEvent(`Tool call ${pending.id} arguments are invalid JSON`);
      }
      if (!isJsonObject(parsed)) {
        return this.#invalidEvent(
          `Tool call ${pending.id} arguments must be a JSON object`,
        );
      }
      toolCalls.push({
        arguments: cloneJson(parsed),
        id: pending.id,
        name: pending.name,
      });
    }
    return { status: "succeeded", value: { content, toolCalls } };
  }

  #invalidEvent(message: string): ModelOutcome {
    return failed({
      code: `${this.#provider}_response_invalid`,
      message: this.#redactError(message),
      retryable: false,
    });
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
    provider: "openai",
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
    provider: "openrouter",
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
      provider,
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
    provider,
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
