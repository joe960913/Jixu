import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  isJsonObject,
} from "../packages/core/src/index.ts";
import {
  MODEL_CAPABILITY_CATALOG,
  MODEL_CAPABILITY_CATALOG_REVISION,
  validateModelCapabilityCatalog,
} from "../packages/llm/src/model-capability-catalog.ts";
import {
  CONTEXT_QUALITY_EVALUATOR_VERSION,
  evaluateContextQualityCase,
  loadContextQualityCorpus,
  runRecordedProtocolFixtures,
} from "./lib/context-quality.ts";
import type {
  ContextQualityCorpus,
  ContextQualityProtocolReport,
} from "./lib/context-quality.ts";
import { repositoryRoot } from "./package-artifacts.ts";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const liveReportArguments = rawArgs.filter((argument) =>
  argument.startsWith("--live-report=")
);
if (liveReportArguments.length > 1) {
  throw new TypeError("--live-report may be provided only once");
}
for (const argument of args) {
  if (
    argument !== "--" &&
    argument !== "--json" &&
    !argument.startsWith("--live-report=")
  ) {
    throw new TypeError(`Unknown Context quality argument ${argument}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function replayInputTokens(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer or null`);
  }
  return value;
}

async function replayLiveReport(
  requestedPath: string,
  corpus: ContextQualityCorpus,
): Promise<{
  readonly path: string;
  readonly protocols: readonly ContextQualityProtocolReport[];
  readonly sourceEvaluatorVersion: number;
}> {
  const outputRoot = join(repositoryRoot, ".artifacts", "context-quality");
  const path = resolve(requestedPath);
  const outputRelative = relative(outputRoot, path);
  if (
    outputRelative.length === 0 ||
    outputRelative.startsWith("..") ||
    isAbsolute(outputRelative)
  ) {
    throw new TypeError(`Context live report must be inside ${outputRoot}`);
  }
  const input = record(
    JSON.parse(await readFile(path, "utf8")) as unknown,
    "Context live report",
  );
  if (input.reportSchemaVersion !== 3) {
    throw new TypeError("Context live report schema version is unsupported");
  }
  if (input.corpusSchemaVersion !== corpus.schemaVersion) {
    throw new TypeError("Context live report corpus schema does not match");
  }
  if (input.corpusRevision !== corpus.revision) {
    throw new TypeError("Context live report corpus revision does not match");
  }
  const sourceEvaluatorVersion = input.evaluatorVersion;
  if (
    typeof sourceEvaluatorVersion !== "number" ||
    !Number.isSafeInteger(sourceEvaluatorVersion) ||
    sourceEvaluatorVersion <= 0 ||
    sourceEvaluatorVersion > CONTEXT_QUALITY_EVALUATOR_VERSION
  ) {
    throw new TypeError("Context live report evaluator version is unsupported");
  }
  if (!Array.isArray(input.probes) || input.probes.length !== 2) {
    throw new TypeError("Context live report must contain exactly two probes");
  }
  const protocols = input.probes.map(
    (value, probeIndex): ContextQualityProtocolReport => {
      const probe = record(value, `Context live report probe[${probeIndex}]`);
      const protocol = probe.protocol;
      if (
        protocol !== "openai-chat-completions" &&
        protocol !== "anthropic-messages"
      ) {
        throw new TypeError(
          `Context live report probe[${probeIndex}] protocol is unsupported`,
        );
      }
      if (
        !Array.isArray(probe.cases) ||
        probe.cases.length !== corpus.cases.length
      ) {
        throw new TypeError(
          `Context live report probe[${probeIndex}] has an invalid case count`,
        );
      }
      const casesById = new Map(
        probe.cases.map((item, caseIndex) => {
          const candidate = record(
            item,
            `Context live report probe[${probeIndex}].cases[${caseIndex}]`,
          );
          if (typeof candidate.caseId !== "string") {
            throw new TypeError("Context live report caseId must be a string");
          }
          return [candidate.caseId, candidate] as const;
        }),
      );
      if (casesById.size !== corpus.cases.length) {
        throw new TypeError(
          `Context live report probe[${probeIndex}] repeats a case`,
        );
      }
      const cases = corpus.cases.map((testCase) => {
        const candidate = casesById.get(testCase.id);
        if (candidate === undefined) {
          throw new TypeError(
            `Context live report is missing case ${testCase.id}`,
          );
        }
        return evaluateContextQualityCase(
          testCase,
          candidate.syntheticHandoff,
          replayInputTokens(
            candidate.providerReportedInputTokens,
            `Context live report ${testCase.id}.providerReportedInputTokens`,
          ),
        );
      });
      return {
        cases,
        pass: cases.every((result) => result.pass),
        protocol,
      };
    },
  );
  assert.deepEqual(
    [...protocols.map((item) => item.protocol)].sort(),
    ["anthropic-messages", "openai-chat-completions"],
    "Context live report must contain both protocol shapes",
  );
  return { path, protocols, sourceEvaluatorVersion };
}

validateModelCapabilityCatalog();
const corpus = await loadContextQualityCorpus();
const liveReportPath = liveReportArguments[0]?.slice("--live-report=".length);
if (liveReportPath !== undefined && liveReportPath.length === 0) {
  throw new TypeError("--live-report must name a report path");
}
const replay = liveReportPath === undefined
  ? null
  : await replayLiveReport(liveReportPath, corpus);
const protocols = replay?.protocols ?? await runRecordedProtocolFixtures(corpus);
const report = {
  catalogue: {
    entries: MODEL_CAPABILITY_CATALOG.length,
    revision: MODEL_CAPABILITY_CATALOG_REVISION,
  },
  corpus: {
    cases: corpus.cases.length,
    revision: corpus.revision,
    schemaVersion: corpus.schemaVersion,
  },
  evaluatorVersion: CONTEXT_QUALITY_EVALUATOR_VERSION,
  pass: protocols.every((protocol) => protocol.pass),
  protocols,
  ...(replay === null
    ? {}
    : {
        replay: {
          reportSchemaVersion: 3,
          sourceEvaluatorVersion: replay.sourceEvaluatorVersion,
        },
      }),
};

if (args.has("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write("JX-AC-058 Context quality and catalogue maintenance gate\n");
  process.stdout.write(`  evaluator v${report.evaluatorVersion}\n`);
  process.stdout.write(`  corpus ${report.corpus.revision}\n`);
  if (replay !== null) {
    process.stdout.write(
      `  replayed schema 3 live report from evaluator v${replay.sourceEvaluatorVersion}\n`,
    );
  }
  process.stdout.write(
    `  ✓ catalogue ${report.catalogue.revision}: ${report.catalogue.entries} source-linked entries\n`,
  );
  for (const protocol of protocols) {
    process.stdout.write(`  ${protocol.pass ? "✓" : "✗"} ${protocol.protocol}\n`);
    for (const result of protocol.cases) {
      process.stdout.write(
        `    ${result.pass ? "✓" : "✗"} ${result.caseId}: recall ${result.expectedFactRecallPercent.toFixed(0)}%, critical ${result.criticalFactRecallPercent.toFixed(0)}%, citations ${result.citationValidityPercent.toFixed(0)}%, estimate ${result.estimatedSourceTokens} tokens, provider usage ${result.providerReportedInputTokens ?? "unavailable"}\n`,
      );
    }
  }
  process.stdout.write(
    report.pass
      ? replay === null
        ? "JX-AC-058 passed: both protocol fixtures preserve every expected source-linked fact.\n"
        : "JX-AC-058 passed: saved live evidence satisfies the current deterministic evaluator.\n"
      : "JX-AC-058 failed: inspect the reported Context quality metrics.\n",
  );
}

assert.equal(report.pass, true, "JX-AC-058 Context quality gate failed");
