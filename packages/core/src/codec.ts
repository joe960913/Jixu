import type { Checkpoint } from "./domain.ts";
import { parseModelResponse } from "./domain.ts";
import {
  CONTEXT_COMPILER_VERSION,
  MAX_PLAN_REPAIR_ATTEMPTS,
  MODEL_CONTEXT_SCHEMA_VERSION,
} from "./context.ts";
import type { EffectRequest } from "./effects.ts";
import { SchemaValidationError, UnsupportedEventError } from "./errors.ts";
import { isSupportedEventSchemaVersion } from "./events.ts";
import type { AnyThreadEvent, ThreadEventType } from "./events.ts";
import {
  cloneJson,
  isJsonObject,
  jsonDigest,
  jsonEquals,
} from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { parseModelAccounting, parseThreadMetrics } from "./metrics.ts";
import {
  materializePlanUpdates,
  parsePlanSnapshot,
  parsePlanUpdateProposal,
  PLAN_CONTROL_NAME,
} from "./plan.ts";
import type { PlanSnapshot } from "./plan.ts";
import { PROGRESS_CONTROL_NAME } from "./progress.ts";

function object(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new SchemaValidationError(`${label} must be a JSON object`);
  }
  return value;
}

function string(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new SchemaValidationError(`${label} must be a string`);
  }
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SchemaValidationError(`${label} must be an integer`);
  }
  return value;
}

function boolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new SchemaValidationError(`${label} must be a boolean`);
  }
  return value;
}

function array(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new SchemaValidationError(`${label} must be an array`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new SchemaValidationError(`${label} must be a string when present`);
  }
}

function assertToolCall(value: JsonValue | undefined, label: string): void {
  const item = object(value, label);
  string(item.id, `${label}.id`);
  string(item.name, `${label}.name`);
  object(item.arguments, `${label}.arguments`);
}

function assertToolDescriptor(
  value: JsonValue | undefined,
  label: string,
): void {
  const item = object(value, label);
  string(item.name, `${label}.name`);
  string(item.description, `${label}.description`);
  const idempotency = string(item.idempotency, `${label}.idempotency`);
  if (
    idempotency !== "idempotent" &&
    idempotency !== "non-idempotent" &&
    idempotency !== "none"
  ) {
    throw new SchemaValidationError(`${label}.idempotency is unsupported`);
  }
  object(item.inputSchema, `${label}.inputSchema`);
  object(item.outputSchema, `${label}.outputSchema`);
  integer(item.inputSchemaVersion, `${label}.inputSchemaVersion`);
  integer(item.outputSchemaVersion, `${label}.outputSchemaVersion`);
}

function assertAgentSnapshot(
  value: JsonValue | undefined,
  label: string,
): void {
  const item = object(value, label);
  string(item.instructions, `${label}.instructions`);
  const model = object(item.model, `${label}.model`);
  string(model.model, `${label}.model.model`);
  string(model.provider, `${label}.model.provider`);
  array(item.tools, `${label}.tools`).forEach((tool, index) =>
    assertToolDescriptor(tool, `${label}.tools[${index}]`),
  );
}

function assertModelMessage(
  value: JsonValue | undefined,
  label: string,
): void {
  const item = object(value, label);
  const role = string(item.role, `${label}.role`);
  if (role === "user") {
    string(item.content, `${label}.content`);
    return;
  }
  if (role === "assistant") {
    string(item.content, `${label}.content`);
    array(item.toolCalls, `${label}.toolCalls`).forEach((call, index) =>
      assertToolCall(call, `${label}.toolCalls[${index}]`),
    );
    return;
  }
  if (role === "tool") {
    string(item.name, `${label}.name`);
    string(item.toolCallId, `${label}.toolCallId`);
    if (item.output === undefined) {
      throw new SchemaValidationError(`${label}.output is required`);
    }
    return;
  }
  throw new SchemaValidationError(`${label}.role is unsupported`);
}

function assertDriverError(
  value: JsonValue | undefined,
  label: string,
): void {
  const item = object(value, label);
  string(item.code, `${label}.code`);
  string(item.message, `${label}.message`);
  boolean(item.retryable, `${label}.retryable`);
}

function assertPlanRejection(
  value: JsonValue | undefined,
  label: string,
): void {
  const item = object(value, label);
  string(item.effectId, `${label}.effectId`);
  assertDriverError(item.error, `${label}.error`);
  array(item.proposals, `${label}.proposals`).forEach((proposal, index) =>
    parsePlanUpdateProposal(proposal, `${label}.proposals[${index}]`),
  );
  if (item.repairAttempt !== undefined) {
    const repairAttempt = integer(item.repairAttempt, `${label}.repairAttempt`);
    if (repairAttempt < 1) {
      throw new SchemaValidationError(`${label}.repairAttempt must be positive`);
    }
  }
}

function assertModelRuntimeContext(
  value: JsonValue | undefined,
  label: string,
): void {
  const runtime = object(value, label);
  if (runtime.schemaVersion !== MODEL_CONTEXT_SCHEMA_VERSION) {
    throw new SchemaValidationError(`${label}.schemaVersion is unsupported`);
  }
  const continuation = object(runtime.continuation, `${label}.continuation`);
  string(continuation.causedByEventId, `${label}.continuation.causedByEventId`);
  const reason = string(continuation.reason, `${label}.continuation.reason`);
  if (
    reason !== "input_received" &&
    reason !== "plan_rejected" &&
    reason !== "plan_updated" &&
    reason !== "tool_completed"
  ) {
    throw new SchemaValidationError(`${label}.continuation.reason is unsupported`);
  }
  const receipt = object(
    continuation.receipt,
    `${label}.continuation.receipt`,
  );
  string(receipt.eventId, `${label}.continuation.receipt.eventId`);
  const receiptType = string(
    receipt.type,
    `${label}.continuation.receipt.type`,
  );
  if (
    receiptType !== "input.received" &&
    receiptType !== "plan.rejected" &&
    receiptType !== "plan.updated" &&
    receiptType !== "tool.completed"
  ) {
    throw new SchemaValidationError(
      `${label}.continuation.receipt.type is unsupported`,
    );
  }
  const expectedReceiptType = {
    input_received: "input.received",
    plan_rejected: "plan.rejected",
    plan_updated: "plan.updated",
    tool_completed: "tool.completed",
  }[reason];
  if (receiptType !== expectedReceiptType) {
    throw new SchemaValidationError(
      `${label}.continuation.receipt.type does not match continuation reason`,
    );
  }
  if (receipt.eventId !== continuation.causedByEventId) {
    throw new SchemaValidationError(
      `${label}.continuation.receipt.eventId does not match causedByEventId`,
    );
  }
  optionalString(receipt.errorCode, `${label}.continuation.receipt.errorCode`);
  optionalString(
    receipt.errorMessage,
    `${label}.continuation.receipt.errorMessage`,
  );
  optionalString(receipt.planId, `${label}.continuation.receipt.planId`);
  if (receipt.planRevision !== undefined) {
    const revision = integer(
      receipt.planRevision,
      `${label}.continuation.receipt.planRevision`,
    );
    if (revision < 1) {
      throw new SchemaValidationError(
        `${label}.continuation.receipt.planRevision must be positive`,
      );
    }
  }
  optionalString(receipt.planStatus, `${label}.continuation.receipt.planStatus`);
  if (
    receipt.planStatus !== undefined &&
    receipt.planStatus !== "abandoned" &&
    receipt.planStatus !== "active" &&
    receipt.planStatus !== "completed" &&
    receipt.planStatus !== "superseded"
  ) {
    throw new SchemaValidationError(
      `${label}.continuation.receipt.planStatus is unsupported`,
    );
  }
  optionalString(receipt.toolCallId, `${label}.continuation.receipt.toolCallId`);
  optionalString(receipt.toolName, `${label}.continuation.receipt.toolName`);
  array(runtime.obligations, `${label}.obligations`).forEach((value, index) => {
    if (value !== "repair_plan_control" && value !== "respond_or_act") {
      throw new SchemaValidationError(`${label}.obligations[${index}] is unsupported`);
    }
  });
  array(runtime.prohibitions, `${label}.prohibitions`).forEach((value, index) => {
    if (
      value !== "repeat_accepted_plan_change" &&
      value !== "repeat_rejected_plan_change"
    ) {
      throw new SchemaValidationError(
        `${label}.prohibitions[${index}] is unsupported`,
      );
    }
  });
  if (runtime.planRepair !== null) {
    const repair = object(runtime.planRepair, `${label}.planRepair`);
    const attempt = integer(repair.attempt, `${label}.planRepair.attempt`);
    const limit = integer(repair.limit, `${label}.planRepair.limit`);
    if (attempt < 1 || limit !== MAX_PLAN_REPAIR_ATTEMPTS) {
      throw new SchemaValidationError(`${label}.planRepair is invalid`);
    }
  }
  const expectedObligations =
    reason === "plan_rejected"
      ? ["repair_plan_control", "respond_or_act"]
      : ["respond_or_act"];
  const expectedProhibitions =
    reason === "plan_rejected"
      ? ["repeat_rejected_plan_change"]
      : reason === "plan_updated"
        ? ["repeat_accepted_plan_change"]
        : [];
  if (
    !jsonEquals(runtime.obligations, expectedObligations) ||
    !jsonEquals(runtime.prohibitions, expectedProhibitions)
  ) {
    throw new SchemaValidationError(
      `${label} obligations or prohibitions do not match continuation reason`,
    );
  }
  if (
    reason === "plan_rejected" &&
    (receipt.errorCode === undefined ||
      receipt.errorMessage === undefined ||
      runtime.planRepair === null)
  ) {
    throw new SchemaValidationError(
      `${label} rejected Plan continuation is incomplete`,
    );
  }
  if (
    reason === "plan_updated" &&
    (receipt.planId === undefined ||
      receipt.planRevision === undefined ||
      receipt.planStatus === undefined)
  ) {
    throw new SchemaValidationError(
      `${label} updated Plan continuation is incomplete`,
    );
  }
  if (
    reason === "tool_completed" &&
    (receipt.toolCallId === undefined || receipt.toolName === undefined)
  ) {
    throw new SchemaValidationError(
      `${label} completed Tool continuation is incomplete`,
    );
  }
}

function assertContextManifest(
  value: JsonValue | undefined,
  label: string,
): void {
  const manifest = object(value, label);
  if (manifest.schemaVersion !== MODEL_CONTEXT_SCHEMA_VERSION) {
    throw new SchemaValidationError(`${label}.schemaVersion is unsupported`);
  }
  if (manifest.compilerVersion !== CONTEXT_COMPILER_VERSION) {
    throw new SchemaValidationError(`${label}.compilerVersion is unsupported`);
  }
  string(manifest.logicalRequestDigest, `${label}.logicalRequestDigest`);
  if (manifest.activePlanRevision !== null) {
    const revision = integer(
      manifest.activePlanRevision,
      `${label}.activePlanRevision`,
    );
    if (revision < 1) {
      throw new SchemaValidationError(`${label}.activePlanRevision must be positive`);
    }
  }
  array(manifest.sources, `${label}.sources`).forEach((value, index) => {
    const source = object(value, `${label}.sources[${index}]`);
    string(source.id, `${label}.sources[${index}].id`);
    const kind = string(source.kind, `${label}.sources[${index}].kind`);
    if (
      kind !== "active_plan" &&
      kind !== "agent" &&
      kind !== "messages" &&
      kind !== "runtime" &&
      kind !== "tools"
    ) {
      throw new SchemaValidationError(
        `${label}.sources[${index}].kind is unsupported`,
      );
    }
    string(source.reason, `${label}.sources[${index}].reason`);
    if (source.digest !== null) {
      string(source.digest, `${label}.sources[${index}].digest`);
    }
    if (source.digest === undefined) {
      throw new SchemaValidationError(
        `${label}.sources[${index}].digest is required`,
      );
    }
    if (source.disposition !== "included" && source.disposition !== "excluded") {
      throw new SchemaValidationError(
        `${label}.sources[${index}].disposition is unsupported`,
      );
    }
    if (source.sensitivity !== "internal" && source.sensitivity !== "private") {
      throw new SchemaValidationError(
        `${label}.sources[${index}].sensitivity is unsupported`,
      );
    }
    if (source.trust !== "accepted") {
      throw new SchemaValidationError(`${label}.sources[${index}].trust is unsupported`);
    }
  });
}

function assertContextManifestMatchesInput(
  input: JsonObject,
  label: string,
): void {
  const manifest = object(input.contextManifest, `${label}.contextManifest`);
  const activePlan =
    input.activePlan === null
      ? null
      : object(input.activePlan, `${label}.activePlan`);
  const activePlanRevision = activePlan?.revision ?? null;
  if (manifest.activePlanRevision !== activePlanRevision) {
    throw new SchemaValidationError(
      `${label}.contextManifest.activePlanRevision does not match input`,
    );
  }
  const agentDigest = jsonDigest({
    instructions: input.instructions,
    model: input.model,
    tools: input.tools,
  });
  const messagesDigest = jsonDigest(input.messages);
  const toolsDigest = jsonDigest(input.tools);
  const runtimeDigest = jsonDigest(input.runtimeContext);
  const expected = [
    {
      digest: agentDigest,
      disposition: "included",
      id: `agent:${agentDigest}`,
      kind: "agent",
    },
    {
      digest: messagesDigest,
      disposition: "included",
      id: `messages:${messagesDigest}`,
      kind: "messages",
    },
    activePlan === null
      ? {
          digest: null,
          disposition: "excluded",
          id: "active-plan:none",
          kind: "active_plan",
        }
      : {
          digest: jsonDigest(activePlan),
          disposition: "included",
          id: `plan:${String(activePlan.id)}:r${String(activePlan.revision)}`,
          kind: "active_plan",
        },
    {
      digest: toolsDigest,
      disposition: "included",
      id: `tools:${toolsDigest}`,
      kind: "tools",
    },
    {
      digest: runtimeDigest,
      disposition: "included",
      id: `runtime:${runtimeDigest}`,
      kind: "runtime",
    },
  ] as const;
  const sources = array(manifest.sources, `${label}.contextManifest.sources`);
  if (sources.length !== expected.length) {
    throw new SchemaValidationError(
      `${label}.contextManifest.sources must account for every source`,
    );
  }
  expected.forEach((expectedSource, index) => {
    const source = object(
      sources[index],
      `${label}.contextManifest.sources[${index}]`,
    );
    if (
      source.kind !== expectedSource.kind ||
      source.id !== expectedSource.id ||
      source.digest !== expectedSource.digest ||
      source.disposition !== expectedSource.disposition
    ) {
      throw new SchemaValidationError(
        `${label}.contextManifest.sources[${index}] does not match input`,
      );
    }
  });
}

function assertThreadState(
  value: JsonValue | undefined,
  label: string,
  checkpointThreadId: string,
): void {
  const state = object(value, label);
  const threadId = string(state.threadId, `${label}.threadId`);
  if (threadId !== checkpointThreadId) {
    throw new SchemaValidationError(
      `${label}.threadId does not match the Checkpoint`,
    );
  }

  if (state.agent === null) {
    throw new SchemaValidationError(`${label}.agent must be present`);
  }
  assertAgentSnapshot(state.agent, `${label}.agent`);

  let projectedPlan: PlanSnapshot | null =
    state.activePlan === null
      ? null
      : parsePlanSnapshot(state.activePlan, `${label}.activePlan`);
  array(state.pendingPlanUpdates, `${label}.pendingPlanUpdates`).forEach(
    (value, index) => {
      const pending = object(value, `${label}.pendingPlanUpdates[${index}]`);
      const identitySeed = string(
        pending.identitySeed,
        `${label}.pendingPlanUpdates[${index}].identitySeed`,
      );
      const proposal = parsePlanUpdateProposal(
        pending.proposal,
        `${label}.pendingPlanUpdates[${index}].proposal`,
      );
      const parsed = materializePlanUpdates(
        projectedPlan,
        [proposal],
        identitySeed,
      )[0];
      if (parsed === undefined) {
        throw new SchemaValidationError(
          `${label}.pendingPlanUpdates[${index}] did not materialize`,
        );
      }
      projectedPlan = parsed.status === "active" ? parsed : null;
    },
  );
  array(
    state.pendingPlanRejections,
    `${label}.pendingPlanRejections`,
  ).forEach((rejection, index) =>
    assertPlanRejection(
      rejection,
      `${label}.pendingPlanRejections[${index}]`,
    ),
  );

  if (state.error !== null) {
    assertDriverError(state.error, `${label}.error`);
  }
  if (state.lineage !== null) {
    const lineage = object(state.lineage, `${label}.lineage`);
    string(lineage.parentThreadId, `${label}.lineage.parentThreadId`);
    string(lineage.parentEventId, `${label}.lineage.parentEventId`);
    const parentSequence = integer(
      lineage.parentSequence,
      `${label}.lineage.parentSequence`,
    );
    if (parentSequence < 1) {
      throw new SchemaValidationError(
        `${label}.lineage.parentSequence must be positive`,
      );
    }
  }

  array(state.inputQueue, `${label}.inputQueue`).forEach((value, index) => {
    const queued = object(value, `${label}.inputQueue[${index}]`);
    string(queued.content, `${label}.inputQueue[${index}].content`);
    string(queued.eventId, `${label}.inputQueue[${index}].eventId`);
  });

  array(state.messages, `${label}.messages`).forEach((message, index) =>
    assertModelMessage(message, `${label}.messages[${index}]`),
  );
  parseThreadMetrics(state.metrics, `${label}.metrics`);
  if (state.planRepairAttempts !== undefined) {
    const attempts = integer(
      state.planRepairAttempts,
      `${label}.planRepairAttempts`,
    );
    if (attempts < 0) {
      throw new SchemaValidationError(
        `${label}.planRepairAttempts must not be negative`,
      );
    }
  }
  const pauseRequested = boolean(
    state.pauseRequested,
    `${label}.pauseRequested`,
  );

  const effectIds = new Set<string>();
  const pending = object(state.pendingEffects, `${label}.pendingEffects`);
  for (const [key, effectValue] of Object.entries(pending)) {
    const effect = parseEffect(effectValue, `${label}.pendingEffects.${key}`, threadId);
    if (effect.id !== key) {
      throw new SchemaValidationError(
        `${label}.pendingEffects.${key} has a mismatched Effect ID`,
      );
    }
    effectIds.add(effect.id);
  }
  array(state.readyEffects, `${label}.readyEffects`).forEach(
    (effectValue, index) => {
      const effect = parseEffect(
        effectValue,
        `${label}.readyEffects[${index}]`,
        threadId,
      );
      if (effectIds.has(effect.id)) {
        throw new SchemaValidationError(
          `${label} contains duplicate Effect ID ${effect.id}`,
        );
      }
      effectIds.add(effect.id);
    },
  );

  const approvals = object(state.toolApprovals, `${label}.toolApprovals`);
  let unresolvedApprovalCount = 0;
  for (const [key, approvalValue] of Object.entries(approvals)) {
    const approval = object(
      approvalValue,
      `${label}.toolApprovals.${key}`,
    );
    const effectId = string(
      approval.effectId,
      `${label}.toolApprovals.${key}.effectId`,
    );
    if (effectId !== key) {
      throw new SchemaValidationError(
        `${label}.toolApprovals.${key} has a mismatched Effect ID`,
      );
    }
    const pendingEffect = pending[effectId];
    if (pendingEffect === undefined) {
      throw new SchemaValidationError(
        `${label}.toolApprovals.${key} must reference a pending Effect`,
      );
    }
    string(approval.action, `${label}.toolApprovals.${key}.action`);
    string(approval.name, `${label}.toolApprovals.${key}.name`);
    string(approval.toolCallId, `${label}.toolApprovals.${key}.toolCallId`);
    if (approval.decisionEventId !== null) {
      string(
        approval.decisionEventId,
        `${label}.toolApprovals.${key}.decisionEventId`,
      );
    }
    const resources = array(
      approval.resources,
      `${label}.toolApprovals.${key}.resources`,
    );
    if (resources.length === 0) {
      throw new SchemaValidationError(
        `${label}.toolApprovals.${key}.resources must not be empty`,
      );
    }
    resources.forEach((resource, index) =>
      string(resource, `${label}.toolApprovals.${key}.resources[${index}]`),
    );
    if (approval.decision === null) {
      if (approval.decisionEventId !== null) {
        throw new SchemaValidationError(
          `${label}.toolApprovals.${key}.decisionEventId requires a decision`,
        );
      }
      unresolvedApprovalCount += 1;
    } else if (
      approval.decision !== "allow_once" &&
      approval.decision !== "deny"
    ) {
      throw new SchemaValidationError(
        `${label}.toolApprovals.${key}.decision is unsupported`,
      );
    } else if (approval.decisionEventId === null) {
      throw new SchemaValidationError(
        `${label}.toolApprovals.${key}.decision requires decisionEventId`,
      );
    }
  }

  if (state.result !== null) {
    string(state.result, `${label}.result`);
  }
  const revision = integer(state.revision, `${label}.revision`);
  if (revision < 1) {
    throw new SchemaValidationError(`${label}.revision must be positive`);
  }
  const status = string(state.status, `${label}.status`);
  if (
    status !== "idle" &&
    status !== "paused" &&
    status !== "running" &&
    status !== "waiting"
  ) {
    throw new SchemaValidationError(`${label}.status is unsupported`);
  }
  if (pauseRequested && status !== "running") {
    throw new SchemaValidationError(
      `${label}.pauseRequested requires running status`,
    );
  }
  if (unresolvedApprovalCount > 0 && status !== "waiting") {
    throw new SchemaValidationError(
      `${label}.toolApprovals requires waiting status while unresolved`,
    );
  }

  if (state.waitingReason === null) {
    if (status === "waiting") {
      throw new SchemaValidationError(
        `${label}.waitingReason is required while waiting`,
      );
    }
    return;
  }
  const waiting = object(state.waitingReason, `${label}.waitingReason`);
  const waitingEffectId = string(
    waiting.effectId,
    `${label}.waitingReason.effectId`,
  );
  if (
    waiting.reasonCode !== "effect_outcome_unknown" &&
    waiting.reasonCode !== "tool_approval_required"
  ) {
    throw new SchemaValidationError(
      `${label}.waitingReason.reasonCode is unsupported`,
    );
  }
  if (
    status !== "waiting" ||
    pending[waitingEffectId] === undefined ||
    (waiting.reasonCode === "tool_approval_required" &&
      object(
        approvals[waitingEffectId],
        `${label}.toolApprovals.${waitingEffectId}`,
      ).decision !== null)
  ) {
    throw new SchemaValidationError(
      `${label}.waitingReason must reference a pending Effect while waiting`,
    );
  }
}

function parseEffect(
  value: JsonValue | undefined,
  label: string,
  threadId: string,
): EffectRequest {
  const item = object(value, label);
  const type = string(item.type, `${label}.type`);
  string(item.id, `${label}.id`);
  string(item.idempotencyKey, `${label}.idempotencyKey`);
  string(item.requestedByEventId, `${label}.requestedByEventId`);
  if (string(item.threadId, `${label}.threadId`) !== threadId) {
    throw new SchemaValidationError(`${label}.threadId does not match the Event`);
  }
  const attempt = integer(item.attempt, `${label}.attempt`);
  if (attempt < 1) {
    throw new SchemaValidationError(`${label}.attempt must be positive`);
  }
  const input = object(item.input, `${label}.input`);

  if (type === "model.generate") {
    if (input.activePlan !== null) {
      parsePlanSnapshot(input.activePlan, `${label}.input.activePlan`);
    }
    string(input.instructions, `${label}.input.instructions`);
    if (input.planRejectionFeedback !== undefined) {
      const feedback = string(
        input.planRejectionFeedback,
        `${label}.input.planRejectionFeedback`,
      );
      if (feedback.trim().length === 0 || feedback.length > 500) {
        throw new SchemaValidationError(
          `${label}.input.planRejectionFeedback must contain 1-500 characters`,
        );
      }
    }
    const hasRuntimeContext = input.runtimeContext !== undefined;
    const hasContextManifest = input.contextManifest !== undefined;
    if (hasRuntimeContext !== hasContextManifest) {
      throw new SchemaValidationError(
        `${label}.input runtimeContext and contextManifest must appear together`,
      );
    }
    if (hasRuntimeContext) {
      assertModelRuntimeContext(
        input.runtimeContext,
        `${label}.input.runtimeContext`,
      );
      assertContextManifest(
        input.contextManifest,
        `${label}.input.contextManifest`,
      );
    }
    const model = object(input.model, `${label}.input.model`);
    string(model.model, `${label}.input.model.model`);
    string(model.provider, `${label}.input.model.provider`);
    array(input.messages, `${label}.input.messages`).forEach((message, index) =>
      assertModelMessage(message, `${label}.input.messages[${index}]`),
    );
    const planControl = object(input.planControl, `${label}.input.planControl`);
    if (
      string(planControl.name, `${label}.input.planControl.name`) !==
      PLAN_CONTROL_NAME
    ) {
      throw new SchemaValidationError(
        `${label}.input.planControl.name is unsupported`,
      );
    }
    string(planControl.description, `${label}.input.planControl.description`);
    object(planControl.inputSchema, `${label}.input.planControl.inputSchema`);
    const progressControl = object(
      input.progressControl,
      `${label}.input.progressControl`,
    );
    if (
      string(progressControl.name, `${label}.input.progressControl.name`) !==
      PROGRESS_CONTROL_NAME
    ) {
      throw new SchemaValidationError(
        `${label}.input.progressControl.name is unsupported`,
      );
    }
    string(
      progressControl.description,
      `${label}.input.progressControl.description`,
    );
    object(
      progressControl.inputSchema,
      `${label}.input.progressControl.inputSchema`,
    );
    array(input.tools, `${label}.input.tools`).forEach((tool, index) =>
      assertToolDescriptor(tool, `${label}.input.tools[${index}]`),
    );
    if (hasRuntimeContext) {
      const manifest = object(
        input.contextManifest,
        `${label}.input.contextManifest`,
      );
      const expectedDigest = jsonDigest({
        activePlan: input.activePlan,
        instructions: input.instructions,
        messages: input.messages,
        model: input.model,
        planControl: input.planControl,
        planRejectionFeedback: input.planRejectionFeedback ?? null,
        progressControl: input.progressControl,
        runtime: input.runtimeContext,
        tools: input.tools,
      });
      if (manifest.logicalRequestDigest !== expectedDigest) {
        throw new SchemaValidationError(
          `${label}.input.contextManifest.logicalRequestDigest does not match input`,
        );
      }
      assertContextManifestMatchesInput(input, `${label}.input`);
    }
    return cloneJson(item) as unknown as EffectRequest;
  }

  if (type === "tool.execute") {
    object(input.arguments, `${label}.input.arguments`);
    string(input.name, `${label}.input.name`);
    string(input.toolCallId, `${label}.input.toolCallId`);
    const idempotency = string(
      input.idempotency,
      `${label}.input.idempotency`,
    );
    if (
      idempotency !== "idempotent" &&
      idempotency !== "non-idempotent" &&
      idempotency !== "none"
    ) {
      throw new SchemaValidationError(
        `${label}.input.idempotency is unsupported`,
      );
    }
    return cloneJson(item) as unknown as EffectRequest;
  }

  throw new SchemaValidationError(`${label}.type is unsupported`);
}

function assertEmptyPayload(payload: JsonObject, label: string): void {
  if (Object.keys(payload).length !== 0) {
    throw new SchemaValidationError(`${label} must be empty`);
  }
}

const eventTypes = new Set<ThreadEventType>([
  "approval.decided",
  "approval.requested",
  "context.cleared",
  "input.received",
  "model.completed",
  "model.failed",
  "model.requested",
  "plan.rejected",
  "plan.updated",
  "thread.created",
  "thread.forked",
  "thread.pause_requested",
  "thread.paused",
  "thread.continued",
  "thread.waiting",
  "tool.completed",
  "tool.failed",
  "tool.requested",
]);

function assertEventPayload(type: ThreadEventType, payload: JsonObject, threadId: string): void {
  switch (type) {
    case "approval.decided":
      string(payload.effectId, "payload.effectId");
      if (payload.decision !== "allow_once" && payload.decision !== "deny") {
        throw new SchemaValidationError("payload.decision is unsupported");
      }
      return;
    case "approval.requested": {
      string(payload.action, "payload.action");
      string(payload.effectId, "payload.effectId");
      string(payload.name, "payload.name");
      string(payload.toolCallId, "payload.toolCallId");
      const resources = array(payload.resources, "payload.resources");
      if (resources.length === 0) {
        throw new SchemaValidationError("payload.resources must not be empty");
      }
      resources.forEach((resource, index) =>
        string(resource, `payload.resources[${index}]`),
      );
      return;
    }
    case "thread.created":
      assertAgentSnapshot(payload.agent, "payload.agent");
      return;
    case "thread.forked":
      string(payload.parentThreadId, "payload.parentThreadId");
      string(payload.parentEventId, "payload.parentEventId");
      integer(payload.parentSequence, "payload.parentSequence");
      return;
    case "thread.pause_requested":
    case "thread.paused":
    case "thread.continued":
    case "context.cleared":
      assertEmptyPayload(payload, "payload");
      return;
    case "thread.waiting":
      string(payload.effectId, "payload.effectId");
      if (payload.reasonCode !== "effect_outcome_unknown") {
        throw new SchemaValidationError("payload.reasonCode is unsupported");
      }
      return;
    case "input.received":
      string(payload.content, "payload.content");
      return;
    case "model.requested":
    case "tool.requested": {
      const effect = parseEffect(payload.effect, "payload.effect", threadId);
      if (
        (type === "model.requested" && effect.type !== "model.generate") ||
        (type === "tool.requested" && effect.type !== "tool.execute")
      ) {
        throw new SchemaValidationError(`${type} contains the wrong Effect type`);
      }
      return;
    }
    case "model.completed":
      parseModelAccounting(payload.accounting, "payload.accounting");
      string(payload.effectId, "payload.effectId");
      if (payload.planRejections !== undefined) {
        array(payload.planRejections, "payload.planRejections").forEach(
          (rejection, index) =>
            assertPlanRejection(
              rejection,
              `payload.planRejections[${index}]`,
            ),
        );
      }
      parseModelResponse(payload.response);
      return;
    case "plan.updated":
      parsePlanSnapshot(payload.plan, "payload.plan");
      return;
    case "plan.rejected":
      assertPlanRejection(payload, "payload");
      return;
    case "model.failed":
      parseModelAccounting(payload.accounting, "payload.accounting");
      string(payload.effectId, "payload.effectId");
      assertDriverError(payload.error, "payload.error");
      if (payload.disposition !== "failed" && payload.disposition !== "indeterminate") {
        throw new SchemaValidationError("payload.disposition is unsupported");
      }
      return;
    case "tool.completed":
      string(payload.effectId, "payload.effectId");
      string(payload.name, "payload.name");
      string(payload.toolCallId, "payload.toolCallId");
      if (payload.output === undefined) {
        throw new SchemaValidationError("payload.output is required");
      }
      return;
    case "tool.failed":
      string(payload.effectId, "payload.effectId");
      string(payload.name, "payload.name");
      string(payload.toolCallId, "payload.toolCallId");
      assertDriverError(payload.error, "payload.error");
      if (payload.disposition !== "failed" && payload.disposition !== "indeterminate") {
        throw new SchemaValidationError("payload.disposition is unsupported");
      }
      return;
  }
}

export function decodeThreadEvent(value: unknown): AnyThreadEvent {
  const event = object(value, "Event");
  const schemaVersion = integer(event.schemaVersion, "Event.schemaVersion");
  if (!isSupportedEventSchemaVersion(schemaVersion)) {
    throw new UnsupportedEventError(
      `Event uses unsupported schema version ${schemaVersion}`,
    );
  }
  const typeValue = string(event.type, "Event.type");
  if (!eventTypes.has(typeValue as ThreadEventType)) {
    throw new UnsupportedEventError(`Unknown Event type ${typeValue}`);
  }
  const type = typeValue as ThreadEventType;
  const threadId = string(event.threadId, "Event.threadId");
  string(event.id, "Event.id");
  const sequence = integer(event.sequence, "Event.sequence");
  if (sequence < 1) {
    throw new SchemaValidationError("Event.sequence must be positive");
  }
  string(event.timestamp, "Event.timestamp");
  optionalString(event.causationId, "Event.causationId");
  optionalString(event.correlationId, "Event.correlationId");
  const payload = object(event.payload, "Event.payload");
  assertEventPayload(type, payload, threadId);
  return cloneJson(event) as unknown as AnyThreadEvent;
}

export function decodeCheckpoint(value: unknown): Checkpoint {
  const checkpoint = object(value, "Checkpoint");
  const threadId = string(checkpoint.threadId, "Checkpoint.threadId");
  string(checkpoint.eventId, "Checkpoint.eventId");
  const sequence = integer(checkpoint.sequence, "Checkpoint.sequence");
  if (sequence < 1) {
    throw new SchemaValidationError("Checkpoint.sequence must be positive");
  }
  integer(checkpoint.eventSchemaVersion, "Checkpoint.eventSchemaVersion");
  integer(checkpoint.reducerVersion, "Checkpoint.reducerVersion");
  assertThreadState(checkpoint.state, "Checkpoint.state", threadId);
  string(checkpoint.stateDigest, "Checkpoint.stateDigest");
  return cloneJson(checkpoint) as unknown as Checkpoint;
}
