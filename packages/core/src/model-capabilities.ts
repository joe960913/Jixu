export const MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION = 1;

export type ModelCapabilitySourceKind =
  | "catalog"
  | "explicit"
  | "legacy"
  | "provider";

export interface ModelCapabilitySource {
  readonly kind: ModelCapabilitySourceKind;
  readonly name: string;
}

export interface ModelCapabilityProfile {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly resolvedModel: string;
  readonly schemaVersion: 1;
  readonly source: ModelCapabilitySource;
}

export interface ModelCapabilityProfileConfig {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly resolvedModel: string;
  readonly source: ModelCapabilitySource;
}

export const LEGACY_MODEL_CAPABILITY_PROFILE: ModelCapabilityProfile =
  Object.freeze({
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    resolvedModel: "legacy-portable-default",
    schemaVersion: MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION,
    source: Object.freeze({
      kind: "legacy",
      name: "jixu-event-schema-5-8",
    }),
  });

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedText(value: string, label: string): string {
  const clean = value.trim();
  if (clean.length === 0 || clean.length > 512) {
    throw new TypeError(`${label} must contain 1 to 512 characters`);
  }
  return clean;
}

export function defineModelCapabilityProfile(
  config: ModelCapabilityProfileConfig,
): ModelCapabilityProfile {
  const contextWindowTokens = positiveInteger(
    config.contextWindowTokens,
    "Model capability contextWindowTokens",
  );
  const maxOutputTokens = positiveInteger(
    config.maxOutputTokens,
    "Model capability maxOutputTokens",
  );
  if (maxOutputTokens > contextWindowTokens) {
    throw new TypeError(
      "Model capability maxOutputTokens must not exceed contextWindowTokens",
    );
  }
  const kind = config.source.kind;
  if (
    kind !== "catalog" &&
    kind !== "explicit" &&
    kind !== "legacy" &&
    kind !== "provider"
  ) {
    throw new TypeError("Model capability source kind is unsupported");
  }
  return Object.freeze({
    contextWindowTokens,
    maxOutputTokens,
    resolvedModel: boundedText(
      config.resolvedModel,
      "Model capability resolvedModel",
    ),
    schemaVersion: MODEL_CAPABILITY_PROFILE_SCHEMA_VERSION,
    source: Object.freeze({
      kind,
      name: boundedText(config.source.name, "Model capability source name"),
    }),
  });
}

export function modelCapabilityProfileFor(
  profile: ModelCapabilityProfile | undefined,
): ModelCapabilityProfile {
  return profile ?? LEGACY_MODEL_CAPABILITY_PROFILE;
}
