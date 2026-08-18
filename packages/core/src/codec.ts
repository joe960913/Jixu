import type { Checkpoint } from "./domain.ts";
import { parseModelResponse } from "./domain.ts";
import type { EffectRequest } from "./effects.ts";
import { SchemaValidationError, UnsupportedEventError } from "./errors.ts";
import { isSupportedEventSchemaVersion } from "./events.ts";
import type { AnyThreadEvent, ThreadEventType } from "./events.ts";
import { cloneJson, isJsonObject } from "./json.ts";
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
  if (waiting.reasonCode !== "effect_outcome_unknown") {
    throw new SchemaValidationError(
      `${label}.waitingReason.reasonCode is unsupported`,
    );
  }
  if (status !== "waiting" || pending[waitingEffectId] === undefined) {
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
      parseModelResponse(payload.response);
      return;
    case "plan.updated":
      parsePlanSnapshot(payload.plan, "payload.plan");
      return;
    case "plan.rejected":
      string(payload.effectId, "payload.effectId");
      assertDriverError(payload.error, "payload.error");
      array(payload.proposals, "payload.proposals").forEach((proposal, index) =>
        parsePlanUpdateProposal(proposal, `payload.proposals[${index}]`),
      );
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
