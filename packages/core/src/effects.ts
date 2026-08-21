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
  ModelContextManifest,
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

export type ToolExecuteEffect = EffectEnvelope<"tool.execute", ToolExecuteInput>;

export type EffectRequest = ModelGenerateEffect | ToolExecuteEffect;

export interface DriverSuccess<T> {
  readonly status: "succeeded";
  readonly value: T;
}

export interface DriverFailure {
  readonly error: DriverError;
  readonly status: "failed";
}

export interface DriverIndeterminate {
  readonly error: DriverError;
  readonly status: "indeterminate";
}

export type DriverOutcome<T> =
  | DriverFailure
  | DriverIndeterminate
  | DriverSuccess<T>;

export type ModelOutcome = DriverOutcome<ModelResponse> & {
  readonly accounting?: ModelAccounting;
  readonly planRejections?: readonly DriverError[];
};
