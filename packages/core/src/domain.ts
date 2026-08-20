import type { EffectRequest } from "./effects.ts";
import { cloneJson, isJsonObject } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { createInitialThreadMetrics } from "./metrics.ts";
import type { ThreadMetrics } from "./metrics.ts";
import { parsePlanUpdateProposal } from "./plan.ts";
import type {
  PendingPlanUpdate,
  PlanSnapshot,
  PlanUpdateProposal,
} from "./plan.ts";

export type ThreadStatus =
  | "idle"
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
  readonly planUpdates?: readonly PlanUpdateProposal[];
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

  const planUpdates = value.planUpdates ?? [];
  if (!Array.isArray(planUpdates)) {
    throw new TypeError("Model response planUpdates must be an array");
  }

  return {
    content,
    planUpdates: planUpdates.map((proposal, index) =>
      parsePlanUpdateProposal(proposal, `Model response planUpdates[${index}]`),
    ),
    toolCalls: parsedCalls,
  };
}

export interface DriverError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ForkLineage {
  readonly parentEventId: string;
  readonly parentThreadId: string;
  readonly parentSequence: number;
}

export interface EffectOutcomeWaitingReason {
  readonly effectId: string;
  readonly reasonCode: "effect_outcome_unknown";
}

export interface ToolApprovalWaitingReason {
  readonly effectId: string;
  readonly reasonCode: "tool_approval_required";
}

export type WaitingReason =
  | EffectOutcomeWaitingReason
  | ToolApprovalWaitingReason;

export type ToolApprovalDecision = "allow_once" | "deny";

export interface ToolApproval {
  readonly action: string;
  readonly decision: ToolApprovalDecision | null;
  readonly decisionEventId: string | null;
  readonly effectId: string;
  readonly name: string;
  readonly resources: readonly string[];
  readonly toolCallId: string;
}

export interface QueuedInput {
  readonly content: string;
  readonly eventId: string;
}

export interface PendingPlanRejection {
  readonly effectId: string;
  readonly error: DriverError;
  readonly proposals: readonly PlanUpdateProposal[];
  readonly repairAttempt?: number;
}

export interface ThreadState {
  readonly activePlan: PlanSnapshot | null;
  readonly agent: AgentSnapshot | null;
  readonly error: DriverError | null;
  readonly inputQueue: readonly QueuedInput[];
  readonly lineage: ForkLineage | null;
  readonly messages: readonly ModelMessage[];
  readonly metrics: ThreadMetrics;
  readonly pauseRequested: boolean;
  readonly pendingEffects: Readonly<Record<string, EffectRequest>>;
  readonly planRepairAttempts: number;
  readonly pendingPlanRejections: readonly PendingPlanRejection[];
  readonly pendingPlanUpdates: readonly PendingPlanUpdate[];
  readonly readyEffects: readonly EffectRequest[];
  readonly result: string | null;
  readonly revision: number;
  readonly threadId: string;
  readonly status: ThreadStatus;
  readonly toolApprovals: Readonly<Record<string, ToolApproval>>;
  readonly waitingReason: WaitingReason | null;
}

export interface Checkpoint {
  readonly eventId: string;
  readonly eventSchemaVersion: number;
  readonly reducerVersion: number;
  readonly threadId: string;
  readonly sequence: number;
  readonly state: ThreadState;
  readonly stateDigest: string;
}

export function createInitialThreadState(threadId: string): ThreadState {
  return {
    activePlan: null,
    agent: null,
    error: null,
    inputQueue: [],
    lineage: null,
    messages: [],
    metrics: createInitialThreadMetrics(),
    pauseRequested: false,
    pendingEffects: {},
    planRepairAttempts: 0,
    pendingPlanRejections: [],
    pendingPlanUpdates: [],
    readyEffects: [],
    result: null,
    revision: 0,
    threadId,
    status: "idle",
    toolApprovals: {},
    waitingReason: null,
  };
}
