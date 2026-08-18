import { EMPTY_MODEL_ACCOUNTING } from "@jixu/core";
import type {
  ModelAccounting,
  ModelCost,
  ModelTokenUsage,
} from "@jixu/core";

type AccountingApiFormat = "chat-completions" | "responses";

export interface ModelCostCalculationInput {
  readonly model: string;
  readonly provider: string;
  readonly usage: ModelTokenUsage;
}

export type ModelCostCalculator = (
  input: ModelCostCalculationInput,
) => ModelCost | null;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function token(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function tokenDetail(value: unknown, key: string): number | null {
  return token(record(value)?.[key]);
}

function canonicalUsage(
  value: unknown,
  format: AccountingApiFormat,
): ModelTokenUsage | null {
  const usage = record(value);
  if (usage === null) return null;
  const inputTokens = token(
    format === "responses" ? usage.input_tokens : usage.prompt_tokens,
  );
  const outputTokens = token(
    format === "responses" ? usage.output_tokens : usage.completion_tokens,
  );
  const totalTokens = token(usage.total_tokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return null;
  }

  const inputDetails =
    format === "responses"
      ? usage.input_tokens_details
      : usage.prompt_tokens_details;
  const outputDetails =
    format === "responses"
      ? usage.output_tokens_details
      : usage.completion_tokens_details;
  return {
    cacheWriteTokens: tokenDetail(inputDetails, "cache_write_tokens"),
    cachedInputTokens: tokenDetail(inputDetails, "cached_tokens"),
    inputTokens,
    outputTokens,
    reasoningTokens: tokenDetail(outputDetails, "reasoning_tokens"),
    totalTokens,
  };
}

function providerUsdCost(value: unknown, trusted: boolean): ModelCost | null {
  const dollars = number(record(value)?.cost);
  if (
    !trusted ||
    dollars === undefined ||
    !Number.isFinite(dollars) ||
    dollars < 0 ||
    dollars > Number.MAX_SAFE_INTEGER / 1_000_000_000
  ) {
    return null;
  }
  return {
    currency: "USD",
    pricingVersion: null,
    source: "provider_reported",
    usdNanos: Math.round(dollars * 1_000_000_000),
  };
}

export function modelAccounting(
  usageValue: unknown,
  format: AccountingApiFormat,
  config: {
    readonly costCalculator: ModelCostCalculator | undefined;
    readonly model: string;
    readonly provider: string;
    readonly providerReportsUsdCost: boolean;
  },
): ModelAccounting {
  const usage = canonicalUsage(usageValue, format);
  if (usage === null) return EMPTY_MODEL_ACCOUNTING;
  let cost = providerUsdCost(usageValue, config.providerReportsUsdCost);
  if (cost === null && config.costCalculator !== undefined) {
    try {
      cost = config.costCalculator({
        model: config.model,
        provider: config.provider,
        usage,
      });
    } catch {
      cost = null;
    }
  }
  return { cost, usage };
}

export function isOpenRouterBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}
