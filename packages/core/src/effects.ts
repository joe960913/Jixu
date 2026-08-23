import type {
  DriverError,
  ModelMessage,
  ModelRef,
  ModelResponse,
  ThreadMode,
  ToolDescriptor,
  ToolIdempotency,
} from "./domain.ts";
import type { JsonObject } from "./json.ts";
import type { ModelAccounting } from "./metrics.ts";
import type { PlanControlDescriptor, PlanSnapshot } from "./plan.ts";
import type { ProgressControlDescriptor } from "./progress.ts";
import type {
  ContextCompactionInput,
  ContinuityHandoff,
  ContinuityHandoffBody,
  ModelContextManifest,
  ModelMessageSource,
  ModelRuntimeContext,
} from "./context.ts";

export interface EffectEnvelope<TType extends string, TInput> {
  readonly attempt: number;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly input: TInput;
  readonly requestedByEventId: string;
  readonly threadId: string;
  readonly type: TType;
}

export interface ModelGenerateInput {
  readonly activePlan: PlanSnapshot | null;
  readonly contextManifest?: ModelContextManifest;
  readonly continuityHandoff?: ContinuityHandoff | null;
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly mode: ThreadMode;
  readonly model: ModelRef;
  readonly planControl: PlanControlDescriptor;
  readonly planRejectionFeedback?: string;
  readonly progressControl: ProgressControlDescriptor;
  readonly runtimeContext?: ModelRuntimeContext;
  readonly tools: readonly ToolDescriptor[];
}

export interface ToolExecuteInput {
  readonly arguments: JsonObject;
  readonly idempotency: ToolIdempotency;
  readonly name: string;
  readonly toolCallId: string;
}

export type ModelGenerateEffect = EffectEnvelope<
  "model.generate",
  ModelGenerateInput
>;

export type ContextCompactEffect = EffectEnvelope<
  "context.compact",
  ContextCompactionInput
>;

export type ToolExecuteEffect = EffectEnvelope<"tool.execute", ToolExecuteInput>;

export type EffectRequest =
  | ContextCompactEffect
  | ModelGenerateEffect
  | ToolExecuteEffect;

export function isToolIndeterminateExplanationEffect(
  effect: EffectRequest,
): boolean {
  if (effect.type === "model.generate") {
    return (
      effect.input.runtimeContext?.continuation.reason === "tool_indeterminate"
    );
  }
  return (
    effect.type === "context.compact" &&
    effect.input.continuation.reason === "tool_indeterminate"
  );
}

export function isRetainedIndeterminateToolEffect(
  effect: EffectRequest,
  messages: readonly ModelMessage[],
  messageSources: readonly ModelMessageSource[],
): effect is ToolExecuteEffect {
  if (effect.type !== "tool.execute") return false;
  const requestIndex = messageSources.findIndex(
    (source, index) =>
      source.eventId === effect.requestedByEventId &&
      messages[index]?.role === "assistant",
  );
  if (requestIndex < 0) return false;
  return messages.some(
    (message, index) =>
      index > requestIndex &&
      message.role === "tool" &&
      "error" in message &&
      message.disposition === "indeterminate" &&
      message.name === effect.input.name &&
      message.toolCallId === effect.input.toolCallId,
  );
}

export interface DriverSuccess<T> {
  readonly status: "succeeded";
  readonly value: T;
}

export interface DriverFailure {
  readonly error: DriverError;
  readonly status: "failed";
}

export interface DriverCancellation {
  readonly status: "cancelled";
}

export interface DriverIndeterminate {
  readonly error: DriverError;
  readonly status: "indeterminate";
}

export type DriverOutcome<T> =
  | DriverCancellation
  | DriverFailure
  | DriverIndeterminate
  | DriverSuccess<T>;

export type ModelOutcome = DriverOutcome<ModelResponse> & {
  readonly accounting?: ModelAccounting;
  readonly cancelledContent?: string;
  readonly planRejections?: readonly DriverError[];
};

export type ContextCompactionOutcome = DriverOutcome<ContinuityHandoffBody> & {
  readonly accounting?: ModelAccounting;
};
