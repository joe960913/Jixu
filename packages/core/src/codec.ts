import type { Checkpoint } from "./domain.ts";
import { parseModelResponse } from "./domain.ts";
import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_ESTIMATOR_VERSION,
  CONTEXT_MANIFEST_SCHEMA_VERSION,
  MAX_PLAN_REPAIR_ATTEMPTS,
  MODEL_CONTEXT_SCHEMA_VERSION,
  estimateContextTokens,
  parseContinuityHandoffBody,
} from "./context.ts";
import { defineContextPolicy } from "./context-policy.ts";
import {
  defineModelCapabilityProfile,
  modelCapabilityProfileFor,
} from "./model-capabilities.ts";
import type { ModelCapabilityProfile } from "./model-capabilities.ts";
import type { EffectRequest } from "./effects.ts";
import { SchemaValidationError, UnsupportedEventError } from "./errors.ts";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  isSupportedEventSchemaVersion,
} from "./events.ts";
import type { AnyThreadEvent, ThreadEventType } from "./events.ts";
import {
  cloneJson,
  isJsonObject,
  jsonDigest,
  jsonEquals,
} from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import {
  CONTINUITY_HANDOFF_MEDIA_TYPE,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGE_PLACEHOLDER_LENGTH,
  MAX_INPUT_IMAGES,
  MAX_INPUT_TOTAL_IMAGE_BYTES,
} from "./input.ts";
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

function assertThreadMode(value: JsonValue | undefined, label: string): void {
  if (value !== "standard" && value !== "ultra") {
    throw new SchemaValidationError(`${label} is unsupported`);
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

function modelCapabilityProfile(
  value: JsonValue | undefined,
  label: string,
): ModelCapabilityProfile {
  const item = object(value, label);
  const source = object(item.source, `${label}.source`);
  try {
    const parsed = defineModelCapabilityProfile({
      contextWindowTokens: integer(
        item.contextWindowTokens,
        `${label}.contextWindowTokens`,
      ),
      maxOutputTokens: integer(
        item.maxOutputTokens,
        `${label}.maxOutputTokens`,
      ),
      resolvedModel: string(item.resolvedModel, `${label}.resolvedModel`),
      source: {
        kind: string(source.kind, `${label}.source.kind`) as never,
        name: string(source.name, `${label}.source.name`),
      },
    });
    if (item.schemaVersion !== parsed.schemaVersion) {
      throw new TypeError("schemaVersion is unsupported");
    }
    return parsed;
  } catch (error) {
    throw new SchemaValidationError(
      `${label} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
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
  const capabilities =
    item.modelCapabilities === undefined
      ? undefined
      : modelCapabilityProfile(
          item.modelCapabilities,
          `${label}.modelCapabilities`,
        );
  if (item.contextPolicy !== undefined) {
    const policy = object(item.contextPolicy, `${label}.contextPolicy`);
    try {
      const parsed = defineContextPolicy({
        contextWindowTokens: integer(
          policy.contextWindowTokens,
          `${label}.contextPolicy.contextWindowTokens`,
        ),
        rawTailTokens: integer(
          policy.rawTailTokens,
          `${label}.contextPolicy.rawTailTokens`,
        ),
        reservedOutputTokens: integer(
          policy.reservedOutputTokens,
          `${label}.contextPolicy.reservedOutputTokens`,
        ),
        safetyMarginTokens: integer(
          policy.safetyMarginTokens,
          `${label}.contextPolicy.safetyMarginTokens`,
        ),
      }, capabilities);
      if (policy.schemaVersion !== parsed.schemaVersion) {
        throw new TypeError("Context Policy schemaVersion is unsupported");
      }
    } catch (error) {
      throw new SchemaValidationError(
        `${label}.contextPolicy is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
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
    const content = string(item.content, `${label}.content`);
    if (item.parts !== undefined) {
      assertStoredInputParts(item.parts, content, `${label}.parts`);
    }
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

function assertStoredInputParts(
  value: JsonValue | undefined,
  content: string,
  label: string,
): void {
  const parts = array(value, label);
  const display: string[] = [];
  const placeholders = new Set<string>();
  let imageCount = 0;
  let totalImageBytes = 0;
  parts.forEach((value, index) => {
    const partLabel = `${label}[${index}]`;
    const part = object(value, partLabel);
    if (part.type === "text") {
      display.push(string(part.text, `${partLabel}.text`));
      return;
    }
    if (part.type !== "image") {
      throw new SchemaValidationError(`${partLabel}.type is unsupported`);
    }
    imageCount += 1;
    if (imageCount > MAX_INPUT_IMAGES) {
      throw new SchemaValidationError(
        `${label} exceeds the image-count limit`,
      );
    }
    const placeholder = string(
      part.placeholder,
      `${partLabel}.placeholder`,
    );
    if (
      placeholder.length < 1 ||
      placeholder.length > MAX_INPUT_IMAGE_PLACEHOLDER_LENGTH ||
      !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(placeholder) ||
      placeholders.has(placeholder)
    ) {
      throw new SchemaValidationError(
        `${partLabel}.placeholder is invalid or duplicated`,
      );
    }
    placeholders.add(placeholder);
    const artifact = object(part.artifact, `${partLabel}.artifact`);
    const digest = string(artifact.digest, `${partLabel}.artifact.digest`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
      throw new SchemaValidationError(
        `${partLabel}.artifact.digest is not SHA-256`,
      );
    }
    const byteLength = integer(
      artifact.byteLength,
      `${partLabel}.artifact.byteLength`,
    );
    if (byteLength < 1 || byteLength > MAX_INPUT_IMAGE_BYTES) {
      throw new SchemaValidationError(
        `${partLabel}.artifact.byteLength is outside the image limit`,
      );
    }
    totalImageBytes += byteLength;
    if (totalImageBytes > MAX_INPUT_TOTAL_IMAGE_BYTES) {
      throw new SchemaValidationError(
        `${label} exceeds the total image-byte limit`,
      );
    }
    if (
      artifact.mediaType !== "image/png" &&
      artifact.mediaType !== "image/jpeg" &&
      artifact.mediaType !== "image/gif" &&
      artifact.mediaType !== "image/webp"
    ) {
      throw new SchemaValidationError(
        `${partLabel}.artifact.mediaType is unsupported`,
      );
    }
    display.push(`[${placeholder}]`);
  });
  if (display.join("") !== content) {
    throw new SchemaValidationError(
      `${label} does not reproduce the accepted input content`,
    );
  }
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

function assertContextBoundary(
  value: JsonValue | undefined,
  label: string,
): void {
  const boundary = object(value, label);
  string(boundary.eventId, `${label}.eventId`);
  if (integer(boundary.sequence, `${label}.sequence`) < 1) {
    throw new SchemaValidationError(`${label}.sequence must be positive`);
  }
}

function assertContextManifestSourceV2(
  value: JsonValue | undefined,
  label: string,
): void {
  const source = object(value, label);
  string(source.id, `${label}.id`);
  const kind = string(source.kind, `${label}.kind`);
  if (
    kind !== "active_plan" &&
    kind !== "agent" &&
    kind !== "artifact" &&
    kind !== "handoff" &&
    kind !== "message" &&
    kind !== "messages" &&
    kind !== "runtime" &&
    kind !== "tools"
  ) {
    throw new SchemaValidationError(`${label}.kind is unsupported`);
  }
  string(source.reason, `${label}.reason`);
  string(source.version, `${label}.version`);
  if (source.causedByEventId !== null) {
    string(source.causedByEventId, `${label}.causedByEventId`);
  }
  if (source.digest !== null) string(source.digest, `${label}.digest`);
  if (source.digest === undefined) {
    throw new SchemaValidationError(`${label}.digest is required`);
  }
  if (
    source.disposition !== "included" &&
    source.disposition !== "excluded" &&
    source.disposition !== "transformed"
  ) {
    throw new SchemaValidationError(`${label}.disposition is unsupported`);
  }
  const estimatedTokens = integer(
    source.estimatedTokens,
    `${label}.estimatedTokens`,
  );
  const priority = integer(source.priority, `${label}.priority`);
  if (estimatedTokens < 0 || priority < 0 || priority > 100) {
    throw new SchemaValidationError(`${label} cost or priority is invalid`);
  }
  if (source.sensitivity !== "internal" && source.sensitivity !== "private") {
    throw new SchemaValidationError(`${label}.sensitivity is unsupported`);
  }
  if (source.trust !== "accepted") {
    throw new SchemaValidationError(`${label}.trust is unsupported`);
  }
}

function contextPolicyFromManifest(
  manifest: JsonObject,
  label: string,
  allowLegacyModelCapabilities = false,
): ReturnType<typeof defineContextPolicy> {
  if (manifest.contextPolicySchemaVersion !== 1) {
    throw new SchemaValidationError(
      `${label}.contextPolicySchemaVersion is unsupported`,
    );
  }
  const inputBudgetTokens = integer(
    manifest.inputBudgetTokens,
    `${label}.inputBudgetTokens`,
  );
  const capabilities =
    manifest.modelCapabilities === undefined && allowLegacyModelCapabilities
      ? modelCapabilityProfileFor(undefined)
      : modelCapabilityProfile(
          manifest.modelCapabilities,
          `${label}.modelCapabilities`,
        );
  try {
    return defineContextPolicy({
      contextWindowTokens:
        inputBudgetTokens +
        integer(manifest.outputBudgetTokens, `${label}.outputBudgetTokens`) +
        integer(manifest.safetyMarginTokens, `${label}.safetyMarginTokens`),
      rawTailTokens: integer(
        manifest.rawTailBudgetTokens,
        `${label}.rawTailBudgetTokens`,
      ),
      reservedOutputTokens: manifest.outputBudgetTokens as number,
      safetyMarginTokens: manifest.safetyMarginTokens as number,
    }, capabilities);
  } catch (error) {
    throw new SchemaValidationError(
      `${label} Context Policy is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function assertContextManifest(
  value: JsonValue | undefined,
  label: string,
  allowLegacyModelCapabilities = false,
): void {
  const manifest = object(value, label);
  if (manifest.schemaVersion === CONTEXT_MANIFEST_SCHEMA_VERSION) {
    if (manifest.compilerVersion !== CONTEXT_COMPILER_VERSION) {
      throw new SchemaValidationError(`${label}.compilerVersion is unsupported`);
    }
    if (manifest.estimatorVersion !== CONTEXT_ESTIMATOR_VERSION) {
      throw new SchemaValidationError(`${label}.estimatorVersion is unsupported`);
    }
    string(manifest.logicalRequestDigest, `${label}.logicalRequestDigest`);
    contextPolicyFromManifest(
      manifest,
      label,
      allowLegacyModelCapabilities,
    );
    for (const field of [
      "estimatedInputTokens",
      "inputBudgetTokens",
      "outputBudgetTokens",
      "safetyMarginTokens",
    ] as const) {
      if (integer(manifest[field], `${label}.${field}`) < 0) {
        throw new SchemaValidationError(`${label}.${field} must not be negative`);
      }
    }
    if (
      (manifest.estimatedInputTokens as number) >
      (manifest.inputBudgetTokens as number)
    ) {
      throw new SchemaValidationError(`${label} records an over-budget model request`);
    }
    if (manifest.activeClearBoundary !== null) {
      assertContextBoundary(
        manifest.activeClearBoundary,
        `${label}.activeClearBoundary`,
      );
    }
    if (manifest.rawTailBoundary !== null) {
      assertContextBoundary(manifest.rawTailBoundary, `${label}.rawTailBoundary`);
    }
    if (manifest.acceptedHandoffDigest !== null) {
      const digest = string(
        manifest.acceptedHandoffDigest,
        `${label}.acceptedHandoffDigest`,
      );
      if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
        throw new SchemaValidationError(
          `${label}.acceptedHandoffDigest is not SHA-256`,
        );
      }
    }
    if (manifest.activePlanRevision !== null) {
      if (
        integer(manifest.activePlanRevision, `${label}.activePlanRevision`) < 1
      ) {
        throw new SchemaValidationError(
          `${label}.activePlanRevision must be positive`,
        );
      }
    }
    array(manifest.sources, `${label}.sources`).forEach((source, index) =>
      assertContextManifestSourceV2(source, `${label}.sources[${index}]`),
    );
    return;
  }
  if (manifest.schemaVersion !== MODEL_CONTEXT_SCHEMA_VERSION) {
    throw new SchemaValidationError(`${label}.schemaVersion is unsupported`);
  }
  if (manifest.compilerVersion !== 1) {
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
  allowLegacyModelCapabilities = false,
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
  if (manifest.schemaVersion === CONTEXT_MANIFEST_SCHEMA_VERSION) {
    const sources = array(
      manifest.sources,
      `${label}.contextManifest.sources`,
    ).map((value, index) =>
      object(value, `${label}.contextManifest.sources[${index}]`),
    );
    const sourceIds = sources.map((source) => source.id);
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new SchemaValidationError(
        `${label}.contextManifest source identities must be unique`,
      );
    }
    const oneSource = (kind: string): JsonObject => {
      const matches = sources.filter((source) => source.kind === kind);
      if (matches.length !== 1 || matches[0] === undefined) {
        throw new SchemaValidationError(
          `${label}.contextManifest must contain exactly one ${kind} source`,
        );
      }
      return matches[0];
    };
    const runtimeDigest = jsonDigest(input.runtimeContext);
    const contextPolicy = contextPolicyFromManifest(
      manifest,
      `${label}.contextManifest`,
      allowLegacyModelCapabilities,
    );
    const hasModelCapabilities = manifest.modelCapabilities !== undefined;
    const capabilities =
      !hasModelCapabilities && allowLegacyModelCapabilities
        ? modelCapabilityProfileFor(undefined)
        : modelCapabilityProfile(
            manifest.modelCapabilities,
            `${label}.contextManifest.modelCapabilities`,
          );
    const runtimeSource = oneSource("runtime");
    if (
      runtimeSource?.digest !== runtimeDigest ||
      runtimeSource.id !== `runtime:${runtimeDigest}` ||
      runtimeSource.disposition !== "included"
    ) {
      throw new SchemaValidationError(
        `${label}.contextManifest runtime source does not match input`,
      );
    }
    const agentDigest = jsonDigest({
      contextPolicy,
      instructions: input.instructions,
      model: input.model,
      ...(hasModelCapabilities ? { modelCapabilities: capabilities } : {}),
      tools: input.tools,
    });
    const agentSource = oneSource("agent");
    if (
      agentSource?.digest !== agentDigest ||
      agentSource.id !== `agent:${agentDigest}` ||
      agentSource.disposition !== "included"
    ) {
      throw new SchemaValidationError(
        `${label}.contextManifest Agent source does not match input`,
      );
    }
    const toolsDigest = jsonDigest(input.tools);
    const toolsSource = oneSource("tools");
    if (
      toolsSource?.digest !== toolsDigest ||
      toolsSource.disposition !== "included"
    ) {
      throw new SchemaValidationError(
        `${label}.contextManifest Tool source does not match input`,
      );
    }
    const includedMessages = sources.filter(
      (source) =>
        source.kind === "message" && source.disposition === "included",
    );
    const messages = array(input.messages, `${label}.messages`);
    if (
      includedMessages.length !== messages.length ||
      messages.some(
        (message, index) =>
          includedMessages[index]?.digest !== jsonDigest(message),
      )
    ) {
      throw new SchemaValidationError(
        `${label}.contextManifest raw message sources do not match input`,
      );
    }
    if (sources.some((source) => source.kind === "messages")) {
      throw new SchemaValidationError(
        `${label}.contextManifest v2 cannot contain aggregate message sources`,
      );
    }
    const activePlanSource = oneSource("active_plan");
    const expectedPlanDigest =
      activePlan === null ? null : jsonDigest(activePlan);
    if (
      activePlanSource.digest !== expectedPlanDigest ||
      activePlanSource.disposition !==
        (activePlan === null ? "excluded" : "included")
    ) {
      throw new SchemaValidationError(
        `${label}.contextManifest active Plan source does not match input`,
      );
    }
    const handoff = input.continuityHandoff;
    const handoffSource = oneSource("handoff");
    if (
      (handoff === null &&
        (manifest.acceptedHandoffDigest !== null ||
          handoffSource.disposition !== "excluded" ||
          handoffSource.digest !== null)) ||
      (handoff !== null &&
        (handoffSource?.disposition !== "included" ||
          handoffSource.digest !== manifest.acceptedHandoffDigest ||
          handoffSource.id !== `handoff:${String(manifest.acceptedHandoffDigest)}`))
    ) {
      throw new SchemaValidationError(
        `${label}.contextManifest Handoff source does not match input`,
      );
    }
    const rawTailBoundary = manifest.rawTailBoundary;
    if (
      (includedMessages.length === 0 && rawTailBoundary !== null) ||
      (includedMessages.length > 0 &&
        (!isJsonObject(rawTailBoundary) ||
          rawTailBoundary.eventId !== includedMessages[0]?.causedByEventId))
    ) {
      throw new SchemaValidationError(
        `${label}.contextManifest raw-tail boundary does not match input`,
      );
    }
    const imageBytes = messages.reduce<number>((total, message) => {
      if (!isJsonObject(message) || message.role !== "user" || !Array.isArray(message.parts)) {
        return total;
      }
      return message.parts.reduce<number>((partTotal, part) => {
        if (!isJsonObject(part) || part.type !== "image") return partTotal;
        const artifact = isJsonObject(part.artifact) ? part.artifact : null;
        return partTotal +
          (artifact !== null && typeof artifact.byteLength === "number"
            ? artifact.byteLength
            : 0);
      }, total);
    }, 0);
    const estimatedInputTokens =
      estimateContextTokens({
        activePlan: input.activePlan,
        handoff,
        instructions: input.instructions,
        messages: input.messages,
        planControl: input.planControl,
        progressControl: input.progressControl,
        runtime: input.runtimeContext,
        tools: input.tools,
      }) + imageBytes;
    if (manifest.estimatedInputTokens !== estimatedInputTokens) {
      throw new SchemaValidationError(
        `${label}.contextManifest input estimate does not match input`,
      );
    }
    return;
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

function assertArtifactReferenceValue(
  value: JsonValue | undefined,
  label: string,
  expectedMediaType?: string,
): void {
  const artifact = object(value, label);
  const digest = string(artifact.digest, `${label}.digest`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new SchemaValidationError(`${label}.digest is not SHA-256`);
  }
  const byteLength = integer(artifact.byteLength, `${label}.byteLength`);
  if (byteLength < 1 || byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new SchemaValidationError(`${label}.byteLength is outside the Artifact limit`);
  }
  const mediaType = string(artifact.mediaType, `${label}.mediaType`);
  if (expectedMediaType !== undefined && mediaType !== expectedMediaType) {
    throw new SchemaValidationError(`${label}.mediaType is unsupported`);
  }
}

function assertContinuityHandoff(
  value: JsonValue | undefined,
  label: string,
): void {
  const handoff = object(value, label);
  if (handoff.schemaVersion !== 1) {
    throw new SchemaValidationError(`${label}.schemaVersion is unsupported`);
  }
  if (handoff.activePlan !== null) {
    parsePlanSnapshot(handoff.activePlan, `${label}.activePlan`);
  }
  const model = object(handoff.model, `${label}.model`);
  string(model.model, `${label}.model.model`);
  string(model.provider, `${label}.model.provider`);
  if (handoff.previousHandoffDigest !== null) {
    string(handoff.previousHandoffDigest, `${label}.previousHandoffDigest`);
  }
  const source = object(handoff.source, `${label}.source`);
  if (source.compilerVersion !== CONTEXT_COMPILER_VERSION) {
    throw new SchemaValidationError(`${label}.source.compilerVersion is unsupported`);
  }
  string(source.threadId, `${label}.source.threadId`);
  const fromSequence = integer(source.fromSequence, `${label}.source.fromSequence`);
  const throughSequence = integer(
    source.throughSequence,
    `${label}.source.throughSequence`,
  );
  if (fromSequence < 1 || throughSequence < fromSequence) {
    throw new SchemaValidationError(`${label}.source Event range is invalid`);
  }
  const messageThroughSequence = integer(
    source.messageThroughSequence,
    `${label}.source.messageThroughSequence`,
  );
  if (
    messageThroughSequence < 0 ||
    messageThroughSequence > throughSequence
  ) {
    throw new SchemaValidationError(
      `${label}.source.messageThroughSequence is outside the source range`,
    );
  }
  if (source.clearBoundary !== null) {
    assertContextBoundary(source.clearBoundary, `${label}.source.clearBoundary`);
  }
  const eventIds = array(source.eventIds, `${label}.source.eventIds`).map(
    (eventId, index) => string(eventId, `${label}.source.eventIds[${index}]`),
  );
  if (eventIds.length === 0 || new Set(eventIds).size !== eventIds.length) {
    throw new SchemaValidationError(`${label}.source.eventIds must be unique and non-empty`);
  }
  try {
    const body = parseContinuityHandoffBody(handoff.body, eventIds);
    if (!jsonEquals(body, handoff.body)) {
      throw new TypeError("Continuity Handoff body contains unknown fields");
    }
  } catch (error) {
    throw new SchemaValidationError(
      `${label}.body is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function assertAcceptedHandoff(
  value: JsonValue | undefined,
  label: string,
): void {
  const accepted = object(value, label);
  assertArtifactReferenceValue(
    accepted.artifact,
    `${label}.artifact`,
    CONTINUITY_HANDOFF_MEDIA_TYPE,
  );
  assertContinuityHandoff(accepted.handoff, `${label}.handoff`);
}

function assertModelContinuation(
  value: JsonValue | undefined,
  label: string,
): void {
  const continuation = object(value, label);
  string(continuation.eventId, `${label}.eventId`);
  const reason = string(continuation.reason, `${label}.reason`);
  if (reason === "input_received") return;
  if (reason === "plan_updated") {
    parsePlanSnapshot(continuation.plan, `${label}.plan`);
    return;
  }
  if (reason === "plan_rejected") {
    assertDriverError(continuation.error, `${label}.error`);
    return;
  }
  if (reason === "tool_completed") {
    string(continuation.toolCallId, `${label}.toolCallId`);
    string(continuation.toolName, `${label}.toolName`);
    return;
  }
  throw new SchemaValidationError(`${label}.reason is unsupported`);
}

function assertContextCompactionInput(
  input: JsonObject,
  label: string,
  allowLegacyModelCapabilities = false,
): void {
  if (input.activePlan !== null) {
    parsePlanSnapshot(input.activePlan, `${label}.activePlan`);
  }
  if (input.clearBoundary !== null) {
    assertContextBoundary(input.clearBoundary, `${label}.clearBoundary`);
  }
  assertModelContinuation(input.continuation, `${label}.continuation`);
  const model = object(input.model, `${label}.model`);
  string(model.model, `${label}.model.model`);
  string(model.provider, `${label}.model.provider`);
  const capabilities =
    input.modelCapabilities === undefined && allowLegacyModelCapabilities
      ? modelCapabilityProfileFor(undefined)
      : modelCapabilityProfile(
          input.modelCapabilities,
          `${label}.modelCapabilities`,
        );
  if (integer(input.minimumInputTokens, `${label}.minimumInputTokens`) < 1) {
    throw new SchemaValidationError(`${label}.minimumInputTokens must be positive`);
  }
  if (integer(input.nextEffectIndex, `${label}.nextEffectIndex`) < 1) {
    throw new SchemaValidationError(`${label}.nextEffectIndex must be positive`);
  }
  const policy = object(input.policy, `${label}.policy`);
  try {
    const parsed = defineContextPolicy({
      contextWindowTokens: integer(
        policy.contextWindowTokens,
        `${label}.policy.contextWindowTokens`,
      ),
      rawTailTokens: integer(policy.rawTailTokens, `${label}.policy.rawTailTokens`),
      reservedOutputTokens: integer(
        policy.reservedOutputTokens,
        `${label}.policy.reservedOutputTokens`,
      ),
      safetyMarginTokens: integer(
        policy.safetyMarginTokens,
        `${label}.policy.safetyMarginTokens`,
      ),
    }, capabilities);
    if (policy.schemaVersion !== parsed.schemaVersion) {
      throw new TypeError("schemaVersion is unsupported");
    }
  } catch (error) {
    throw new SchemaValidationError(
      `${label}.policy is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (input.previousHandoff !== null) {
    assertAcceptedHandoff(input.previousHandoff, `${label}.previousHandoff`);
  }
  const sourceEventIds = array(input.sourceEventIds, `${label}.sourceEventIds`);
  if (sourceEventIds.length === 0) {
    throw new SchemaValidationError(`${label}.sourceEventIds must not be empty`);
  }
  sourceEventIds.forEach((eventId, index) =>
    string(eventId, `${label}.sourceEventIds[${index}]`),
  );
  if (new Set(sourceEventIds).size !== sourceEventIds.length) {
    throw new SchemaValidationError(`${label}.sourceEventIds must be unique`);
  }
  const fromSequence = integer(input.sourceFromSequence, `${label}.sourceFromSequence`);
  const throughSequence = integer(
    input.sourceThroughSequence,
    `${label}.sourceThroughSequence`,
  );
  if (fromSequence < 1 || throughSequence < fromSequence) {
    throw new SchemaValidationError(`${label} source Event range is invalid`);
  }
  array(input.sourceManifest, `${label}.sourceManifest`).forEach((source, index) =>
    assertContextManifestSourceV2(source, `${label}.sourceManifest[${index}]`),
  );
  const sourceMessageThroughSequence = integer(
    input.sourceMessageThroughSequence,
    `${label}.sourceMessageThroughSequence`,
  );
  if (
    sourceMessageThroughSequence < 0 ||
    sourceMessageThroughSequence > throughSequence
  ) {
    throw new SchemaValidationError(
      `${label}.sourceMessageThroughSequence is outside the source range`,
    );
  }
  array(input.sourceMessages, `${label}.sourceMessages`).forEach((message, index) =>
    assertModelMessage(message, `${label}.sourceMessages[${index}]`),
  );
  string(input.sourceThreadId, `${label}.sourceThreadId`);
  if (integer(input.targetTokens, `${label}.targetTokens`) < 1) {
    throw new SchemaValidationError(`${label}.targetTokens must be positive`);
  }
  const inputBudget =
    (policy.contextWindowTokens as number) -
    (policy.reservedOutputTokens as number) -
    (policy.safetyMarginTokens as number);
  if ((input.targetTokens as number) > inputBudget) {
    throw new SchemaValidationError(`${label}.targetTokens exceeds input budget`);
  }
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
  if (state.acceptedHandoff !== null) {
    assertAcceptedHandoff(state.acceptedHandoff, `${label}.acceptedHandoff`);
  }
  if (state.activePlanSource !== null) {
    assertContextBoundary(state.activePlanSource, `${label}.activePlanSource`);
  }
  if ((state.activePlan === null) !== (state.activePlanSource === null)) {
    throw new SchemaValidationError(
      `${label}.activePlanSource must match the active Plan projection`,
    );
  }
  if (state.contextClearBoundary !== null) {
    assertContextBoundary(
      state.contextClearBoundary,
      `${label}.contextClearBoundary`,
    );
  }

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
    const content = string(
      queued.content,
      `${label}.inputQueue[${index}].content`,
    );
    string(queued.eventId, `${label}.inputQueue[${index}].eventId`);
    if (integer(queued.sequence, `${label}.inputQueue[${index}].sequence`) < 1) {
      throw new SchemaValidationError(
        `${label}.inputQueue[${index}].sequence must be positive`,
      );
    }
    if (queued.parts !== undefined) {
      assertStoredInputParts(
        queued.parts,
        content,
        `${label}.inputQueue[${index}].parts`,
      );
    }
  });

  array(state.messages, `${label}.messages`).forEach((message, index) =>
    assertModelMessage(message, `${label}.messages[${index}]`),
  );
  const messageSources = array(
    state.messageSources,
    `${label}.messageSources`,
  );
  if (messageSources.length !== array(state.messages, `${label}.messages`).length) {
    throw new SchemaValidationError(
      `${label}.messageSources must match the message projection`,
    );
  }
  messageSources.forEach((source, index) =>
    assertContextBoundary(source, `${label}.messageSources[${index}]`),
  );
  parseThreadMetrics(state.metrics, `${label}.metrics`);
  assertThreadMode(state.mode, `${label}.mode`);
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
  eventSchemaVersion = CURRENT_EVENT_SCHEMA_VERSION,
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
  const allowLegacyModelMode = eventSchemaVersion < 7;
  const allowLegacyModelCapabilities = eventSchemaVersion === 8;

  if (type === "context.compact") {
    assertContextCompactionInput(
      input,
      `${label}.input`,
      allowLegacyModelCapabilities,
    );
    if (input.sourceThreadId !== threadId) {
      throw new SchemaValidationError(
        `${label}.input.sourceThreadId does not match the Event`,
      );
    }
    return cloneJson(item) as unknown as EffectRequest;
  }

  if (type === "model.generate") {
    if (input.activePlan !== null) {
      parsePlanSnapshot(input.activePlan, `${label}.input.activePlan`);
    }
    string(input.instructions, `${label}.input.instructions`);
    if (input.mode === undefined) {
      if (!allowLegacyModelMode) {
        throw new SchemaValidationError(`${label}.input.mode is required`);
      }
    } else {
      assertThreadMode(input.mode, `${label}.input.mode`);
    }
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
        allowLegacyModelCapabilities,
      );
      const manifest = object(
        input.contextManifest,
        `${label}.input.contextManifest`,
      );
      if (manifest.schemaVersion === CONTEXT_MANIFEST_SCHEMA_VERSION) {
        if (input.continuityHandoff === undefined) {
          throw new SchemaValidationError(
            `${label}.input.continuityHandoff is required by Context Manifest v2`,
          );
        }
        if (input.continuityHandoff !== null) {
          assertContinuityHandoff(
            input.continuityHandoff,
            `${label}.input.continuityHandoff`,
          );
        }
      } else if (input.continuityHandoff !== undefined) {
        throw new SchemaValidationError(
          `${label}.input.continuityHandoff requires Context Manifest v2`,
        );
      }
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
        ...(manifest.schemaVersion === CONTEXT_MANIFEST_SCHEMA_VERSION
          ? {
              continuityHandoff: input.continuityHandoff ?? null,
              contextPolicy: contextPolicyFromManifest(
                manifest,
                `${label}.input.contextManifest`,
                allowLegacyModelCapabilities,
              ),
            }
          : {}),
        instructions: input.instructions,
        messages: input.messages,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        model: input.model,
        ...(manifest.schemaVersion === CONTEXT_MANIFEST_SCHEMA_VERSION &&
          manifest.modelCapabilities !== undefined
          ? {
              modelCapabilities: modelCapabilityProfile(
                manifest.modelCapabilities,
                `${label}.input.contextManifest.modelCapabilities`,
              ),
            }
          : {}),
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
      assertContextManifestMatchesInput(
        input,
        `${label}.input`,
        allowLegacyModelCapabilities,
      );
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
  "context.compacted",
  "context.compaction_failed",
  "context.compaction_requested",
  "input.received",
  "model.completed",
  "model.failed",
  "model.requested",
  "plan.rejected",
  "plan.updated",
  "thread.created",
  "thread.forked",
  "thread.mode_changed",
  "thread.pause_requested",
  "thread.paused",
  "thread.continued",
  "thread.waiting",
  "tool.completed",
  "tool.failed",
  "tool.requested",
]);

function assertEventPayload(
  type: ThreadEventType,
  payload: JsonObject,
  threadId: string,
  schemaVersion: number,
): void {
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
      if (
        schemaVersion < 8 &&
        object(payload.agent, "payload.agent").contextPolicy !== undefined
      ) {
        throw new SchemaValidationError(
          "Event schema versions 5 through 7 cannot contain Context Policy",
        );
      }
      if (
        schemaVersion < 8 &&
        object(payload.agent, "payload.agent").modelCapabilities !== undefined
      ) {
        throw new SchemaValidationError(
          "Event schema versions 5 through 7 cannot contain Model Capability Profile",
        );
      }
      if (
        schemaVersion === CURRENT_EVENT_SCHEMA_VERSION &&
        object(payload.agent, "payload.agent").contextPolicy === undefined
      ) {
        throw new SchemaValidationError(
          "Current Event schema thread.created requires Context Policy",
        );
      }
      if (
        schemaVersion === CURRENT_EVENT_SCHEMA_VERSION &&
        object(payload.agent, "payload.agent").modelCapabilities === undefined
      ) {
        throw new SchemaValidationError(
          "Current Event schema thread.created requires Model Capability Profile",
        );
      }
      return;
    case "thread.forked":
      string(payload.parentThreadId, "payload.parentThreadId");
      string(payload.parentEventId, "payload.parentEventId");
      integer(payload.parentSequence, "payload.parentSequence");
      return;
    case "thread.mode_changed":
      if (schemaVersion < 7) {
        throw new SchemaValidationError(
          "Event schema versions 5 and 6 cannot contain thread.mode_changed",
        );
      }
      assertThreadMode(payload.mode, "payload.mode");
      return;
    case "thread.pause_requested":
    case "thread.paused":
    case "thread.continued":
    case "context.cleared":
      assertEmptyPayload(payload, "payload");
      return;
    case "context.compaction_requested": {
      if (schemaVersion < 8) {
        throw new SchemaValidationError(
          "Event schema versions 5 through 7 cannot contain Context compaction",
        );
      }
      const effect = parseEffect(
        payload.effect,
        "payload.effect",
        threadId,
        schemaVersion,
      );
      if (effect.type !== "context.compact") {
        throw new SchemaValidationError(
          "context.compaction_requested contains the wrong Effect type",
        );
      }
      return;
    }
    case "context.compacted":
      if (schemaVersion < 8) {
        throw new SchemaValidationError(
          "Event schema versions 5 through 7 cannot contain Context compaction",
        );
      }
      parseModelAccounting(payload.accounting, "payload.accounting");
      string(payload.effectId, "payload.effectId");
      assertArtifactReferenceValue(
        payload.artifact,
        "payload.artifact",
        CONTINUITY_HANDOFF_MEDIA_TYPE,
      );
      assertContinuityHandoff(payload.handoff, "payload.handoff");
      return;
    case "context.compaction_failed":
      if (schemaVersion < 8) {
        throw new SchemaValidationError(
          "Event schema versions 5 through 7 cannot contain Context compaction",
        );
      }
      parseModelAccounting(payload.accounting, "payload.accounting");
      string(payload.effectId, "payload.effectId");
      assertDriverError(payload.error, "payload.error");
      if (
        payload.disposition !== "failed" &&
        payload.disposition !== "indeterminate"
      ) {
        throw new SchemaValidationError("payload.disposition is unsupported");
      }
      return;
    case "thread.waiting":
      string(payload.effectId, "payload.effectId");
      if (payload.reasonCode !== "effect_outcome_unknown") {
        throw new SchemaValidationError("payload.reasonCode is unsupported");
      }
      return;
    case "input.received": {
      const content = string(payload.content, "payload.content");
      if (schemaVersion === 5 && payload.parts !== undefined) {
        throw new SchemaValidationError(
          "Event schema version 5 input.received cannot contain structured parts",
        );
      }
      if (payload.parts !== undefined) {
        assertStoredInputParts(payload.parts, content, "payload.parts");
      }
      return;
    }
    case "model.requested":
    case "tool.requested": {
      if (type === "model.requested") {
        const effectInput = object(
          object(payload.effect, "payload.effect").input,
          "payload.effect.input",
        );
        if (schemaVersion < 7 && effectInput.mode !== undefined) {
          throw new SchemaValidationError(
            "Event schema versions 5 and 6 model.requested cannot contain mode",
          );
        }
        if (
          schemaVersion < 8 &&
          (effectInput.continuityHandoff !== undefined ||
            (isJsonObject(effectInput.contextManifest) &&
              effectInput.contextManifest.schemaVersion ===
                CONTEXT_MANIFEST_SCHEMA_VERSION))
        ) {
          throw new SchemaValidationError(
            "Event schema versions 5 through 7 model.requested cannot contain bounded Context fields",
          );
        }
        if (
          schemaVersion === CURRENT_EVENT_SCHEMA_VERSION &&
          (!isJsonObject(effectInput.contextManifest) ||
            effectInput.contextManifest.schemaVersion !==
              CONTEXT_MANIFEST_SCHEMA_VERSION)
        ) {
          throw new SchemaValidationError(
            "Current Event schema model.requested requires bounded Context fields",
          );
        }
        if (schemaVersion === 5) {
          array(effectInput.messages, "payload.effect.input.messages").forEach(
            (message, index) => {
              const item = object(
                message,
                `payload.effect.input.messages[${index}]`,
              );
              if (item.role === "user" && item.parts !== undefined) {
                throw new SchemaValidationError(
                  "Event schema version 5 model.requested cannot contain structured parts",
                );
              }
            },
          );
        }
      }
      const effect = parseEffect(
        payload.effect,
        "payload.effect",
        threadId,
        schemaVersion,
      );
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
  assertEventPayload(type, payload, threadId, schemaVersion);
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
