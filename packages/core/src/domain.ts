import type { EffectRequest } from "./effects.ts";
import { cloneJson, isJsonObject } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";

export type RunStatus =
  | "cancelled"
  | "completed"
  | "created"
  | "failed"
  | "paused"
  | "running"
  | "waiting";

export interface ModelRef {
  readonly model: string;
  readonly provider: string;
}

export type ToolIdempotency = "idempotent" | "non-idempotent" | "none";

export interface ToolDescriptor {
  readonly description: string;
  readonly idempotency: ToolIdempotency;
  readonly inputSchema: JsonObject;
  readonly inputSchemaVersion: number;
  readonly name: string;
  readonly outputSchema: JsonObject;
  readonly outputSchemaVersion: number;
}

export interface AgentSnapshot {
  readonly instructions: string;
  readonly model: ModelRef;
  readonly tools: readonly ToolDescriptor[];
}

export interface ToolCall {
  readonly arguments: JsonObject;
  readonly id: string;
  readonly name: string;
}

export interface UserMessage {
  readonly content: string;
  readonly role: "user";
}

export interface AssistantMessage {
  readonly content: string;
  readonly role: "assistant";
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolMessage {
  readonly name: string;
  readonly output: JsonValue;
  readonly role: "tool";
  readonly toolCallId: string;
}

export type ModelMessage = AssistantMessage | ToolMessage | UserMessage;

export interface ModelResponse {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

export function parseModelResponse(value: unknown): ModelResponse {
  if (!isJsonObject(value)) {
    throw new TypeError("Model response must be a JSON object");
  }
  const content = value.content;
  const toolCalls = value.toolCalls;
  if (typeof content !== "string" || !Array.isArray(toolCalls)) {
    throw new TypeError("Model response must contain content and toolCalls");
  }

  const parsedCalls = toolCalls.map((call, index): ToolCall => {
    if (!isJsonObject(call)) {
      throw new TypeError(`Tool call ${index} must be a JSON object`);
    }
    if (
      typeof call.id !== "string" ||
      typeof call.name !== "string" ||
      !isJsonObject(call.arguments)
    ) {
      throw new TypeError(`Tool call ${index} has an invalid shape`);
    }
    return {
      arguments: cloneJson(call.arguments),
      id: call.id,
      name: call.name,
    };
  });

  return { content, toolCalls: parsedCalls };
}

export interface DriverError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ForkLineage {
  readonly parentEventId: string;
  readonly parentRunId: string;
  readonly parentSequence: number;
}

export interface WaitingReason {
  readonly effectId: string;
  readonly reasonCode: "effect_outcome_unknown";
}

export interface RunState {
  readonly agent: AgentSnapshot | null;
  readonly error: DriverError | null;
  readonly lineage: ForkLineage | null;
  readonly messages: readonly ModelMessage[];
  readonly pauseRequested: boolean;
  readonly pendingEffects: Readonly<Record<string, EffectRequest>>;
  readonly readyEffects: readonly EffectRequest[];
  readonly result: string | null;
  readonly revision: number;
  readonly runId: string;
  readonly status: RunStatus;
  readonly waitingReason: WaitingReason | null;
}

export interface Checkpoint {
  readonly eventId: string;
  readonly eventSchemaVersion: number;
  readonly reducerVersion: number;
  readonly runId: string;
  readonly sequence: number;
  readonly state: RunState;
  readonly stateDigest: string;
}

export function createInitialRunState(runId: string): RunState {
  return {
    agent: null,
    error: null,
    lineage: null,
    messages: [],
    pauseRequested: false,
    pendingEffects: {},
    readyEffects: [],
    result: null,
    revision: 0,
    runId,
    status: "created",
    waitingReason: null,
  };
}
