import type {
  AgentSnapshot,
  DriverError,
  ModelResponse,
  PendingPlanRejection,
  ThreadMode,
  ToolApprovalDecision,
} from "./domain.ts";
import type {
  ContextCompactEffect,
  ModelGenerateEffect,
  ToolExecuteEffect,
} from "./effects.ts";
import type { ContinuityHandoff } from "./context.ts";
import type { ArtifactReference } from "./input.ts";
import type { JsonValue } from "./json.ts";
import type { ModelAccounting } from "./metrics.ts";
import type { PlanSnapshot, PlanUpdateProposal } from "./plan.ts";
import type { AcceptedInput } from "./input.ts";

export const CURRENT_EVENT_SCHEMA_VERSION = 10;

export function isSupportedEventSchemaVersion(value: number): boolean {
  return (
    value === 5 ||
    value === 6 ||
    value === 7 ||
    value === 8 ||
    value === 9 ||
    value === CURRENT_EVENT_SCHEMA_VERSION
  );
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
  readonly "context.compacted": {
    readonly accounting: ModelAccounting;
    readonly artifact: ArtifactReference;
    readonly effectId: string;
    readonly handoff: ContinuityHandoff;
  };
  readonly "context.compaction_failed": {
    readonly accounting: ModelAccounting;
    readonly disposition: "cancelled" | "failed" | "indeterminate";
    readonly effectId: string;
    readonly error: DriverError;
  };
  readonly "context.compaction_requested": {
    readonly effect: ContextCompactEffect;
  };
  readonly "input.received": AcceptedInput;
  readonly "model.completed": {
    readonly accounting: ModelAccounting;
    readonly effectId: string;
    readonly planRejections?: readonly PendingPlanRejection[];
    readonly response: ModelResponse;
  };
  readonly "model.cancelled": {
    readonly accounting: ModelAccounting;
    readonly content: string;
    readonly effectId: string;
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
  readonly "thread.mode_changed": { readonly mode: ThreadMode };
  readonly "thread.pause_requested": Record<string, never>;
  readonly "thread.paused": Record<string, never>;
  readonly "thread.continued": Record<string, never>;
  readonly "thread.interrupt_requested": Record<string, never>;
  readonly "thread.interrupted": Record<string, never>;
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
  readonly "tool.cancelled": {
    readonly effectId: string;
    readonly name: string;
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
