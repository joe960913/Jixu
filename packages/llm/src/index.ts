import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

import {
  cloneJson,
  EMPTY_MODEL_ACCOUNTING,
  isJsonObject,
  MODEL_PROGRESS_SIGNAL_TYPE,
  parsePlanUpdateProposal,
  parseProgressUpdate,
  PLAN_CONTROL_NAME,
  PROGRESS_CONTROL_NAME,
} from "@jixu/core";
import type {
  DriverError,
  JsonObject,
  JsonValue,
  ModelAccounting,
  ModelDriver,
  ModelDriverContext,
  ModelGenerateEffect,
  ModelMessage,
  ModelOutcome,
  ModelResponse,
  PlanControlDescriptor,
  PlanUpdateProposal,
  ProgressControlDescriptor,
  ToolDescriptor,
} from "@jixu/core";

import { modelAccounting } from "./accounting.ts";
import type { ModelCostCalculator } from "./accounting.ts";
export type {
  ModelCostCalculationInput,
  ModelCostCalculator,
} from "./accounting.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

export type LLMApi =
  | "anthropic-messages"
  | "openai-chat-completions";

export interface OpenAIChatCompletionsClient {
  create(
    body: ChatCompletionCreateParamsStreaming,
    options?: { readonly signal?: AbortSignal },
  ): PromiseLike<AsyncIterable<unknown>>;
}

export interface AnthropicTextBlock {
  readonly text: string;
  readonly type: "text";
}

export interface AnthropicToolUseBlock {
  readonly id: string;
  readonly input: JsonObject;
  readonly name: string;
  readonly type: "tool_use";
}

export interface AnthropicToolResultBlock {
  readonly content: string;
  readonly tool_use_id: string;
  readonly type: "tool_result";
}

export interface AnthropicMessage {
  readonly content:
    | string
    | readonly (
        | AnthropicTextBlock
        | AnthropicToolResultBlock
        | AnthropicToolUseBlock
      )[];
  readonly role: "assistant" | "user";
}

export interface AnthropicTool {
  readonly description: string;
  readonly input_schema: JsonObject;
  readonly name: string;
}

export interface AnthropicMessagesRequest {
  readonly max_tokens: number;
  readonly messages: readonly AnthropicMessage[];
  readonly model: string;
  readonly stream: true;
  readonly system?: string | readonly AnthropicTextBlock[];
  readonly tools: readonly AnthropicTool[];
}

export interface AnthropicMessagesClient {
  create(
    body: AnthropicMessagesRequest,
    options?: { readonly signal?: AbortSignal },
  ): PromiseLike<AsyncIterable<unknown>>;
}

export interface LLMModelDriverConfig {
  readonly anthropicMessagesClient?: AnthropicMessagesClient;
  readonly anthropicVersion?: string;
  readonly api: LLMApi;
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly costCalculator?: ModelCostCalculator;
  readonly fetch?: typeof fetch;
  readonly maxOutputTokens?: number;
  readonly openAIChatCompletionsClient?: OpenAIChatCompletionsClient;
  readonly provider?: string;
  readonly providerReportsUsdCost?: boolean;
  readonly redactError?: (message: string) => string;
}

export type LLMAdapter = Readonly<Record<string, ModelDriver>>;

interface PendingToolCall {
  arguments: string;
  id?: string;
  initialInput?: JsonObject;
  name?: string;
}

class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

class InvalidProviderEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderEventError";
  }
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

function toAnthropicSystem(
  instructions: string,
  activePlan: ModelGenerateEffect["input"]["activePlan"],
): string | readonly AnthropicTextBlock[] | undefined {
  const planContext = activePlanContext(activePlan);
  if (planContext === null) return instructions.length === 0 ? undefined : instructions;
  return [
    ...(instructions.length === 0
      ? []
      : [{ text: instructions, type: "text" as const }]),
    { text: planContext, type: "text" },
  ];
}

function toAnthropicMessages(
  messages: readonly ModelMessage[],
): AnthropicMessage[] {
  const output: AnthropicMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "user") {
      output.push({ content: message.content, role: "user" });
      continue;
    }
    if (message.role === "assistant") {
      const content: (AnthropicTextBlock | AnthropicToolUseBlock)[] = [];
      if (message.content.length > 0) {
        content.push({ text: message.content, type: "text" });
      }
      content.push(
        ...message.toolCalls.map((call) => ({
          id: call.id,
          input: cloneJson(call.arguments),
          name: call.name,
          type: "tool_use" as const,
        })),
      );
      if (content.length > 0) output.push({ content, role: "assistant" });
      continue;
    }

    const results: AnthropicToolResultBlock[] = [];
    let cursor = index;
    while (cursor < messages.length) {
      const candidate = messages[cursor];
      if (candidate?.role !== "tool") break;
      results.push({
        content: jsonString(candidate.output),
        tool_use_id: candidate.toolCallId,
        type: "tool_result",
      });
      cursor += 1;
    }
    output.push({ content: results, role: "user" });
    index = cursor - 1;
  }
  return output;
}

function toAnthropicTool(
  tool: ToolDescriptor | PlanControlDescriptor | ProgressControlDescriptor,
): AnthropicTool {
  return {
    description: tool.description,
    input_schema: cloneJson(tool.inputSchema),
    name: tool.name,
  };
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

function isProgressOnly(
  response: ModelResponse,
  sawProgressControl: boolean,
): boolean {
  return (
    sawProgressControl &&
    response.content.trim().length === 0 &&
    (response.planUpdates?.length ?? 0) === 0 &&
    response.toolCalls.length === 0
  );
}

function completedResponse(
  content: string,
  pendingTools: readonly PendingToolCall[],
  effect: ModelGenerateEffect,
  context: ModelDriverContext,
): { readonly response: ModelResponse; readonly sawProgressControl: boolean } {
  const planUpdates: PlanUpdateProposal[] = [];
  const toolCalls: ModelResponse["toolCalls"][number][] = [];
  let sawProgressControl = false;

  for (const [index, pending] of pendingTools.entries()) {
    if (pending.id === undefined || pending.name === undefined) {
      throw new TypeError(`Tool call ${index} is incomplete`);
    }
    if (pending.name === PROGRESS_CONTROL_NAME) sawProgressControl = true;
    let parsed: unknown = pending.initialInput;
    if (pending.arguments.length > 0) {
      try {
        parsed = JSON.parse(pending.arguments) as unknown;
      } catch (error) {
        if (pending.name === PROGRESS_CONTROL_NAME) continue;
        throw error;
      }
    }
    if (!isJsonObject(parsed)) {
      if (pending.name === PROGRESS_CONTROL_NAME) continue;
      throw new TypeError(
        `Tool call ${pending.id} arguments must be a JSON object`,
      );
    }
    if (pending.name === PROGRESS_CONTROL_NAME) {
      try {
        emitModelProgress(
          effect,
          context,
          parseProgressUpdate(parsed, `Progress control ${pending.id}`).message,
        );
      } catch {
        // Progress is cosmetic and cannot invalidate an otherwise usable response.
      }
      continue;
    }
    if (pending.name === PLAN_CONTROL_NAME) {
      planUpdates.push(
        parsePlanUpdateProposal(parsed, `Plan control ${pending.id}`),
      );
      continue;
    }
    toolCalls.push({
      arguments: cloneJson(parsed),
      id: pending.id,
      name: pending.name,
    });
  }

  return {
    response: { content, planUpdates, toolCalls },
    sawProgressControl,
  };
}

function redactor(config: {
  readonly redactError?: (message: string) => string;
  readonly secret?: string;
}): (message: string) => string {
  return (message) => {
    const withoutSecret =
      config.secret === undefined || config.secret.length === 0
        ? message
        : message.replaceAll(config.secret, "[REDACTED]");
    return config.redactError?.(withoutSecret) ?? withoutSecret;
  };
}

function requestFailure(
  error: unknown,
  provider: string,
  redact: (message: string) => string,
  cancellation: AbortSignal,
  accounting: ModelAccounting = EMPTY_MODEL_ACCOUNTING,
): ModelOutcome {
  if (cancellation.aborted) {
    return failed(
      {
        code: `${provider}_cancelled`,
        message: `${provider} request was cancelled`,
        retryable: false,
      },
      accounting,
    );
  }
  const status = statusCode(error);
  const retryable =
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500;
  return {
    accounting,
    error: {
      code:
        status === undefined
          ? `${provider}_request_error`
          : `${provider}_http_${status}`,
      message: redact(errorMessage(error, provider)),
      retryable,
    },
    status: status === undefined ? "indeterminate" : "failed",
  };
}

function invalidEvent(
  provider: string,
  redact: (message: string) => string,
  message: string,
  accounting: ModelAccounting = EMPTY_MODEL_ACCOUNTING,
): ModelOutcome {
  return failed(
    {
      code: `${provider}_response_invalid`,
      message: redact(message),
      retryable: false,
    },
    accounting,
  );
}

function progressOnlyFailure(
  provider: string,
  accounting: ModelAccounting,
): ModelOutcome {
  return failed(
    {
      code: `${provider}_progress_only`,
      message: `${provider} returned only progress control without usable content, Plan changes, or Tool calls`,
      retryable: false,
    },
    accounting,
  );
}

function normalizeProviderBaseUrl(value: string): string {
  const clean = value.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    throw new TypeError("LLM Base URL must be a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("LLM Base URL must use HTTP or HTTPS");
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(
      "LLM Base URL must not contain credentials, query, or fragment",
    );
  }
  return clean;
}

function isOpenRouterBaseUrl(baseURL: string): boolean {
  const hostname = new URL(baseURL).hostname.toLowerCase();
  return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
}

class OpenAIChatCompletionsModelDriver implements ModelDriver {
  readonly #client: OpenAIChatCompletionsClient;
  readonly #costCalculator: ModelCostCalculator | undefined;
  readonly #provider: string;
  readonly #providerReportsUsdCost: boolean;
  readonly #redactError: (message: string) => string;

  constructor(config: {
    readonly client: OpenAIChatCompletionsClient;
    readonly costCalculator?: ModelCostCalculator;
    readonly provider: string;
    readonly providerReportsUsdCost: boolean;
    readonly redactError?: (message: string) => string;
    readonly secret?: string;
  }) {
    this.#client = config.client;
    this.#costCalculator = config.costCalculator;
    this.#provider = config.provider;
    this.#providerReportsUsdCost = config.providerReportsUsdCost;
    this.#redactError = redactor(config);
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
          stream: true,
          stream_options: { include_usage: true },
          tools,
        },
        { signal: context.cancellation },
      );
    } catch (error) {
      return requestFailure(
        error,
        this.#provider,
        this.#redactError,
        context.cancellation,
      );
    }

    let content = "";
    let accounting = EMPTY_MODEL_ACCOUNTING;
    let finishReason: string | null = null;
    let sawChoice = false;
    let signalSequence = 0;
    const pendingTools = new Map<number, PendingToolCall>();

    try {
      for await (const rawChunk of stream) {
        const chunk = record(rawChunk);
        if (chunk === null || !Array.isArray(chunk.choices)) {
          return invalidEvent(
            this.#provider,
            this.#redactError,
            "Chat Completions emitted an invalid chunk",
            accounting,
          );
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          accounting = modelAccounting(
            chunk.usage,
            "openai-chat-completions",
            {
              costCalculator: this.#costCalculator,
              model: effect.input.model.model,
              provider: this.#provider,
              providerReportsUsdCost: this.#providerReportsUsdCost,
            },
          );
        }
        for (const rawChoice of chunk.choices) {
          const choice = record(rawChoice);
          if (choice === null) {
            return invalidEvent(
              this.#provider,
              this.#redactError,
              "Chat Completions emitted an invalid choice",
              accounting,
            );
          }
          if (number(choice.index) !== 0) continue;
          const delta = record(choice.delta);
          if (delta === null) {
            return invalidEvent(
              this.#provider,
              this.#redactError,
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
              data: { delta: textDelta, sequence: signalSequence },
              kind: "signal",
              threadId: effect.threadId,
              type: "model.output_text.delta",
            });
            signalSequence += 1;
          }

          if (delta.tool_calls === undefined) continue;
          if (!Array.isArray(delta.tool_calls)) {
            return invalidEvent(
              this.#provider,
              this.#redactError,
              "Chat Completions tool_calls is invalid",
              accounting,
            );
          }
          for (const rawTool of delta.tool_calls) {
            const tool = record(rawTool);
            const index = number(tool?.index);
            if (tool === null || index === undefined) {
              return invalidEvent(
                this.#provider,
                this.#redactError,
                "Chat Completions Tool delta is invalid",
                accounting,
              );
            }
            if (tool.type !== undefined && tool.type !== "function") {
              return invalidEvent(
                this.#provider,
                this.#redactError,
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
              ...(string(functionDelta?.name) === undefined &&
              current.name === undefined
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
      return requestFailure(
        error,
        this.#provider,
        this.#redactError,
        context.cancellation,
        accounting,
      );
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
      return failed(
        {
          code: `${this.#provider}_response_incomplete`,
          message: `${this.#provider} stopped with ${finishReason}`,
          retryable: false,
        },
        accounting,
      );
    }

    try {
      const parsed = completedResponse(
        content,
        [...pendingTools]
          .sort(([left], [right]) => left - right)
          .map(([, pending]) => pending),
        effect,
        context,
      );
      if (isProgressOnly(parsed.response, parsed.sawProgressControl)) {
        return progressOnlyFailure(this.#provider, accounting);
      }
      return { accounting, status: "succeeded", value: parsed.response };
    } catch (error) {
      return invalidEvent(
        this.#provider,
        this.#redactError,
        errorMessage(error, this.#provider),
        accounting,
      );
    }
  }
}

function anthropicMessagesUrl(baseURL: string): string {
  const clean = baseURL.replace(/\/+$/u, "");
  if (clean.endsWith("/v1/messages")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/messages`;
  return `${clean}/v1/messages`;
}

function parseSseData(block: string): unknown | undefined {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0 || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new InvalidProviderEventError(
      "Anthropic Messages emitted invalid SSE JSON",
    );
  }
}

async function* decodeSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/u.exec(buffer);
        if (match?.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseSseData(block);
        if (event !== undefined) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const event = parseSseData(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function providerErrorMessage(body: string, status: number): string {
  try {
    const parsed = record(JSON.parse(body) as unknown);
    const nested = record(parsed?.error);
    return (
      string(nested?.message) ??
      string(parsed?.message) ??
      `Anthropic Messages request failed with HTTP ${status}`
    );
  } catch {
    const clean = body.trim();
    return clean.length === 0
      ? `Anthropic Messages request failed with HTTP ${status}`
      : clean.slice(0, 4000);
  }
}

class FetchAnthropicMessagesClient implements AnthropicMessagesClient {
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #fetch: typeof fetch;
  readonly #version: string;

  constructor(config: {
    readonly apiKey: string;
    readonly baseURL: string;
    readonly fetch?: typeof fetch;
    readonly version: string;
  }) {
    this.#apiKey = config.apiKey;
    this.#baseURL = config.baseURL;
    this.#fetch = config.fetch ?? fetch;
    this.#version = config.version;
  }

  async create(
    body: AnthropicMessagesRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AsyncIterable<unknown>> {
    const response = await this.#fetch(anthropicMessagesUrl(this.#baseURL), {
      body: JSON.stringify(body),
      headers: {
        "anthropic-version": this.#version,
        "content-type": "application/json",
        ...(isOpenRouterBaseUrl(this.#baseURL)
          ? { authorization: `Bearer ${this.#apiKey}` }
          : { "x-api-key": this.#apiKey }),
      },
      method: "POST",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      throw new ProviderHttpError(
        response.status,
        providerErrorMessage(await response.text(), response.status),
      );
    }
    if (response.body === null) {
      throw new InvalidProviderEventError(
        "Anthropic Messages response has no stream body",
      );
    }
    return decodeSse(response.body);
  }
}

function mergedUsage(
  current: Record<string, unknown>,
  next: unknown,
): Record<string, unknown> {
  const usage = record(next);
  return usage === null ? current : { ...current, ...usage };
}

class AnthropicMessagesModelDriver implements ModelDriver {
  readonly #client: AnthropicMessagesClient;
  readonly #costCalculator: ModelCostCalculator | undefined;
  readonly #maxOutputTokens: number;
  readonly #provider: string;
  readonly #providerReportsUsdCost: boolean;
  readonly #redactError: (message: string) => string;

  constructor(config: {
    readonly client: AnthropicMessagesClient;
    readonly costCalculator?: ModelCostCalculator;
    readonly maxOutputTokens: number;
    readonly provider: string;
    readonly providerReportsUsdCost: boolean;
    readonly redactError?: (message: string) => string;
    readonly secret?: string;
  }) {
    this.#client = config.client;
    this.#costCalculator = config.costCalculator;
    this.#maxOutputTokens = config.maxOutputTokens;
    this.#provider = config.provider;
    this.#providerReportsUsdCost = config.providerReportsUsdCost;
    this.#redactError = redactor(config);
  }

  async generate(
    effect: ModelGenerateEffect,
    context: ModelDriverContext,
  ): Promise<ModelOutcome> {
    const system = toAnthropicSystem(
      effect.input.instructions,
      effect.input.activePlan,
    );
    let stream: AsyncIterable<unknown>;
    try {
      stream = await this.#client.create(
        {
          max_tokens: this.#maxOutputTokens,
          messages: toAnthropicMessages(effect.input.messages),
          model: effect.input.model.model,
          stream: true,
          ...(system === undefined ? {} : { system }),
          tools: [
            ...effect.input.tools,
            effect.input.planControl,
            effect.input.progressControl,
          ].map(toAnthropicTool),
        },
        { signal: context.cancellation },
      );
    } catch (error) {
      if (error instanceof InvalidProviderEventError) {
        return invalidEvent(
          this.#provider,
          this.#redactError,
          error.message,
        );
      }
      return requestFailure(
        error,
        this.#provider,
        this.#redactError,
        context.cancellation,
      );
    }

    let accounting = EMPTY_MODEL_ACCOUNTING;
    let content = "";
    let sawMessageStart = false;
    let sawMessageStop = false;
    let signalSequence = 0;
    let stopReason: string | null = null;
    let usage: Record<string, unknown> = {};
    const pendingTools = new Map<number, PendingToolCall>();

    try {
      for await (const rawEvent of stream) {
        const event = record(rawEvent);
        const type = string(event?.type);
        if (event === null || type === undefined) {
          return invalidEvent(
            this.#provider,
            this.#redactError,
            "Anthropic Messages emitted a non-event value",
            accounting,
          );
        }
        if (type === "ping") continue;
        if (type === "error") {
          const nested = record(event.error);
          return failed(
            {
              code: string(nested?.type) ?? `${this.#provider}_stream_error`,
              message: this.#redactError(
                string(nested?.message) ?? `${this.#provider} stream failed`,
              ),
              retryable: string(nested?.type) === "overloaded_error",
            },
            accounting,
          );
        }
        if (type === "message_start") {
          const message = record(event.message);
          if (message === null) {
            return invalidEvent(
              this.#provider,
              this.#redactError,
              "Anthropic message_start has no message",
              accounting,
            );
          }
          sawMessageStart = true;
          usage = mergedUsage(usage, message.usage);
          accounting = modelAccounting(usage, "anthropic-messages", {
            costCalculator: this.#costCalculator,
            model: effect.input.model.model,
            provider: this.#provider,
            providerReportsUsdCost: this.#providerReportsUsdCost,
          });
          continue;
        }
        if (type === "content_block_start") {
          const index = number(event.index);
          const block = record(event.content_block);
          if (index === undefined || block === null) {
            return invalidEvent(
              this.#provider,
              this.#redactError,
              "Anthropic content_block_start is invalid",
              accounting,
            );
          }
          if (block.type === "text") {
            const initial = string(block.text) ?? "";
            if (initial.length > 0) content += initial;
          } else if (block.type === "tool_use") {
            const id = string(block.id);
            const name = string(block.name);
            const input = block.input;
            if (id === undefined || name === undefined || !isJsonObject(input)) {
              return invalidEvent(
                this.#provider,
                this.#redactError,
                "Anthropic tool_use block is invalid",
                accounting,
              );
            }
            pendingTools.set(index, {
              arguments: "",
              id,
              initialInput: cloneJson(input),
              name,
            });
          }
          continue;
        }
        if (type === "content_block_delta") {
          const index = number(event.index);
          const delta = record(event.delta);
          if (index === undefined || delta === null) {
            return invalidEvent(
              this.#provider,
              this.#redactError,
              "Anthropic content_block_delta is invalid",
              accounting,
            );
          }
          if (delta.type === "text_delta") {
            const textDelta = string(delta.text);
            if (textDelta === undefined) {
              return invalidEvent(
                this.#provider,
                this.#redactError,
                "Anthropic text_delta has no text",
                accounting,
              );
            }
            content += textDelta;
            if (textDelta.length > 0) {
              context.signals.emit({
                data: { delta: textDelta, sequence: signalSequence },
                kind: "signal",
                threadId: effect.threadId,
                type: "model.output_text.delta",
              });
              signalSequence += 1;
            }
          } else if (delta.type === "input_json_delta") {
            const partial = string(delta.partial_json);
            const pending = pendingTools.get(index);
            if (partial === undefined || pending === undefined) {
              return invalidEvent(
                this.#provider,
                this.#redactError,
                "Anthropic input_json_delta has no Tool block",
                accounting,
              );
            }
            pending.arguments += partial;
            if (partial.length > 0) {
              context.signals.emit({
                data: {
                  delta: partial,
                  itemId: pending.id ?? `tool-${index}`,
                  sequence: signalSequence,
                },
                kind: "signal",
                threadId: effect.threadId,
                type: "model.tool_arguments.delta",
              });
              signalSequence += 1;
            }
          }
          continue;
        }
        if (type === "message_delta") {
          const delta = record(event.delta);
          stopReason = string(delta?.stop_reason) ?? stopReason;
          usage = mergedUsage(usage, event.usage);
          accounting = modelAccounting(usage, "anthropic-messages", {
            costCalculator: this.#costCalculator,
            model: effect.input.model.model,
            provider: this.#provider,
            providerReportsUsdCost: this.#providerReportsUsdCost,
          });
          continue;
        }
        if (type === "message_stop") {
          sawMessageStop = true;
        }
        // Unknown future event types are ignored per the Anthropic SSE contract.
      }
    } catch (error) {
      accounting = modelAccounting(usage, "anthropic-messages", {
        costCalculator: this.#costCalculator,
        model: effect.input.model.model,
        provider: this.#provider,
        providerReportsUsdCost: this.#providerReportsUsdCost,
      });
      if (error instanceof InvalidProviderEventError) {
        return invalidEvent(
          this.#provider,
          this.#redactError,
          error.message,
          accounting,
        );
      }
      return requestFailure(
        error,
        this.#provider,
        this.#redactError,
        context.cancellation,
        accounting,
      );
    }

    accounting = modelAccounting(usage, "anthropic-messages", {
      costCalculator: this.#costCalculator,
      model: effect.input.model.model,
      provider: this.#provider,
      providerReportsUsdCost: this.#providerReportsUsdCost,
    });
    if (!sawMessageStart || !sawMessageStop) {
      return {
        accounting,
        error: {
          code: `${this.#provider}_stream_ended`,
          message: `${this.#provider} stream ended without a terminal message`,
          retryable: true,
        },
        status: "indeterminate",
      };
    }
    if (
      stopReason === "max_tokens" ||
      stopReason === "model_context_window_exceeded" ||
      stopReason === "pause_turn"
    ) {
      return failed(
        {
          code: `${this.#provider}_response_incomplete`,
          message: `${this.#provider} stopped with ${stopReason}`,
          retryable: false,
        },
        accounting,
      );
    }

    try {
      const parsed = completedResponse(
        content,
        [...pendingTools]
          .sort(([left], [right]) => left - right)
          .map(([, pending]) => pending),
        effect,
        context,
      );
      if (isProgressOnly(parsed.response, parsed.sawProgressControl)) {
        return progressOnlyFailure(this.#provider, accounting);
      }
      return { accounting, status: "succeeded", value: parsed.response };
    } catch (error) {
      return invalidEvent(
        this.#provider,
        this.#redactError,
        errorMessage(error, this.#provider),
        accounting,
      );
    }
  }
}

export function createLLMModelDriver(
  config: LLMModelDriverConfig,
): ModelDriver {
  const baseURL = normalizeProviderBaseUrl(config.baseURL);
  if (config.api === "openai-chat-completions") {
    if (
      config.apiKey === undefined &&
      config.openAIChatCompletionsClient === undefined
    ) {
      throw new TypeError(
        "OpenAI-compatible apiKey is required when no client is supplied",
      );
    }
    const client =
      config.openAIChatCompletionsClient ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL,
        maxRetries: 0,
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      }).chat.completions;
    return new OpenAIChatCompletionsModelDriver({
      client,
      ...(config.costCalculator === undefined
        ? {}
        : { costCalculator: config.costCalculator }),
      provider: config.provider?.trim() || "openai-compatible",
      providerReportsUsdCost:
        config.providerReportsUsdCost ?? isOpenRouterBaseUrl(baseURL),
      ...(config.redactError === undefined
        ? {}
        : { redactError: config.redactError }),
      ...(config.apiKey === undefined ? {} : { secret: config.apiKey }),
    });
  }

  if (config.api !== "anthropic-messages") {
    throw new TypeError(`Unsupported LLM API ${String(config.api)}`);
  }

  if (
    config.apiKey === undefined &&
    config.anthropicMessagesClient === undefined
  ) {
    throw new TypeError(
      "Anthropic Messages apiKey is required when no client is supplied",
    );
  }
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError("Anthropic Messages maxOutputTokens must be a positive integer");
  }
  const client =
    config.anthropicMessagesClient ??
    new FetchAnthropicMessagesClient({
      apiKey: config.apiKey ?? "",
      baseURL,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      version: config.anthropicVersion ?? ANTHROPIC_VERSION,
    });
  return new AnthropicMessagesModelDriver({
    client,
    ...(config.costCalculator === undefined
      ? {}
      : { costCalculator: config.costCalculator }),
    maxOutputTokens,
    provider: config.provider?.trim() || "anthropic",
    providerReportsUsdCost:
      config.providerReportsUsdCost ?? isOpenRouterBaseUrl(baseURL),
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
