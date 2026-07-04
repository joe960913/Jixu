import type {
  DriverError,
  ModelMessage,
  ModelRef,
  ModelResponse,
  ToolDescriptor,
  ToolIdempotency,
} from "./domain.ts";
import type { JsonObject } from "./json.ts";
import type { ModelAccounting } from "./metrics.ts";
import type { PlanControlDescriptor, PlanSnapshot } from "./plan.ts";
import type { ProgressControlDescriptor } from "./progress.ts";

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
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly model: ModelRef;
  readonly planControl: PlanControlDescriptor;
  readonly planRejectionFeedback?: string;
  readonly progressControl: ProgressControlDescriptor;
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
