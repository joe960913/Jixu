import type { Checkpoint } from "./domain.ts";
import { parseModelResponse } from "./domain.ts";
import type { EffectRequest } from "./effects.ts";
import { SchemaValidationError, UnsupportedEventError } from "./errors.ts";
import type { AnyRunEvent, RunEventType } from "./events.ts";
import { cloneJson, isJsonObject } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";

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

function assertRunState(
  value: JsonValue | undefined,
  label: string,
  checkpointRunId: string,
): void {
  const state = object(value, label);
  const runId = string(state.runId, `${label}.runId`);
  if (runId !== checkpointRunId) {
    throw new SchemaValidationError(
      `${label}.runId does not match the Checkpoint`,
    );
  }

  if (state.agent === null) {
    throw new SchemaValidationError(`${label}.agent must be present`);
  }
  assertAgentSnapshot(state.agent, `${label}.agent`);

  if (state.error !== null) {
    assertDriverError(state.error, `${label}.error`);
  }
  if (state.lineage !== null) {
    const lineage = object(state.lineage, `${label}.lineage`);
    string(lineage.parentRunId, `${label}.lineage.parentRunId`);
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

  array(state.messages, `${label}.messages`).forEach((message, index) =>
    assertModelMessage(message, `${label}.messages[${index}]`),
  );
  const pauseRequested = boolean(
    state.pauseRequested,
    `${label}.pauseRequested`,
  );

  const effectIds = new Set<string>();
  const pending = object(state.pendingEffects, `${label}.pendingEffects`);
  for (const [key, effectValue] of Object.entries(pending)) {
    const effect = parseEffect(effectValue, `${label}.pendingEffects.${key}`, runId);
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
        runId,
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
    status !== "cancelled" &&
    status !== "completed" &&
    status !== "created" &&
    status !== "failed" &&
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
  runId: string,
): EffectRequest {
  const item = object(value, label);
  const type = string(item.type, `${label}.type`);
  string(item.id, `${label}.id`);
  string(item.idempotencyKey, `${label}.idempotencyKey`);
  string(item.requestedByEventId, `${label}.requestedByEventId`);
  if (string(item.runId, `${label}.runId`) !== runId) {
    throw new SchemaValidationError(`${label}.runId does not match the Event`);
  }
  const attempt = integer(item.attempt, `${label}.attempt`);
  if (attempt < 1) {
    throw new SchemaValidationError(`${label}.attempt must be positive`);
  }
  const input = object(item.input, `${label}.input`);

  if (type === "model.generate") {
    string(input.instructions, `${label}.input.instructions`);
    const model = object(input.model, `${label}.input.model`);
    string(model.model, `${label}.input.model.model`);
    string(model.provider, `${label}.input.model.provider`);
    array(input.messages, `${label}.input.messages`).forEach((message, index) =>
      assertModelMessage(message, `${label}.input.messages[${index}]`),
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

const eventTypes = new Set<RunEventType>([
  "input.received",
  "model.completed",
  "model.failed",
  "model.requested",
  "run.created",
  "run.forked",
  "run.pause_requested",
  "run.paused",
  "run.resumed",
  "run.waiting",
  "tool.completed",
  "tool.failed",
  "tool.requested",
]);

function assertEventPayload(type: RunEventType, payload: JsonObject, runId: string): void {
  switch (type) {
    case "run.created":
      assertAgentSnapshot(payload.agent, "payload.agent");
      return;
    case "run.forked":
      string(payload.parentRunId, "payload.parentRunId");
      string(payload.parentEventId, "payload.parentEventId");
      integer(payload.parentSequence, "payload.parentSequence");
      return;
    case "run.pause_requested":
    case "run.paused":
    case "run.resumed":
      assertEmptyPayload(payload, "payload");
      return;
    case "run.waiting":
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
      const effect = parseEffect(payload.effect, "payload.effect", runId);
      if (
        (type === "model.requested" && effect.type !== "model.generate") ||
        (type === "tool.requested" && effect.type !== "tool.execute")
      ) {
        throw new SchemaValidationError(`${type} contains the wrong Effect type`);
      }
      return;
    }
    case "model.completed":
      string(payload.effectId, "payload.effectId");
      parseModelResponse(payload.response);
      return;
    case "model.failed":
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

export function decodeRunEvent(value: unknown): AnyRunEvent {
  const event = object(value, "Event");
  const schemaVersion = integer(event.schemaVersion, "Event.schemaVersion");
  if (schemaVersion !== 1) {
    throw new UnsupportedEventError(
      `Event uses unsupported schema version ${schemaVersion}`,
    );
  }
  const typeValue = string(event.type, "Event.type");
  if (!eventTypes.has(typeValue as RunEventType)) {
    throw new UnsupportedEventError(`Unknown Event type ${typeValue}`);
  }
  const type = typeValue as RunEventType;
  const runId = string(event.runId, "Event.runId");
  string(event.id, "Event.id");
  const sequence = integer(event.sequence, "Event.sequence");
  if (sequence < 1) {
    throw new SchemaValidationError("Event.sequence must be positive");
  }
  string(event.timestamp, "Event.timestamp");
  optionalString(event.causationId, "Event.causationId");
  optionalString(event.correlationId, "Event.correlationId");
  const payload = object(event.payload, "Event.payload");
  assertEventPayload(type, payload, runId);
  return cloneJson(event) as unknown as AnyRunEvent;
}

export function decodeCheckpoint(value: unknown): Checkpoint {
  const checkpoint = object(value, "Checkpoint");
  const runId = string(checkpoint.runId, "Checkpoint.runId");
  string(checkpoint.eventId, "Checkpoint.eventId");
  const sequence = integer(checkpoint.sequence, "Checkpoint.sequence");
  if (sequence < 1) {
    throw new SchemaValidationError("Checkpoint.sequence must be positive");
  }
  integer(checkpoint.eventSchemaVersion, "Checkpoint.eventSchemaVersion");
  integer(checkpoint.reducerVersion, "Checkpoint.reducerVersion");
  assertRunState(checkpoint.state, "Checkpoint.state", runId);
  string(checkpoint.stateDigest, "Checkpoint.stateDigest");
  return cloneJson(checkpoint) as unknown as Checkpoint;
}
