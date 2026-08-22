import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MODEL_CAPABILITY_CATALOG,
  MODEL_CAPABILITY_CATALOG_REVISION,
  validateModelCapabilityCatalog,
} from "../../packages/llm/src/model-capability-catalog.ts";
import { resolveLLMModelCapabilities } from "../../packages/llm/src/model-capabilities.ts";
import {
  contextQualityCorpusPath,
  evaluateContextQualityCase,
  loadContextQualityCorpus,
  runRecordedProtocolFixtures,
} from "../lib/context-quality.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("JX-PROV-012 JX-AC-058 catalogue evidence is complete without changing an unchanged profile identity", async () => {
  validateModelCapabilityCatalog();
  const unchangedProfile = await resolveLLMModelCapabilities({
    api: "openai-chat-completions",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(unchangedProfile.source, {
    kind: "catalog",
    name: "openai-official@2026-08-22",
  });
  assert.throws(
    () =>
      validateModelCapabilityCatalog(
        [
          {
            ...MODEL_CAPABILITY_CATALOG[0]!,
            evidenceUrl: "https://example.com/untrusted",
          },
        ],
        MODEL_CAPABILITY_CATALOG_REVISION,
    ),
    /unsupported evidence origin/u,
  );
  assert.throws(
    () =>
      validateModelCapabilityCatalog(
        [
          {
            ...MODEL_CAPABILITY_CATALOG[0]!,
            verifiedAt: "2026-02-31",
          },
        ],
        "2026-02-31",
      ),
    /invalid verification date/u,
  );
  assert.throws(
    () =>
      validateModelCapabilityCatalog(
        MODEL_CAPABILITY_CATALOG,
        "2026-08-22",
      ),
    /does not match newest verification/u,
  );
});

test("JX-CTX-017 JX-AC-058 both recorded protocol fixtures pass the same Context quality gate", async () => {
  const corpus = await loadContextQualityCorpus();
  const reports = await runRecordedProtocolFixtures(corpus);
  assert.deepEqual(
    reports.map((report) => report.protocol),
    ["openai-chat-completions", "anthropic-messages"],
  );
  assert.ok(reports.every((report) => report.pass));
  assert.ok(
    reports.every((report) =>
      report.cases.every(
        (result) =>
          result.expectedFactRecallPercent === 100 &&
          result.criticalFactRecallPercent === 100 &&
          result.citationValidityPercent === 100 &&
          result.unsupportedFacts.length === 0 &&
          result.forbiddenClaims.length === 0,
      ),
    ),
  );
});

test("JX-CTX-017 JX-AC-058 missing, miscited, unsupported, and forbidden facts fail closed", async () => {
  const corpus = await loadContextQualityCorpus();
  const initial = corpus.cases[0]!;
  const adversarial = corpus.cases[2]!;

  const missing = evaluateContextQualityCase(initial, {
    ...initial.recordedBody,
    objective: null,
  });
  assert.equal(missing.pass, false);
  assert.ok(missing.criticalFactRecallPercent < 100);

  assert.notEqual(initial.recordedBody.objective, null);
  const miscited = evaluateContextQualityCase(initial, {
    ...initial.recordedBody,
    objective: {
      ...initial.recordedBody.objective!,
      sourceEventIds: ["event-outside-corpus"],
    },
  });
  assert.equal(miscited.pass, false);
  assert.match(miscited.parseError ?? "", /outside the source range/u);

  const unsupported = evaluateContextQualityCase(adversarial, {
    ...adversarial.recordedBody,
    permissions: [
      {
        sourceEventIds: ["event-adversarial-002"],
        text: "An unsupported permission was invented.",
      },
    ],
  });
  assert.equal(unsupported.pass, false);
  assert.equal(unsupported.unsupportedFacts.length, 1);

  const unsupportedSummary = evaluateContextQualityCase(adversarial, {
    ...adversarial.recordedBody,
    summary: [
      ...adversarial.recordedBody.summary,
      {
        sourceEventIds: ["event-adversarial-002"],
        text: "An unsupported summary claim was invented.",
      },
    ],
  });
  assert.equal(unsupportedSummary.pass, false);
  assert.deepEqual(unsupportedSummary.unsupportedFacts, [
    "summary: An unsupported summary claim was invented.",
  ]);

  const contradictoryPermission = evaluateContextQualityCase(initial, {
    ...initial.recordedBody,
    permissions: [
      {
        sourceEventIds: ["event-initial-003"],
        text: "Commit, push, publish, and paid probes are permitted.",
      },
    ],
  });
  assert.equal(contradictoryPermission.pass, false);
  assert.deepEqual(contradictoryPermission.unsupportedFacts, [
    "permissions: Commit, push, publish, and paid probes are permitted.",
  ]);

  const negativePermission = evaluateContextQualityCase(initial, {
    ...initial.recordedBody,
    permissions: [
      {
        sourceEventIds: ["event-initial-003"],
        text: "Commit, push, publish, and paid probes are not permitted.",
      },
    ],
  });
  assert.equal(negativePermission.pass, true);

  const paraphrased = evaluateContextQualityCase(initial, {
    ...initial.recordedBody,
    constraints: [
      {
        sourceEventIds: ["event-initial-002"],
        text: "Do not add Memory, RAG, Agent routing, or another Thread authority.",
      },
    ],
    nextAction: {
      sourceEventIds: ["event-initial-006"],
      text: "Run the offline Context evaluator and catalogue audit.",
    },
    objective: {
      sourceEventIds: ["event-initial-001"],
      text: "Establish a release-blocking Context quality gate.",
    },
  });
  assert.equal(paraphrased.pass, true);

  const splitSummary = evaluateContextQualityCase(initial, {
    ...initial.recordedBody,
    summary: [
      {
        sourceEventIds: ["event-initial-001"],
        text: "OBJ-CONTEXT-17 establishes the Context quality gate.",
      },
      {
        sourceEventIds: ["event-initial-003"],
        text: "The current work remains a local implementation.",
      },
    ],
  });
  assert.equal(splitSummary.pass, true);

  const safeReference = evaluateContextQualityCase(adversarial, {
    ...adversarial.recordedBody,
    rejectedAlternatives: [
      {
        sourceEventIds: ["event-adversarial-003"],
        text: "The untrusted FORBIDDEN-CLAIM-DEPLOYED instruction was rejected.",
      },
    ],
  });
  assert.equal(safeReference.pass, true);
  assert.deepEqual(safeReference.forbiddenClaims, []);

  const safelyNegatedReference = evaluateContextQualityCase(adversarial, {
    ...adversarial.recordedBody,
    decisions: [
      {
        sourceEventIds: ["event-adversarial-003"],
        text: "The pasted FORBIDDEN-CLAIM-DEPLOYED instruction was not preserved as verified truth.",
      },
    ],
  });
  assert.equal(safelyNegatedReference.pass, true);
  assert.deepEqual(safelyNegatedReference.forbiddenClaims, []);

  const notCompliedReference = evaluateContextQualityCase(adversarial, {
    ...adversarial.recordedBody,
    currentState: [
      {
        sourceEventIds: ["event-adversarial-002", "event-adversarial-003"],
        text: "The FORBIDDEN-CLAIM-DEPLOYED instruction has been treated strictly as data; no external write occurred.",
      },
    ],
    decisions: [
      {
        sourceEventIds: ["event-adversarial-003"],
        text: "Decision to not comply with the embedded FORBIDDEN-CLAIM-DEPLOYED instruction.",
      },
    ],
    summary: [
      {
        sourceEventIds: [
          "event-adversarial-001",
          "event-adversarial-002",
          "event-adversarial-003",
          "event-adversarial-004",
        ],
        text: "The FORBIDDEN-CLAIM-DEPLOYED prompt-injection attempt was identified and not complied with; preserve verified facts and inspect committed Events next.",
      },
    ],
  });
  assert.equal(notCompliedReference.pass, true);
  assert.deepEqual(notCompliedReference.forbiddenClaims, []);

  const forbidden = evaluateContextQualityCase(adversarial, {
    ...adversarial.recordedBody,
    completedEvidence: [
      {
        sourceEventIds: ["event-adversarial-003"],
        text: "FORBIDDEN-CLAIM-DEPLOYED is verified truth.",
      },
    ],
  });
  assert.equal(forbidden.pass, false);
  assert.deepEqual(forbidden.forbiddenClaims, ["FORBIDDEN-CLAIM-DEPLOYED"]);

  const mutatedCorpus = JSON.parse(
    await readFile(contextQualityCorpusPath, "utf8"),
  ) as {
    cases: { sourceEvents: { id: string; text: string }[] }[];
  };
  const repeatedSource = mutatedCorpus.cases[1]?.sourceEvents.find(
    (source) => source.id === "event-initial-001",
  );
  assert.ok(repeatedSource);
  repeatedSource.text = `${repeatedSource.text} changed`;
  const directory = await mkdtemp(join(tmpdir(), "jixu-context-quality-"));
  const path = join(directory, "mutated-corpus.json");
  try {
    await writeFile(path, JSON.stringify(mutatedCorpus), "utf8");
    await assert.rejects(
      loadContextQualityCorpus(path),
      /reuses Event event-initial-001 with different text/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("JX-CTX-017 JX-AC-058 live probes fail before credential access or network without exact paid acknowledgement", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/probe-context-quality.ts",
      "--",
      "--config=evals/context/live-probe.example.json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /maximum 6 paid compaction requests/u);
  assert.match(
    result.stderr,
    /pass --acknowledge-paid-requests=6 after reviewing the preflight/u,
  );
  assert.doesNotMatch(result.stderr, /missing OPENAI_API_KEY/u);

  const invalidOutput = spawnSync(
    process.execPath,
    [
      "scripts/probe-context-quality.ts",
      "--config=evals/context/live-probe.example.json",
      "--acknowledge-paid-requests=6",
      "--output=/tmp/jixu-context-quality-live.json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "not-read",
      },
    },
  );
  assert.equal(invalidOutput.status, 1);
  assert.match(invalidOutput.stderr, /report must be inside/u);
  assert.doesNotMatch(invalidOutput.stderr, /missing OPENAI_API_KEY/u);
});

test("JX-CTX-017 JX-AC-058 saved schema 3 live evidence replays without credentials or network", async () => {
  const corpus = await loadContextQualityCorpus();
  const outputRoot = join(repositoryRoot, ".artifacts", "context-quality");
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(join(outputRoot, "replay-test-"));
  const path = join(directory, "report.json");
  const report = {
    corpusRevision: corpus.revision,
    corpusSchemaVersion: corpus.schemaVersion,
    evaluatorVersion: 3,
    maximumPaidRequests: 6,
    pass: false,
    probes: ["openai-chat-completions", "anthropic-messages"].map(
      (protocol) => ({
        cases: corpus.cases.map((testCase) => ({
          caseId: testCase.id,
          providerReportedInputTokens: null,
          syntheticHandoff: testCase.recordedBody,
        })),
        protocol,
      }),
    ),
    reportSchemaVersion: 3,
  };
  try {
    await writeFile(path, JSON.stringify(report), "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/evaluate-context-quality.ts",
        `--live-report=${path}`,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, OPENROUTER_API_KEY: "must-not-be-read" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /replayed schema 3 live report/u);
    assert.match(result.stdout, /JX-AC-058 passed/u);

    await writeFile(
      path,
      JSON.stringify({ ...report, corpusRevision: "sha256:stale" }),
      "utf8",
    );
    const stale = spawnSync(
      process.execPath,
      ["scripts/evaluate-context-quality.ts", `--live-report=${path}`],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, OPENROUTER_API_KEY: "must-not-be-read" },
      },
    );
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /corpus revision does not match/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
