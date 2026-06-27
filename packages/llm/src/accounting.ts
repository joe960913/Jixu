import { EMPTY_MODEL_ACCOUNTING } from "@jixu/core";
import type {
  ModelAccounting,
  ModelCost,
  ModelTokenUsage,
} from "@jixu/core";

type AccountingApi = "anthropic-messages" | "openai-chat-completions";

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
  api: AccountingApi,
): ModelTokenUsage | null {
  const usage = record(value);
  if (usage === null) return null;
  if (api === "anthropic-messages") {
    const uncachedInputTokens = token(usage.input_tokens);
    const outputTokens = token(usage.output_tokens);
    if (uncachedInputTokens === null || outputTokens === null) return null;
    const cachedInputTokens = token(usage.cache_read_input_tokens);
    const cacheWriteTokens = token(usage.cache_creation_input_tokens);
    const inputTokens =
      uncachedInputTokens +
      (cachedInputTokens ?? 0) +
      (cacheWriteTokens ?? 0);
    if (!Number.isSafeInteger(inputTokens)) return null;
    const totalTokens = inputTokens + outputTokens;
    if (!Number.isSafeInteger(totalTokens)) return null;
    return {
      cacheWriteTokens,
      cachedInputTokens,
      inputTokens,
      outputTokens,
      reasoningTokens: tokenDetail(
        usage.output_tokens_details,
        "thinking_tokens",
      ),
      totalTokens,
    };
  }

  const inputTokens = token(usage.prompt_tokens);
  const outputTokens = token(usage.completion_tokens);
  if (inputTokens === null || outputTokens === null) {
    return null;
  }
  const derivedTotal = inputTokens + outputTokens;
  if (!Number.isSafeInteger(derivedTotal)) return null;
  const totalTokens = token(usage.total_tokens) ?? derivedTotal;

  const inputDetails = usage.prompt_tokens_details;
  const outputDetails = usage.completion_tokens_details;
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
  api: AccountingApi,
  config: {
    readonly costCalculator: ModelCostCalculator | undefined;
    readonly model: string;
    readonly provider: string;
    readonly providerReportsUsdCost: boolean;
  },
): ModelAccounting {
  const usage = canonicalUsage(usageValue, api);
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
