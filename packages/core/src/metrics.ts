import { SchemaValidationError } from "./errors.ts";
import { isJsonObject } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";

export interface ModelTokenUsage {
  readonly cacheWriteTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number;
}

export interface ModelCost {
  readonly currency: "USD";
  readonly pricingVersion: string | null;
  readonly source: "calculator" | "provider_reported";
  readonly usdNanos: number;
}

export interface ModelAccounting {
  readonly cost: ModelCost | null;
  readonly usage: ModelTokenUsage | null;
}

export interface EffectMetrics {
  readonly attempts: number;
  readonly cancelled: number;
  readonly calls: number;
  readonly failed: number;
  readonly indeterminate: number;
  readonly succeeded: number;
}

export interface TokenMetrics {
  readonly cacheWriteReports: number;
  readonly cacheWriteTokens: number;
  readonly cachedInputReports: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly missingReports: number;
  readonly outputTokens: number;
  readonly reasoningReports: number;
  readonly reasoningTokens: number;
  readonly reports: number;
  readonly totalTokens: number;
}

export interface CostMetrics {
  readonly pricedOutcomes: number;
  readonly unpricedOutcomes: number;
  readonly usdNanos: number;
}

export interface ThreadMetrics {
  readonly cost: CostMetrics;
  readonly model: EffectMetrics;
  readonly tokens: TokenMetrics;
  readonly tools: EffectMetrics;
}

export const EMPTY_MODEL_ACCOUNTING: ModelAccounting = Object.freeze({
  cost: null,
  usage: null,
});

export function createInitialThreadMetrics(): ThreadMetrics {
  return {
    cost: { pricedOutcomes: 0, unpricedOutcomes: 0, usdNanos: 0 },
    model: {
      attempts: 0,
      cancelled: 0,
      calls: 0,
      failed: 0,
      indeterminate: 0,
      succeeded: 0,
    },
    tokens: {
      cacheWriteReports: 0,
      cacheWriteTokens: 0,
      cachedInputReports: 0,
      cachedInputTokens: 0,
      inputTokens: 0,
      missingReports: 0,
      outputTokens: 0,
      reasoningReports: 0,
      reasoningTokens: 0,
      reports: 0,
      totalTokens: 0,
    },
    tools: {
      attempts: 0,
      cancelled: 0,
      calls: 0,
      failed: 0,
      indeterminate: 0,
      succeeded: 0,
    },
  };
}

function fail(label: string, message: string): never {
  throw new SchemaValidationError(`${label} ${message}`);
}

function add(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) fail(label, "exceeds safe integer range");
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) fail(label, "must be a JSON object");
  return value;
}

function count(value: JsonValue | undefined, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(label, "must be a non-negative safe integer");
  }
  return value;
}

function optionalCount(
  value: JsonValue | undefined,
  label: string,
): number | null {
  return value === null ? null : count(value, label);
}

export function parseModelTokenUsage(
  value: unknown,
  label = "Model token usage",
): ModelTokenUsage {
  const usage = object(value, label);
  const parsed: ModelTokenUsage = {
    cacheWriteTokens: optionalCount(
      usage.cacheWriteTokens,
      `${label}.cacheWriteTokens`,
    ),
    cachedInputTokens: optionalCount(
      usage.cachedInputTokens,
      `${label}.cachedInputTokens`,
    ),
    inputTokens: count(usage.inputTokens, `${label}.inputTokens`),
    outputTokens: count(usage.outputTokens, `${label}.outputTokens`),
    reasoningTokens: optionalCount(
      usage.reasoningTokens,
      `${label}.reasoningTokens`,
    ),
    totalTokens: count(usage.totalTokens, `${label}.totalTokens`),
  };
  if (
    parsed.cachedInputTokens !== null &&
    parsed.cachedInputTokens > parsed.inputTokens
  ) {
    fail(`${label}.cachedInputTokens`, "cannot exceed inputTokens");
  }
  if (
    parsed.cacheWriteTokens !== null &&
    parsed.cacheWriteTokens > parsed.inputTokens
  ) {
    fail(`${label}.cacheWriteTokens`, "cannot exceed inputTokens");
  }
  if (
    parsed.reasoningTokens !== null &&
    parsed.reasoningTokens > parsed.outputTokens
  ) {
    fail(`${label}.reasoningTokens`, "cannot exceed outputTokens");
  }
  return parsed;
}

export function parseModelCost(
  value: unknown,
  label = "Model cost",
): ModelCost {
  const cost = object(value, label);
  if (cost.currency !== "USD") fail(`${label}.currency`, "must be USD");
  if (cost.source !== "provider_reported" && cost.source !== "calculator") {
    fail(`${label}.source`, "is unsupported");
  }
  if (
    cost.pricingVersion !== null &&
    typeof cost.pricingVersion !== "string"
  ) {
    fail(`${label}.pricingVersion`, "must be a string or null");
  }
  return {
    currency: "USD",
    pricingVersion: cost.pricingVersion,
    source: cost.source,
    usdNanos: count(cost.usdNanos, `${label}.usdNanos`),
  };
}

export function parseModelAccounting(
  value: unknown,
  label = "Model accounting",
): ModelAccounting {
  const accounting = object(value, label);
  return {
    cost:
      accounting.cost === null
        ? null
        : parseModelCost(accounting.cost, `${label}.cost`),
    usage:
      accounting.usage === null
        ? null
        : parseModelTokenUsage(accounting.usage, `${label}.usage`),
  };
}

function parseEffectMetrics(value: unknown, label: string): EffectMetrics {
  const metrics = object(value, label);
  const parsed: EffectMetrics = {
    attempts: count(metrics.attempts, `${label}.attempts`),
    cancelled:
      metrics.cancelled === undefined
        ? 0
        : count(metrics.cancelled, `${label}.cancelled`),
    calls: count(metrics.calls, `${label}.calls`),
    failed: count(metrics.failed, `${label}.failed`),
    indeterminate: count(metrics.indeterminate, `${label}.indeterminate`),
    succeeded: count(metrics.succeeded, `${label}.succeeded`),
  };
  if (parsed.calls > parsed.attempts) {
    fail(`${label}.calls`, "cannot exceed attempts");
  }
  if (
    parsed.succeeded + parsed.cancelled + parsed.failed + parsed.indeterminate >
    parsed.attempts
  ) {
    fail(label, "terminal outcomes cannot exceed attempts");
  }
  return parsed;
}

export function parseThreadMetrics(
  value: unknown,
  label = "Thread metrics",
): ThreadMetrics {
  const metrics = object(value, label);
  const costValue = object(metrics.cost, `${label}.cost`);
  const tokenValue = object(metrics.tokens, `${label}.tokens`);
  const cost: CostMetrics = {
    pricedOutcomes: count(
      costValue.pricedOutcomes,
      `${label}.cost.pricedOutcomes`,
    ),
    unpricedOutcomes: count(
      costValue.unpricedOutcomes,
      `${label}.cost.unpricedOutcomes`,
    ),
    usdNanos: count(costValue.usdNanos, `${label}.cost.usdNanos`),
  };
  const tokens: TokenMetrics = {
    cacheWriteReports: count(
      tokenValue.cacheWriteReports,
      `${label}.tokens.cacheWriteReports`,
    ),
    cacheWriteTokens: count(
      tokenValue.cacheWriteTokens,
      `${label}.tokens.cacheWriteTokens`,
    ),
    cachedInputReports: count(
      tokenValue.cachedInputReports,
      `${label}.tokens.cachedInputReports`,
    ),
    cachedInputTokens: count(
      tokenValue.cachedInputTokens,
      `${label}.tokens.cachedInputTokens`,
    ),
    inputTokens: count(tokenValue.inputTokens, `${label}.tokens.inputTokens`),
    missingReports: count(
      tokenValue.missingReports,
      `${label}.tokens.missingReports`,
    ),
    outputTokens: count(
      tokenValue.outputTokens,
      `${label}.tokens.outputTokens`,
    ),
    reasoningReports: count(
      tokenValue.reasoningReports,
      `${label}.tokens.reasoningReports`,
    ),
    reasoningTokens: count(
      tokenValue.reasoningTokens,
      `${label}.tokens.reasoningTokens`,
    ),
    reports: count(tokenValue.reports, `${label}.tokens.reports`),
    totalTokens: count(tokenValue.totalTokens, `${label}.tokens.totalTokens`),
  };
  const model = parseEffectMetrics(metrics.model, `${label}.model`);
  const modelOutcomes =
    model.succeeded + model.cancelled + model.failed + model.indeterminate;
  if (cost.pricedOutcomes + cost.unpricedOutcomes !== modelOutcomes) {
    fail(`${label}.cost`, "must account for every terminal model outcome");
  }
  if (tokens.reports + tokens.missingReports !== modelOutcomes) {
    fail(`${label}.tokens`, "must account for every terminal model outcome");
  }
  if (
    tokens.reasoningReports > tokens.reports ||
    tokens.cachedInputReports > tokens.reports ||
    tokens.cacheWriteReports > tokens.reports
  ) {
    fail(`${label}.tokens`, "detail reports cannot exceed usage reports");
  }
  return {
    cost,
    model,
    tokens,
    tools: parseEffectMetrics(metrics.tools, `${label}.tools`),
  };
}

function effectMetrics(
  metrics: ThreadMetrics,
  kind: "model" | "tools",
  update: Partial<EffectMetrics>,
): ThreadMetrics {
  return {
    ...metrics,
    [kind]: { ...metrics[kind], ...update },
  };
}

export function recordEffectRequest(
  metrics: ThreadMetrics,
  kind: "model" | "tools",
  retry: boolean,
): ThreadMetrics {
  const current = metrics[kind];
  return effectMetrics(metrics, kind, {
    attempts: add(current.attempts, 1, `${kind}.attempts`),
    calls: add(current.calls, retry ? 0 : 1, `${kind}.calls`),
  });
}

export function recordEffectOutcome(
  metrics: ThreadMetrics,
  kind: "model" | "tools",
  outcome: "cancelled" | "failed" | "indeterminate" | "succeeded",
): ThreadMetrics {
  const current = metrics[kind];
  return effectMetrics(metrics, kind, {
    [outcome]: add(current[outcome], 1, `${kind}.${outcome}`),
  });
}

export function recordModelAccounting(
  metrics: ThreadMetrics,
  accounting: ModelAccounting,
): ThreadMetrics {
  const usage = accounting.usage;
  const cost = accounting.cost;
  return {
    ...metrics,
    cost: {
      pricedOutcomes: add(
        metrics.cost.pricedOutcomes,
        cost === null ? 0 : 1,
        "cost.pricedOutcomes",
      ),
      unpricedOutcomes: add(
        metrics.cost.unpricedOutcomes,
        cost === null ? 1 : 0,
        "cost.unpricedOutcomes",
      ),
      usdNanos: add(
        metrics.cost.usdNanos,
        cost?.usdNanos ?? 0,
        "cost.usdNanos",
      ),
    },
    tokens: {
      cacheWriteReports: add(
        metrics.tokens.cacheWriteReports,
        usage === null || usage.cacheWriteTokens === null ? 0 : 1,
        "tokens.cacheWriteReports",
      ),
      cacheWriteTokens: add(
        metrics.tokens.cacheWriteTokens,
        usage?.cacheWriteTokens ?? 0,
        "tokens.cacheWriteTokens",
      ),
      cachedInputReports: add(
        metrics.tokens.cachedInputReports,
        usage === null || usage.cachedInputTokens === null ? 0 : 1,
        "tokens.cachedInputReports",
      ),
      cachedInputTokens: add(
        metrics.tokens.cachedInputTokens,
        usage?.cachedInputTokens ?? 0,
        "tokens.cachedInputTokens",
      ),
      inputTokens: add(
        metrics.tokens.inputTokens,
        usage?.inputTokens ?? 0,
        "tokens.inputTokens",
      ),
      missingReports: add(
        metrics.tokens.missingReports,
        usage === null ? 1 : 0,
        "tokens.missingReports",
      ),
      outputTokens: add(
        metrics.tokens.outputTokens,
        usage?.outputTokens ?? 0,
        "tokens.outputTokens",
      ),
      reasoningReports: add(
        metrics.tokens.reasoningReports,
        usage === null || usage.reasoningTokens === null ? 0 : 1,
        "tokens.reasoningReports",
      ),
      reasoningTokens: add(
        metrics.tokens.reasoningTokens,
        usage?.reasoningTokens ?? 0,
        "tokens.reasoningTokens",
      ),
      reports: add(
        metrics.tokens.reports,
        usage === null ? 0 : 1,
        "tokens.reports",
      ),
      totalTokens: add(
        metrics.tokens.totalTokens,
        usage?.totalTokens ?? 0,
        "tokens.totalTokens",
      ),
    },
  };
}
