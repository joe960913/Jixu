import type {
  AgentSnapshot,
  DriverError,
  ModelResponse,
  PendingPlanRejection,
  ToolApprovalDecision,
} from "./domain.ts";
import type {
  ModelGenerateEffect,
  ToolExecuteEffect,
} from "./effects.ts";
import type { JsonValue } from "./json.ts";
import type { ModelAccounting } from "./metrics.ts";
import type { PlanSnapshot, PlanUpdateProposal } from "./plan.ts";
import type { AcceptedInput } from "./input.ts";

export const CURRENT_EVENT_SCHEMA_VERSION = 6;

export function isSupportedEventSchemaVersion(value: number): boolean {
  return value === 5 || value === CURRENT_EVENT_SCHEMA_VERSION;
}

export interface ThreadEvent<TType extends string, TPayload> {
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly id: string;
  readonly payload: TPayload;
  readonly threadId: string;
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: TType;
}

export interface ThreadEventPayloads {
  readonly "approval.decided": {
    readonly decision: ToolApprovalDecision;
    readonly effectId: string;
  };
  readonly "approval.requested": {
    readonly action: string;
    readonly effectId: string;
    readonly name: string;
    readonly resources: readonly string[];
    readonly toolCallId: string;
  };
  readonly "context.cleared": Record<string, never>;
  readonly "input.received": AcceptedInput;
  readonly "model.completed": {
    readonly accounting: ModelAccounting;
    readonly effectId: string;
    readonly planRejections?: readonly PendingPlanRejection[];
    readonly response: ModelResponse;
  };
  readonly "model.failed": {
    readonly accounting: ModelAccounting;
    readonly disposition: "failed" | "indeterminate";
    readonly effectId: string;
    readonly error: DriverError;
  };
  readonly "model.requested": { readonly effect: ModelGenerateEffect };
  readonly "plan.rejected": {
    readonly effectId: string;
    readonly error: DriverError;
    readonly proposals: readonly PlanUpdateProposal[];
    readonly repairAttempt?: number;
  };
  readonly "plan.updated": { readonly plan: PlanSnapshot };
  readonly "thread.created": { readonly agent: AgentSnapshot };
  readonly "thread.forked": {
    readonly parentEventId: string;
    readonly parentThreadId: string;
    readonly parentSequence: number;
  };
  readonly "thread.pause_requested": Record<string, never>;
  readonly "thread.paused": Record<string, never>;
  readonly "thread.continued": Record<string, never>;
  readonly "thread.waiting": {
    readonly effectId: string;
    readonly reasonCode: "effect_outcome_unknown";
  };
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

export type ThreadEventType = keyof ThreadEventPayloads;

export type AnyThreadEvent = {
  [TType in ThreadEventType]: ThreadEvent<TType, ThreadEventPayloads[TType]>;
}[ThreadEventType];

export interface ThreadEventInput<TType extends ThreadEventType> {
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly id: string;
  readonly payload: ThreadEventPayloads[TType];
  readonly threadId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: TType;
}

export function createThreadEvent<TType extends ThreadEventType>(
  input: ThreadEventInput<TType>,
): ThreadEvent<TType, ThreadEventPayloads[TType]> {
  return {
    ...input,
    schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
  };
}
