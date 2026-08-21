import {
  defineModelCapabilityProfile,
  isJsonObject,
  jsonDigest,
} from "jixu-core";
import type {
  JsonObject,
  JsonValue,
  ModelCapabilityProfile,
} from "jixu-core";

export type LLMCapabilityApi =
  | "anthropic-messages"
  | "openai-chat-completions";

export interface ExplicitModelCapabilities {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

export interface LLMModelCapabilityResolverConfig {
  readonly api: LLMCapabilityApi;
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly explicit?: ExplicitModelCapabilities;
  readonly fetch?: typeof fetch;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class ModelCapabilityResolutionError extends TypeError {
  readonly code:
    | "model_capability_metadata_failed"
    | "model_capability_metadata_invalid"
    | "model_capability_unknown";

  constructor(
    code: ModelCapabilityResolutionError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ModelCapabilityResolutionError";
  }
}

const MODEL_CATALOG_REVISION = "2026-08-22";
const MAX_METADATA_BYTES = 256 * 1024;
const DEFAULT_METADATA_TIMEOUT_MS = 10_000;

interface CatalogEntry {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly matches: RegExp;
}

const OPENAI_CATALOG: readonly CatalogEntry[] = Object.freeze([
  {
    contextWindowTokens: 1_050_000,
    matches: /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/u,
    maxOutputTokens: 128_000,
  },
  {
    contextWindowTokens: 1_050_000,
    matches: /^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/u,
    maxOutputTokens: 128_000,
  },
  {
    contextWindowTokens: 400_000,
    matches: /^gpt-5\.(?:1|2)(?:-\d{4}-\d{2}-\d{2})?$/u,
    maxOutputTokens: 128_000,
  },
  {
    contextWindowTokens: 400_000,
    matches: /^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u,
    maxOutputTokens: 128_000,
  },
  {
    contextWindowTokens: 1_047_576,
    matches: /^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u,
    maxOutputTokens: 32_768,
  },
  {
    contextWindowTokens: 200_000,
    matches: /^(?:o3|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/u,
    maxOutputTokens: 100_000,
  },
  {
    contextWindowTokens: 128_000,
    matches: /^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/u,
    maxOutputTokens: 16_384,
  },
]);

const DEEPSEEK_CATALOG: readonly CatalogEntry[] = Object.freeze([
  {
    contextWindowTokens: 1_000_000,
    matches: /^deepseek-v4-(?:flash|pro)$/u,
    maxOutputTokens: 384_000,
  },
]);

function normalizedBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim().replace(/\/+$/u, ""));
  } catch {
    throw new TypeError("LLM Base URL must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("LLM Base URL must use HTTP or HTTPS");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(
      "LLM Base URL must not contain credentials, query, or fragment",
    );
  }
  return url;
}

function endpointHost(url: URL): string {
  return url.hostname.toLowerCase();
}

function endpointIdentity(url: URL): string {
  return jsonDigest({
    origin: url.origin.toLowerCase(),
    path: url.pathname.replace(/\/+$/u, "") || "/",
  });
}

function isOpenRouter(url: URL): boolean {
  const host = endpointHost(url);
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function endpointPath(url: URL): string {
  return url.pathname.replace(/\/+$/u, "");
}

function isDirectOpenAI(url: URL): boolean {
  const path = endpointPath(url);
  return endpointHost(url) === "api.openai.com" && (path === "" || path === "/v1");
}

function isDirectDeepSeek(url: URL, api: LLMCapabilityApi): boolean {
  if (endpointHost(url) !== "api.deepseek.com") return false;
  const path = endpointPath(url);
  return api === "anthropic-messages"
    ? path === "/anthropic" || path === "/anthropic/v1"
    : path === "" || path === "/v1";
}

function catalogueProfile(
  model: string,
  entries: readonly CatalogEntry[],
  name: string,
): ModelCapabilityProfile | null {
  const normalized = model.trim().toLowerCase();
  const entry = entries.find((candidate) => candidate.matches.test(normalized));
  if (entry === undefined) return null;
  return defineModelCapabilityProfile({
    contextWindowTokens: entry.contextWindowTokens,
    maxOutputTokens: entry.maxOutputTokens,
    resolvedModel: normalized,
    source: {
      kind: "catalog",
      name: `${name}@${MODEL_CATALOG_REVISION}`,
    },
  });
}

function numberField(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function providerProfile(
  value: JsonObject,
  requestedModel: string,
  sourceName: string,
  allowResolvedAlias: boolean,
  allowContextBoundOutput: boolean,
): ModelCapabilityProfile {
  const topProvider = isJsonObject(value.top_provider)
    ? value.top_provider
    : undefined;
  const contextWindowTokens =
    numberField(value.context_length) ??
    numberField(value.context_window) ??
    numberField(value.max_input_tokens) ??
    numberField(topProvider?.context_length);
  const declaredMaxOutputTokens =
    numberField(value.max_completion_tokens) ??
    numberField(value.max_output_tokens) ??
    numberField(value.max_tokens) ??
    numberField(topProvider?.max_completion_tokens);
  const supportedParameters = value.supported_parameters;
  const hasContextBoundOutput =
    allowContextBoundOutput &&
    topProvider?.max_completion_tokens === null &&
    Array.isArray(supportedParameters) &&
    supportedParameters.some(
      (parameter) =>
        parameter === "max_tokens" || parameter === "max_completion_tokens",
    );
  const maxOutputTokens =
    declaredMaxOutputTokens ??
    (hasContextBoundOutput ? contextWindowTokens : undefined);
  const id =
    typeof value.id === "string" && value.id.trim().length > 0
      ? value.id.trim()
      : undefined;
  const canonicalSlug =
    typeof value.canonical_slug === "string" &&
    value.canonical_slug.trim().length > 0
      ? value.canonical_slug.trim()
      : undefined;
  if (
    contextWindowTokens === undefined ||
    maxOutputTokens === undefined ||
    id === undefined
  ) {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_invalid",
      "Model metadata does not contain a complete context window and maximum output",
    );
  }
  if (
    !allowResolvedAlias &&
    id !== requestedModel &&
    canonicalSlug !== requestedModel
  ) {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_invalid",
      `Model metadata returned ${id} instead of ${requestedModel}`,
    );
  }
  return defineModelCapabilityProfile({
    contextWindowTokens,
    maxOutputTokens,
    resolvedModel: id,
    source: { kind: "provider", name: sourceName },
  });
}

function metadataUrl(
  base: URL,
  model: string,
  openRouter: boolean,
  api: LLMCapabilityApi,
): URL {
  if (openRouter) {
    const path = base.pathname.replace(/\/+$/u, "");
    base.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
    base.searchParams.set("q", model);
    return base;
  }
  let path = base.pathname.replace(/\/+$/u, "");
  if (api === "anthropic-messages" && !path.endsWith("/v1")) {
    path = `${path}/v1`;
  }
  base.pathname = `${path}/models/${encodeURIComponent(model)}`;
  return base;
}

async function fetchMetadata(
  config: LLMModelCapabilityResolverConfig,
  base: URL,
): Promise<JsonObject> {
  const openRouter = isOpenRouter(base);
  const request = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Model capability timeoutMs must be a positive integer");
  }
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (config.signal !== undefined) signals.push(config.signal);
  let response: Response;
  try {
    response = await request(
      metadataUrl(new URL(base), config.model, openRouter, config.api),
      {
      headers:
        config.api === "anthropic-messages" && !openRouter
          ? {
              "anthropic-version": "2023-06-01",
              ...(config.apiKey === undefined
                ? {}
                : { "x-api-key": config.apiKey }),
            }
          : config.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${config.apiKey}` },
      method: "GET",
        signal: AbortSignal.any(signals),
      },
    );
  } catch {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_failed",
      "Model capability metadata request failed or timed out",
    );
  }
  if (!response.ok) {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_failed",
      `Model capability metadata request failed with HTTP ${response.status}`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_invalid",
      "Model capability metadata exceeded the response bound",
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_failed",
      "Model capability metadata response could not be read",
    );
  }
  if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES) {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_invalid",
      "Model capability metadata exceeded the response bound",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_invalid",
      "Model capability metadata is not valid JSON",
    );
  }
  if (!isJsonObject(parsed)) {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_invalid",
      "Model capability metadata must be a JSON object",
    );
  }
  if (!openRouter) return parsed;
  if (!Array.isArray(parsed.data)) {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_invalid",
      "OpenRouter model metadata does not contain a model list",
    );
  }
  const exact = parsed.data.find(
    (candidate): candidate is JsonObject =>
      isJsonObject(candidate) &&
      (candidate.id === config.model || candidate.canonical_slug === config.model),
  );
  if (exact === undefined) {
    throw new ModelCapabilityResolutionError(
      "model_capability_metadata_invalid",
      `OpenRouter model metadata does not contain ${config.model}`,
    );
  }
  return exact;
}

export async function resolveLLMModelCapabilities(
  config: LLMModelCapabilityResolverConfig,
): Promise<ModelCapabilityProfile> {
  const model = config.model.trim();
  if (model.length === 0) throw new TypeError("Model ID must not be empty");
  const base = normalizedBaseUrl(config.baseURL);
  const openRouter = isOpenRouter(base);
  if (config.explicit !== undefined) {
    return defineModelCapabilityProfile({
      ...config.explicit,
      resolvedModel: model,
      source: {
        kind: "explicit",
        name: `application-declaration:${endpointIdentity(base)}`,
      },
    });
  }

  const host = endpointHost(base);
  if (isDirectOpenAI(base)) {
    const profile = catalogueProfile(model, OPENAI_CATALOG, "openai-official");
    if (profile !== null) return profile;
  } else if (isDirectDeepSeek(base, config.api)) {
    const profile = catalogueProfile(
      model,
      DEEPSEEK_CATALOG,
      "deepseek-official",
    );
    if (profile !== null) return profile;
  } else {
    const metadata = await fetchMetadata({ ...config, model }, base);
    return providerProfile(
      metadata,
      model,
      `${host}:models-api:${endpointIdentity(base)}`,
      config.api === "anthropic-messages" && host === "api.anthropic.com",
      openRouter,
    );
  }

  throw new ModelCapabilityResolutionError(
    "model_capability_unknown",
    `Model capacity is unknown for ${model}; provide an explicit context window and maximum output`,
  );
}
