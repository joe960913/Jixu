import type {
  AgentSnapshot,
  DriverError,
  ModelResponse,
} from "./domain.ts";
import type {
  ModelGenerateEffect,
  ToolExecuteEffect,
} from "./effects.ts";
import type { JsonValue } from "./json.ts";

export interface RunEvent<TType extends string, TPayload> {
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly id: string;
  readonly payload: TPayload;
  readonly runId: string;
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: TType;
}

export interface RunEventPayloads {
  readonly "input.received": { readonly content: string };
  readonly "model.completed": {
    readonly effectId: string;
    readonly response: ModelResponse;
  };
  readonly "model.failed": {
    readonly disposition: "failed" | "indeterminate";
    readonly effectId: string;
    readonly error: DriverError;
  };
  readonly "model.requested": { readonly effect: ModelGenerateEffect };
  readonly "run.created": { readonly agent: AgentSnapshot };
  readonly "tool.completed": {
    readonly effectId: string;
    readonly name: string;
    readonly output: JsonValue;
    readonly toolCallId: string;
  };
  readonly "tool.failed": {
    readonly disposition: "failed" | "indeterminate";
    readonly effectId: string;
    readonly error: DriverError;
    readonly name: string;
    readonly toolCallId: string;
  };
  readonly "tool.requested": { readonly effect: ToolExecuteEffect };
}

export type RunEventType = keyof RunEventPayloads;

export type AnyRunEvent = {
  [TType in RunEventType]: RunEvent<TType, RunEventPayloads[TType]>;
}[RunEventType];

export interface RunEventInput<TType extends RunEventType> {
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly id: string;
  readonly payload: RunEventPayloads[TType];
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: TType;
}

export function createRunEvent<TType extends RunEventType>(
  input: RunEventInput<TType>,
): RunEvent<TType, RunEventPayloads[TType]> {
  return {
    ...input,
    schemaVersion: 1,
  };
}
