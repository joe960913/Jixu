import type {
  DriverError,
  ThreadState,
} from "./domain.ts";
import type { ModelGenerateInput } from "./effects.ts";
import { InvalidTransitionError } from "./errors.ts";
import { jsonDigest } from "./json.ts";
import type { PlanSnapshot } from "./plan.ts";
import { createPlanControl } from "./plan.ts";
import { PROGRESS_CONTROL } from "./progress.ts";

export const CONTEXT_COMPILER_VERSION = 1;
export const MODEL_CONTEXT_SCHEMA_VERSION = 1;
export const MAX_PLAN_REPAIR_ATTEMPTS = 1;

export type ModelContinuationReason =
  | "input_received"
  | "plan_rejected"
  | "plan_updated"
  | "tool_completed";

export type ModelContextObligation =
  | "repair_plan_control"
  | "respond_or_act";

export type ModelContextProhibition =
  | "repeat_accepted_plan_change"
  | "repeat_rejected_plan_change";

export interface ModelContextReceipt {
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly eventId: string;
  readonly planId?: string;
  readonly planRevision?: number;
  readonly planStatus?: PlanSnapshot["status"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly type:
    | "input.received"
    | "plan.rejected"
    | "plan.updated"
    | "tool.completed";
}

export interface ModelRuntimeContext {
  readonly continuation: {
    readonly causedByEventId: string;
    readonly reason: ModelContinuationReason;
    readonly receipt: ModelContextReceipt;
  };
  readonly obligations: readonly ModelContextObligation[];
  readonly planRepair: {
    readonly attempt: number;
    readonly limit: number;
  } | null;
  readonly prohibitions: readonly ModelContextProhibition[];
  readonly schemaVersion: 1;
}

export type ModelContextSourceKind =
  | "active_plan"
  | "agent"
  | "messages"
  | "runtime"
  | "tools";

export interface ModelContextSourceManifest {
  readonly digest: string | null;
  readonly disposition: "excluded" | "included";
  readonly id: string;
  readonly kind: ModelContextSourceKind;
  readonly reason: string;
  readonly sensitivity: "internal" | "private";
  readonly trust: "accepted";
}

export interface ModelContextManifest {
  readonly activePlanRevision: number | null;
  readonly compilerVersion: 1;
  readonly logicalRequestDigest: string;
  readonly schemaVersion: 1;
  readonly sources: readonly ModelContextSourceManifest[];
}

export type ModelContinuation =
  | {
      readonly eventId: string;
      readonly reason: "input_received";
    }
  | {
      readonly eventId: string;
      readonly plan: PlanSnapshot;
      readonly reason: "plan_updated";
    }
  | {
      readonly error: DriverError;
      readonly eventId: string;
      readonly reason: "plan_rejected";
    }
  | {
      readonly eventId: string;
      readonly reason: "tool_completed";
      readonly toolCallId: string;
      readonly toolName: string;
    };

function receiptFor(continuation: ModelContinuation): ModelContextReceipt {
  switch (continuation.reason) {
    case "input_received":
      return {
        eventId: continuation.eventId,
        type: "input.received",
      };
    case "plan_updated":
      return {
        eventId: continuation.eventId,
        planId: continuation.plan.id,
        planRevision: continuation.plan.revision,
        planStatus: continuation.plan.status,
        type: "plan.updated",
      };
    case "plan_rejected":
      return {
        errorCode: continuation.error.code,
        errorMessage: normalizePlanRejectionFeedback(continuation.error.message),
        eventId: continuation.eventId,
        type: "plan.rejected",
      };
    case "tool_completed":
      return {
        eventId: continuation.eventId,
        toolCallId: continuation.toolCallId,
        toolName: continuation.toolName,
        type: "tool.completed",
      };
  }
}

function normalizePlanRejectionFeedback(message: string): string {
  return message.trim().replace(/\s+/gu, " ").slice(0, 500);
}

function runtimeContext(
  state: ThreadState,
  continuation: ModelContinuation,
): ModelRuntimeContext {
  const repairing = continuation.reason === "plan_rejected";
  return {
    continuation: {
      causedByEventId: continuation.eventId,
      reason: continuation.reason,
      receipt: receiptFor(continuation),
    },
    obligations: repairing
      ? ["repair_plan_control", "respond_or_act"]
      : ["respond_or_act"],
    planRepair:
      state.planRepairAttempts === 0 && !repairing
        ? null
        : {
            attempt: state.planRepairAttempts,
            limit: MAX_PLAN_REPAIR_ATTEMPTS,
          },
    prohibitions:
      continuation.reason === "plan_updated"
        ? ["repeat_accepted_plan_change"]
        : continuation.reason === "plan_rejected"
          ? ["repeat_rejected_plan_change"]
          : [],
    schemaVersion: MODEL_CONTEXT_SCHEMA_VERSION,
  };
}

function source(
  input: Omit<ModelContextSourceManifest, "trust">,
): ModelContextSourceManifest {
  return { ...input, trust: "accepted" };
}

export function compileModelContext(
  state: ThreadState,
  continuation: ModelContinuation,
): ModelGenerateInput {
  const agent = state.agent;
  if (agent === null) {
    throw new InvalidTransitionError(
      `Thread ${state.threadId} has no Agent definition`,
    );
  }
  const runtime = runtimeContext(state, continuation);
  const planRejectionFeedback =
    continuation.reason === "plan_rejected"
      ? normalizePlanRejectionFeedback(continuation.error.message)
      : undefined;
  const planControl = createPlanControl(state.activePlan);
  const logicalRequestDigest = jsonDigest({
    activePlan: state.activePlan,
    instructions: agent.instructions,
    messages: state.messages,
    model: agent.model,
    planControl,
    planRejectionFeedback: planRejectionFeedback ?? null,
    progressControl: PROGRESS_CONTROL,
    runtime,
    tools: agent.tools,
  });
  const manifest: ModelContextManifest = {
    activePlanRevision: state.activePlan?.revision ?? null,
    compilerVersion: CONTEXT_COMPILER_VERSION,
    logicalRequestDigest,
    schemaVersion: MODEL_CONTEXT_SCHEMA_VERSION,
    sources: [
      source({
        digest: jsonDigest(agent),
        disposition: "included",
        id: `agent:${jsonDigest(agent)}`,
        kind: "agent",
        reason: "immutable Agent configuration",
        sensitivity: "internal",
      }),
      source({
        digest: jsonDigest(state.messages),
        disposition: "included",
        id: `messages:${jsonDigest(state.messages)}`,
        kind: "messages",
        reason: "accepted model-visible Thread history",
        sensitivity: "private",
      }),
      state.activePlan === null
        ? source({
            digest: null,
            disposition: "excluded",
            id: "active-plan:none",
            kind: "active_plan",
            reason: "Thread has no active Plan",
            sensitivity: "private",
          })
        : source({
            digest: jsonDigest(state.activePlan),
            disposition: "included",
            id: `plan:${state.activePlan.id}:r${state.activePlan.revision}`,
            kind: "active_plan",
            reason: "current accepted Plan projection",
            sensitivity: "private",
          }),
      source({
        digest: jsonDigest(agent.tools),
        disposition: "included",
        id: `tools:${jsonDigest(agent.tools)}`,
        kind: "tools",
        reason: "Agent Tool descriptors",
        sensitivity: "internal",
      }),
      source({
        digest: jsonDigest(runtime),
        disposition: "included",
        id: `runtime:${jsonDigest(runtime)}`,
        kind: "runtime",
        reason: "Event-derived continuation semantics",
        sensitivity: "internal",
      }),
    ],
  };
  return {
    activePlan: state.activePlan,
    contextManifest: manifest,
    instructions: agent.instructions,
    messages: state.messages,
    model: agent.model,
    planControl,
    ...(planRejectionFeedback === undefined
      ? {}
      : { planRejectionFeedback }),
    progressControl: PROGRESS_CONTROL,
    runtimeContext: runtime,
    tools: agent.tools,
  };
}

export function copyModelContextForFork(
  input: ModelGenerateInput,
  mapEventId: (eventId: string) => string,
): ModelGenerateInput {
  if (
    input.runtimeContext === undefined ||
    input.contextManifest === undefined
  ) {
    return input;
  }
  const runtime: ModelRuntimeContext = {
    ...input.runtimeContext,
    continuation: {
      ...input.runtimeContext.continuation,
      causedByEventId: mapEventId(
        input.runtimeContext.continuation.causedByEventId,
      ),
      receipt: {
        ...input.runtimeContext.continuation.receipt,
        eventId: mapEventId(
          input.runtimeContext.continuation.receipt.eventId,
        ),
      },
    },
  };
  const logicalRequestDigest = jsonDigest({
    activePlan: input.activePlan,
    instructions: input.instructions,
    messages: input.messages,
    model: input.model,
    planControl: input.planControl,
    planRejectionFeedback: input.planRejectionFeedback ?? null,
    progressControl: input.progressControl,
    runtime,
    tools: input.tools,
  });
  const runtimeDigest = jsonDigest(runtime);
  return {
    ...input,
    contextManifest: {
      ...input.contextManifest,
      logicalRequestDigest,
      sources: input.contextManifest.sources.map((entry) =>
        entry.kind === "runtime"
          ? {
              ...entry,
              digest: runtimeDigest,
              id: `runtime:${runtimeDigest}`,
            }
          : entry,
      ),
    },
    runtimeContext: runtime,
  };
}
