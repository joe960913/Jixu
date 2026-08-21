import {
  LEGACY_MODEL_CAPABILITY_PROFILE,
  type ModelCapabilityProfile,
} from "./model-capabilities.ts";

export const CONTEXT_POLICY_SCHEMA_VERSION = 1;

export interface ContextPolicy {
  readonly contextWindowTokens: number;
  readonly rawTailTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly schemaVersion: 1;
}

export interface ContextPolicyConfig {
  readonly contextWindowTokens?: number;
  readonly rawTailTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly safetyMarginTokens?: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = Object.freeze({
  contextWindowTokens: 32_768,
  rawTailTokens: 8_192,
  reservedOutputTokens: 4_096,
  safetyMarginTokens: 2_048,
  schemaVersion: CONTEXT_POLICY_SCHEMA_VERSION,
});

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function defineContextPolicy(
  config: ContextPolicyConfig = {},
  capabilities: ModelCapabilityProfile = LEGACY_MODEL_CAPABILITY_PROFILE,
): ContextPolicy {
  if (
    config.contextWindowTokens !== undefined &&
    config.contextWindowTokens !== capabilities.contextWindowTokens
  ) {
    throw new TypeError(
      "Context contextWindowTokens must match the Model Capability Profile",
    );
  }
  const defaultReservedOutputTokens = Math.min(
    DEFAULT_CONTEXT_POLICY.reservedOutputTokens,
    capabilities.maxOutputTokens,
    Math.max(1, Math.floor(capabilities.contextWindowTokens / 4)),
  );
  const reservedOutputTokens = positiveInteger(
    config.reservedOutputTokens ?? defaultReservedOutputTokens,
    "Context reservedOutputTokens",
  );
  if (reservedOutputTokens > capabilities.maxOutputTokens) {
    throw new TypeError(
      "Context reservedOutputTokens must not exceed the model maximum output",
    );
  }
  const availableAfterOutput =
    capabilities.contextWindowTokens - reservedOutputTokens;
  const safetyMarginTokens = positiveInteger(
    config.safetyMarginTokens ??
      Math.min(
        DEFAULT_CONTEXT_POLICY.safetyMarginTokens,
        Math.max(1, availableAfterOutput - 1),
      ),
    "Context safetyMarginTokens",
  );
  const inputBudget =
    capabilities.contextWindowTokens -
    reservedOutputTokens -
    safetyMarginTokens;
  if (inputBudget <= 0) {
    throw new TypeError(
      "Context reservedOutputTokens and safetyMarginTokens must leave a positive input budget",
    );
  }
  const rawTailTokens = positiveInteger(
    config.rawTailTokens ??
      Math.min(DEFAULT_CONTEXT_POLICY.rawTailTokens, inputBudget),
    "Context rawTailTokens",
  );
  if (rawTailTokens > inputBudget) {
    throw new TypeError(
      "Context rawTailTokens must not exceed the available input budget",
    );
  }
  return Object.freeze({
    contextWindowTokens: capabilities.contextWindowTokens,
    rawTailTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    schemaVersion: CONTEXT_POLICY_SCHEMA_VERSION,
  });
}

export function contextPolicyFor(
  policy: ContextPolicy | undefined,
  capabilities: ModelCapabilityProfile = LEGACY_MODEL_CAPABILITY_PROFILE,
): ContextPolicy {
  return policy ?? defineContextPolicy({}, capabilities);
}
