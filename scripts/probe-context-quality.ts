import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isJsonObject } from "../packages/core/src/index.ts";
import type {
  AcceptedContinuityHandoff,
  ContinuityHandoffBody,
  ModelAccounting,
  ModelCapabilityProfile,
} from "../packages/core/src/index.ts";
import {
  createLLMModelDriver,
  resolveLLMModelCapabilities,
} from "../packages/llm/src/index.ts";
import type { LLMApi } from "../packages/llm/src/index.ts";
import {
  acceptContextQualityHandoff,
  CONTEXT_QUALITY_EVALUATOR_VERSION,
  contextQualityCompactionEffect,
  contextQualityDriverContext,
  evaluateContextQualityCase,
  loadContextQualityCorpus,
} from "./lib/context-quality.ts";
import { repositoryRoot } from "./package-artifacts.ts";

interface LiveProbeDefinition {
  readonly api: LLMApi;
  readonly apiKeyEnv: string;
  readonly baseURL: string;
  readonly id: string;
  readonly model: string;
  readonly modelCapabilities?: {
    readonly contextWindowTokens: number;
    readonly maxOutputTokens: number;
  };
}

interface LiveProbeConfig {
  readonly probes: readonly LiveProbeDefinition[];
  readonly schemaVersion: 1;
}

const configKeys = new Set(["probes", "schemaVersion"]);
const probeKeys = new Set([
  "api",
  "apiKeyEnv",
  "baseURL",
  "id",
  "model",
  "modelCapabilities",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${label} contains unsupported field ${unknown[0]}`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function parseProbe(value: unknown, index: number): LiveProbeDefinition {
  const label = `Context live probe[${index}]`;
  const input = record(value, label);
  exactKeys(input, probeKeys, label);
  if (Object.hasOwn(input, "apiKey")) {
    throw new TypeError(`${label} must never contain a credential`);
  }
  const api = string(input.api, `${label}.api`);
  if (api !== "openai-chat-completions" && api !== "anthropic-messages") {
    throw new TypeError(`${label}.api is unsupported`);
  }
  const apiKeyEnv = string(input.apiKeyEnv, `${label}.apiKeyEnv`);
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(apiKeyEnv)) {
    throw new TypeError(`${label}.apiKeyEnv must name an uppercase environment variable`);
  }
  const capabilities = input.modelCapabilities;
  let modelCapabilities: LiveProbeDefinition["modelCapabilities"];
  if (capabilities !== undefined) {
    const parsed = record(capabilities, `${label}.modelCapabilities`);
    exactKeys(
      parsed,
      new Set(["contextWindowTokens", "maxOutputTokens"]),
      `${label}.modelCapabilities`,
    );
    modelCapabilities = {
      contextWindowTokens: positiveInteger(
        parsed.contextWindowTokens,
        `${label}.modelCapabilities.contextWindowTokens`,
      ),
      maxOutputTokens: positiveInteger(
        parsed.maxOutputTokens,
        `${label}.modelCapabilities.maxOutputTokens`,
      ),
    };
  }
  return {
    api,
    apiKeyEnv,
    baseURL: string(input.baseURL, `${label}.baseURL`),
    id: string(input.id, `${label}.id`),
    model: string(input.model, `${label}.model`),
    ...(modelCapabilities === undefined ? {} : { modelCapabilities }),
  };
}

function parseConfig(value: unknown): LiveProbeConfig {
  const input = record(value, "Context live probe config");
  exactKeys(input, configKeys, "Context live probe config");
  if (input.schemaVersion !== 1) {
    throw new TypeError("Context live probe config schema version is unsupported");
  }
  if (!Array.isArray(input.probes) || input.probes.length !== 2) {
    throw new TypeError("Context live probe config must contain exactly two probes");
  }
  const probes = input.probes.map(parseProbe);
  assert.deepEqual(
    [...probes.map((probe) => probe.api)].sort(),
    ["anthropic-messages", "openai-chat-completions"],
    "Context live probe config must contain one exact model for each protocol",
  );
  if (new Set(probes.map((probe) => probe.id)).size !== probes.length) {
    throw new TypeError("Context live probe IDs must be unique");
  }
  return { probes, schemaVersion: 1 };
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const matches = process.argv.slice(2).filter((item) => item.startsWith(prefix));
  if (matches.length > 1) throw new TypeError(`--${name} may be provided only once`);
  return matches[0]?.slice(prefix.length);
}

const knownPrefixes = [
  "--acknowledge-paid-requests=",
  "--config=",
  "--output=",
];
const unknownArgument = process.argv
  .slice(2)
  .find(
    (item) =>
      item !== "--" &&
      !knownPrefixes.some((prefix) => item.startsWith(prefix)),
  );
if (unknownArgument !== undefined) {
  throw new TypeError(`Unknown Context live probe argument ${unknownArgument}`);
}

const configPath = argument("config");
if (configPath === undefined) {
  throw new TypeError(
    "Context live probe requires --config=evals/context/live-probe.example.json",
  );
}
const config = parseConfig(JSON.parse(await readFile(resolve(configPath), "utf8")));
const corpus = await loadContextQualityCorpus();
const maximumPaidRequests = config.probes.length * corpus.cases.length;
process.stdout.write(
  `Context quality live preflight: exactly ${config.probes.length} models, ${corpus.cases.length} cases each, maximum ${maximumPaidRequests} paid compaction requests.\n`,
);
for (const probe of config.probes) {
  process.stdout.write(
    `  - ${probe.id}: ${probe.api} -> ${probe.model} at ${probe.baseURL}\n`,
  );
}
process.stdout.write(
  "Capability resolution may also perform bounded read-only metadata requests. No hidden retry or fallback is enabled.\n",
);

const outputRoot = join(repositoryRoot, ".artifacts", "context-quality");
const requestedOutput = argument("output");
const outputPath = requestedOutput === undefined
  ? join(outputRoot, `live-${new Date().toISOString().replaceAll(":", "-")}.json`)
  : resolve(requestedOutput);
const outputRelative = relative(outputRoot, outputPath);
if (
  outputRelative.length === 0 ||
  outputRelative.startsWith("..") ||
  isAbsolute(outputRelative)
) {
  throw new TypeError(`Context live report must be inside ${outputRoot}`);
}
try {
  await access(outputPath);
  throw new TypeError(`Refusing to overwrite existing Context live report ${outputPath}`);
} catch (error) {
  const code = typeof error === "object" &&
      error !== null &&
      "code" in error
    ? error.code
    : undefined;
  if (
    error instanceof TypeError ||
    code !== "ENOENT"
  ) {
    throw error;
  }
}

const acknowledgement = Number(argument("acknowledge-paid-requests"));
if (!Number.isSafeInteger(acknowledgement) || acknowledgement !== maximumPaidRequests) {
  throw new TypeError(
    `Refusing live probe: pass --acknowledge-paid-requests=${maximumPaidRequests} after reviewing the preflight`,
  );
}

// Credentials are intentionally read only after the exact paid-request count is
// acknowledged, and all required Keys are checked before the first network call.
const credentials = new Map<string, string>();
for (const probe of config.probes) {
  const apiKey = process.env[probe.apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new TypeError(`Context live probe is missing ${probe.apiKeyEnv}`);
  }
  credentials.set(probe.id, apiKey);
}

const probeReports: {
  accounting: readonly ModelAccounting[];
  cases: (ReturnType<typeof evaluateContextQualityCase> & {
    readonly syntheticHandoff: ContinuityHandoffBody;
  })[];
  id: string;
  modelCapabilities: ModelCapabilityProfile;
  protocol: LLMApi;
}[] = [];

for (const probe of config.probes) {
  const apiKey = credentials.get(probe.id);
  assert.ok(apiKey);
  const modelCapabilities = await resolveLLMModelCapabilities({
    api: probe.api,
    apiKey,
    baseURL: probe.baseURL,
    ...(probe.modelCapabilities === undefined
      ? {}
      : { explicit: probe.modelCapabilities }),
    model: probe.model,
  });
  const driver = createLLMModelDriver({
    api: probe.api,
    apiKey,
    baseURL: probe.baseURL,
    maxOutputTokens: modelCapabilities.maxOutputTokens,
    provider: probe.id,
  });
  const compact = driver.compact?.bind(driver);
  assert.ok(compact, `${probe.id} Driver does not support Context compaction`);
  const accepted = new Map<string, AcceptedContinuityHandoff>();
  const caseReports: (ReturnType<typeof evaluateContextQualityCase> & {
    readonly syntheticHandoff: ContinuityHandoffBody;
  })[] = [];
  const accounting: ModelAccounting[] = [];
  for (const testCase of corpus.cases) {
    const previous = testCase.previousCaseId === undefined
      ? null
      : accepted.get(testCase.previousCaseId) ?? null;
    if (testCase.previousCaseId !== undefined) {
      assert.ok(previous, `Missing live Handoff ${testCase.previousCaseId}`);
    }
    const effect = contextQualityCompactionEffect(
      testCase,
      probe.api,
      probe.model,
      previous,
      modelCapabilities,
    );
    const outcome = await compact(effect, contextQualityDriverContext);
    if (outcome.status !== "succeeded") {
      throw new Error(
        outcome.status === "cancelled"
          ? `${probe.id} ${testCase.id} was cancelled`
          : `${probe.id} ${testCase.id} failed: ${outcome.error.code}: ${outcome.error.message}`,
      );
    }
    const result = evaluateContextQualityCase(
      testCase,
      outcome.value,
      outcome.accounting?.usage?.inputTokens ?? null,
    );
    caseReports.push({ ...result, syntheticHandoff: outcome.value });
    accounting.push(outcome.accounting ?? { cost: null, usage: null });
    accepted.set(
      testCase.id,
      await acceptContextQualityHandoff(effect, outcome.value),
    );
  }
  probeReports.push({
    accounting,
    cases: caseReports,
    id: probe.id,
    modelCapabilities,
    protocol: probe.api,
  });
}

const report = {
  corpusRevision: corpus.revision,
  corpusSchemaVersion: corpus.schemaVersion,
  evaluatorVersion: CONTEXT_QUALITY_EVALUATOR_VERSION,
  maximumPaidRequests,
  pass: probeReports.every((probe) => probe.cases.every((item) => item.pass)),
  probes: probeReports,
  reportSchemaVersion: 3,
};
await mkdir(outputRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`Context quality live report: ${outputPath}\n`);
assert.equal(report.pass, true, "JX-AC-058 live Context quality gate failed");
