import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  artifactDigest,
  CONTINUITY_HANDOFF_MEDIA_TYPE,
  createContinuityHandoff,
  defineContextPolicy,
  estimateContextTokens,
  InMemoryEventStore,
  isJsonObject,
  parseContinuityHandoffBody,
} from "../../packages/core/src/index.ts";
import type {
  AcceptedContinuityHandoff,
  ContextCompactEffect,
  ContextCompactionInput,
  ContinuityHandoffBody,
  ContinuityHandoffFact,
  ModelContextSourceManifest,
  ModelDriverContext,
  ModelCapabilityProfile,
  ModelMessage,
} from "../../packages/core/src/index.ts";
import {
  createLLMModelDriver,
} from "../../packages/llm/src/index.ts";
import type {
  AnthropicMessagesClient,
  AnthropicMessagesRequest,
  LLMApi,
  OpenAIChatCompletionsClient,
} from "../../packages/llm/src/index.ts";

export const CONTEXT_QUALITY_CORPUS_SCHEMA_VERSION = 1;
export const CONTEXT_QUALITY_EVALUATOR_VERSION = 4;
export const contextQualityCorpusPath = fileURLToPath(
  new URL("../../evals/context/golden-thread-corpus.json", import.meta.url),
);

const arrayFields = [
  "acceptanceCriteria",
  "artifacts",
  "attemptedApproaches",
  "blockers",
  "completedEvidence",
  "constraints",
  "currentState",
  "decisions",
  "doNotRetry",
  "failures",
  "pendingEffects",
  "permissions",
  "rejectedAlternatives",
  "relevantFiles",
  "scope",
  "summary",
  "unresolvedQuestions",
  "validation",
  "waitsAndApprovals",
] as const;

const nullableFields = ["nextAction", "objective"] as const;

export type ContextQualityField =
  | (typeof arrayFields)[number]
  | (typeof nullableFields)[number];

export interface ContextQualityExpectation {
  readonly critical: boolean;
  readonly field: ContextQualityField;
  readonly id: string;
  readonly requiredTerms: readonly string[];
  readonly sourceEventIds: readonly string[];
}

export interface ContextQualitySourceEvent {
  readonly id: string;
  readonly text: string;
}

export interface ContextQualityCase {
  readonly description: string;
  readonly expectations: readonly ContextQualityExpectation[];
  readonly forbiddenTerms: readonly string[];
  readonly id: string;
  readonly previousCaseId?: string;
  readonly recordedBody: ContinuityHandoffBody;
  readonly sourceEvents: readonly ContextQualitySourceEvent[];
}

export interface ContextQualityCorpus {
  readonly cases: readonly ContextQualityCase[];
  readonly revision: string;
  readonly schemaVersion: 1;
}

export interface ContextQualityCaseResult {
  readonly caseId: string;
  readonly citationValidityPercent: number;
  readonly criticalFactRecallPercent: number;
  readonly estimatedSourceTokens: number;
  readonly expectedFactRecallPercent: number;
  readonly forbiddenClaims: readonly string[];
  readonly matchedCriticalFacts: number;
  readonly matchedExpectedFacts: number;
  readonly parseError: string | null;
  readonly pass: boolean;
  readonly providerReportedInputTokens: number | null;
  readonly totalCriticalFacts: number;
  readonly totalExpectedFacts: number;
  readonly unsupportedFacts: readonly string[];
}

export interface ContextQualityProtocolReport {
  readonly cases: readonly ContextQualityCaseResult[];
  readonly pass: boolean;
  readonly protocol: LLMApi;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be a string array`);
  }
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function parseExpectation(
  value: unknown,
  label: string,
  allowedSources: ReadonlySet<string>,
): ContextQualityExpectation {
  const input = record(value, label);
  const field = string(input.field, `${label}.field`);
  if (
    !arrayFields.includes(field as (typeof arrayFields)[number]) &&
    !nullableFields.includes(field as (typeof nullableFields)[number])
  ) {
    throw new TypeError(`${label}.field is unsupported`);
  }
  if (typeof input.critical !== "boolean") {
    throw new TypeError(`${label}.critical must be boolean`);
  }
  const sourceEventIds = stringArray(
    input.sourceEventIds,
    `${label}.sourceEventIds`,
  );
  for (const sourceId of sourceEventIds) {
    if (!allowedSources.has(sourceId)) {
      throw new TypeError(`${label} cites source outside the case`);
    }
  }
  return {
    critical: input.critical,
    field: field as ContextQualityField,
    id: string(input.id, `${label}.id`),
    requiredTerms: stringArray(input.requiredTerms, `${label}.requiredTerms`),
    sourceEventIds,
  };
}

function parseCase(value: unknown, index: number): ContextQualityCase {
  const label = `Context quality case[${index}]`;
  const input = record(value, label);
  if (!Array.isArray(input.sourceEvents) || input.sourceEvents.length === 0) {
    throw new TypeError(`${label}.sourceEvents must not be empty`);
  }
  const sourceEvents = input.sourceEvents.map((item, sourceIndex) => {
    const source = record(item, `${label}.sourceEvents[${sourceIndex}]`);
    return {
      id: string(source.id, `${label}.sourceEvents[${sourceIndex}].id`),
      text: string(source.text, `${label}.sourceEvents[${sourceIndex}].text`),
    };
  });
  const allowedSources = new Set(sourceEvents.map((source) => source.id));
  if (allowedSources.size !== sourceEvents.length) {
    throw new TypeError(`${label}.sourceEvents contains duplicate IDs`);
  }
  if (!Array.isArray(input.expectations) || input.expectations.length === 0) {
    throw new TypeError(`${label}.expectations must not be empty`);
  }
  const expectations = input.expectations.map((expectation, expectationIndex) =>
    parseExpectation(
      expectation,
      `${label}.expectations[${expectationIndex}]`,
      allowedSources,
    ),
  );
  const expectationIds = new Set(expectations.map((expectation) => expectation.id));
  if (expectationIds.size !== expectations.length) {
    throw new TypeError(`${label}.expectations contains duplicate IDs`);
  }
  const forbiddenTerms = input.forbiddenTerms === undefined
    ? []
    : stringList(input.forbiddenTerms, `${label}.forbiddenTerms`);
  const recordedBody = parseContinuityHandoffBody(
    input.recordedBody,
    [...allowedSources],
  );
  const previousCaseId = input.previousCaseId;
  if (previousCaseId !== undefined && typeof previousCaseId !== "string") {
    throw new TypeError(`${label}.previousCaseId must be a string`);
  }
  return {
    description: string(input.description, `${label}.description`),
    expectations,
    forbiddenTerms,
    id: string(input.id, `${label}.id`),
    ...(previousCaseId === undefined ? {} : { previousCaseId }),
    recordedBody,
    sourceEvents,
  };
}

export async function loadContextQualityCorpus(
  path = contextQualityCorpusPath,
): Promise<ContextQualityCorpus> {
  const source = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(source);
  const input = record(parsed, "Context quality corpus");
  if (input.schemaVersion !== CONTEXT_QUALITY_CORPUS_SCHEMA_VERSION) {
    throw new TypeError("Context quality corpus schema version is unsupported");
  }
  if (!Array.isArray(input.cases) || input.cases.length < 3) {
    throw new TypeError("Context quality corpus must contain at least three cases");
  }
  const cases = input.cases.map(parseCase);
  const caseIds = new Set<string>();
  const sourceTextByEventId = new Map<string, string>();
  for (const testCase of cases) {
    if (caseIds.has(testCase.id)) {
      throw new TypeError(`Duplicate Context quality case ${testCase.id}`);
    }
    if (
      testCase.previousCaseId !== undefined &&
      !caseIds.has(testCase.previousCaseId)
    ) {
      throw new TypeError(
        `Context quality case ${testCase.id} references a later or missing previous case`,
      );
    }
    for (const source of testCase.sourceEvents) {
      const previousText = sourceTextByEventId.get(source.id);
      if (previousText !== undefined && previousText !== source.text) {
        throw new TypeError(
          `Context quality corpus reuses Event ${source.id} with different text`,
        );
      }
      sourceTextByEventId.set(source.id, source.text);
    }
    caseIds.add(testCase.id);
  }
  return {
    cases,
    revision: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    schemaVersion: 1,
  };
}

function factsFor(
  body: ContinuityHandoffBody,
  field: ContextQualityField,
): readonly ContinuityHandoffFact[] {
  if (field === "nextAction" || field === "objective") {
    const fact = body[field];
    return fact === null ? [] : [fact];
  }
  return body[field];
}

const lexicalStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

function lexicalStem(value: string): string {
  if (!/^[a-z]+$/u.test(value)) return value;
  if (value.length > 6 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length > 5 && value.endsWith("ed")) return value.slice(0, -2);
  if (value.length > 5 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function lexicalTerms(value: string): ReadonlySet<string> {
  return new Set(
    (value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => term.length > 1 && !lexicalStopWords.has(term))
      .map(lexicalStem),
  );
}

function permissionPolarity(value: string): "negative" | "positive" | null {
  const normalized = value.normalize("NFKC").toLowerCase();
  const positive = /\b(?:allow(?:ed)?|authoriz(?:e|ed)|permit(?:ted)?)\b/u
    .test(normalized);
  const negative = /\b(?:disallow(?:ed)?|forbid(?:den)?|excluded?)\b/u
      .test(normalized) ||
    /\b(?:no|not|never)\b[^.;]{0,80}\b(?:allow(?:ed)?|authoriz(?:e|ed)|permit(?:ted)?|publish(?:ed|ing)?|publication|write|writing)\b/u
      .test(normalized);
  if (positive && negative) {
    const explicitlyMixed = /(?:;|\b(?:but|while|whereas)\b|\band\b[^.;]{0,40}\b(?:disallow(?:ed)?|forbid(?:den)?|excluded?)\b)/u
      .test(normalized);
    return explicitlyMixed ? null : "negative";
  }
  if (!positive && !negative) return null;
  return positive ? "positive" : "negative";
}

function permissionPolarityMatchesSource(
  factText: string,
  sourceText: string,
): boolean {
  const factPolarity = permissionPolarity(factText);
  if (factPolarity === null) return true;
  const factTerms = lexicalTerms(factText);
  const closestPolarity = sourceText
    .split(/(?:[.;]\s+|:\s+)/u)
    .map((clause) => ({
      overlap: [...lexicalTerms(clause)].filter((term) => factTerms.has(term)).length,
      polarity: permissionPolarity(clause),
    }))
    .sort((left, right) => right.overlap - left.overlap)
    .map((item) => item.polarity)
    .find((polarity) => polarity !== null);
  return closestPolarity === undefined || closestPolarity === factPolarity;
}

function lexicallySupportedBySources(
  text: string,
  sourceEventIds: readonly string[],
  sourceById: ReadonlyMap<string, ContextQualitySourceEvent>,
): boolean {
  const sources = sourceEventIds.map((id) => sourceById.get(id));
  if (sources.some((source) => source === undefined)) return false;
  const factTerms = lexicalTerms(text);
  const sourceTerms = lexicalTerms(
    sources.map((source) => source?.text ?? "").join("\n"),
  );
  if (factTerms.size === 0 || sourceTerms.size === 0) return false;
  const overlap = [...factTerms].filter((term) => sourceTerms.has(term)).length;
  const requiredOverlap = Math.max(
    2,
    Math.ceil(Math.min(factTerms.size, sourceTerms.size) * 0.25),
  );
  const sourceText = sources.map((source) => source?.text ?? "").join("\n");
  return overlap >= requiredOverlap &&
    permissionPolarityMatchesSource(text, sourceText);
}

function factMatches(
  fact: ContinuityHandoffFact,
  expectation: ContextQualityExpectation,
  sourceById: ReadonlyMap<string, ContextQualitySourceEvent>,
): boolean {
  const text = fact.text.toLowerCase();
  const citationsMatch = expectation.sourceEventIds.every((sourceId) =>
    fact.sourceEventIds.includes(sourceId),
  );
  if (!citationsMatch) return false;
  return expectation.requiredTerms.every((term) =>
    text.includes(term.toLowerCase()),
  ) || lexicallySupportedBySources(
    fact.text,
    expectation.sourceEventIds,
    sourceById,
  );
}

function matchingFacts(
  facts: readonly ContinuityHandoffFact[],
  expectation: ContextQualityExpectation,
  sourceById: ReadonlyMap<string, ContextQualitySourceEvent>,
): readonly ContinuityHandoffFact[] {
  const direct = facts.find((fact) =>
    factMatches(fact, expectation, sourceById)
  );
  if (direct !== undefined) return [direct];

  const expectedSources = new Set(expectation.sourceEventIds);
  const candidates = facts.filter((fact) =>
    fact.sourceEventIds.some((sourceId) => expectedSources.has(sourceId))
  );
  const citedSources = new Set(
    candidates.flatMap((fact) => [...fact.sourceEventIds]),
  );
  if (
    candidates.length < 2 ||
    expectation.sourceEventIds.some((sourceId) => !citedSources.has(sourceId))
  ) {
    return [];
  }
  const combinedText = candidates.map((fact) => fact.text).join("\n");
  const normalized = combinedText.toLowerCase();
  if (
    !expectation.requiredTerms.every((term) =>
      normalized.includes(term.toLowerCase())
    ) &&
    !lexicallySupportedBySources(
      combinedText,
      expectation.sourceEventIds,
      sourceById,
    )
  ) {
    return [];
  }
  return candidates;
}

function safelyReferencesForbiddenTerm(text: string): boolean {
  return /\b(?:do not|don['’]t|must not|never|untrusted|unsupported|unverified|reject(?:ed|ing)?|fabricat(?:e|ed|ion)|false|not (?:comply|complied|followed|true|verified)|no (?:such|verified)|excluded)\b/iu
    .test(text) ||
    /\bnot\b[^.;]{0,48}\b(?:true|verified)\b/iu
      .test(text) ||
    /\btreat(?:ed|ing)?\b[^.;]{0,48}\bas data\b/iu
    .test(text);
}

function percent(matched: number, total: number): number {
  return total === 0 ? 100 : (matched / total) * 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function evaluateContextQualityCase(
  testCase: ContextQualityCase,
  candidate: unknown,
  providerReportedInputTokens: number | null = null,
): ContextQualityCaseResult {
  const estimatedSourceTokens = estimateContextTokens(
    testCase.sourceEvents.map((source) => ({ content: source.text, role: "user" })),
  );
  let body: ContinuityHandoffBody;
  try {
    body = parseContinuityHandoffBody(
      candidate,
      testCase.sourceEvents.map((source) => source.id),
    );
  } catch (error) {
    return {
      caseId: testCase.id,
      citationValidityPercent: 0,
      criticalFactRecallPercent: 0,
      estimatedSourceTokens,
      expectedFactRecallPercent: 0,
      forbiddenClaims: [],
      matchedCriticalFacts: 0,
      matchedExpectedFacts: 0,
      parseError: errorMessage(error),
      pass: false,
      providerReportedInputTokens,
      totalCriticalFacts: testCase.expectations.filter((item) => item.critical).length,
      totalExpectedFacts: testCase.expectations.length,
      unsupportedFacts: [],
    };
  }

  const sourceById = new Map(
    testCase.sourceEvents.map((source) => [source.id, source] as const),
  );
  const matchedFacts = new Set<ContinuityHandoffFact>();
  let matchedExpectedFacts = 0;
  let matchedCriticalFacts = 0;
  for (const expectation of testCase.expectations) {
    const matches = matchingFacts(
      factsFor(body, expectation.field),
      expectation,
      sourceById,
    );
    if (matches.length === 0) continue;
    for (const match of matches) matchedFacts.add(match);
    matchedExpectedFacts += 1;
    if (expectation.critical) matchedCriticalFacts += 1;
  }

  const unsupportedFacts = [
    ...arrayFields.flatMap((field) =>
      factsFor(body, field)
        .filter((fact) =>
          !matchedFacts.has(fact) &&
          !lexicallySupportedBySources(fact.text, fact.sourceEventIds, sourceById),
        )
        .map((fact) => `${field}: ${fact.text}`),
    ),
    ...nullableFields.flatMap((field) =>
      factsFor(body, field)
        .filter((fact) =>
          !matchedFacts.has(fact) &&
          !lexicallySupportedBySources(fact.text, fact.sourceEventIds, sourceById),
        )
        .map((fact) => `${field}: ${fact.text}`),
    ),
  ];
  const allFacts = [
    ...arrayFields.flatMap((field) => factsFor(body, field)),
    ...nullableFields.flatMap((field) => factsFor(body, field)),
  ];
  const allowedSources = new Set(testCase.sourceEvents.map((source) => source.id));
  const validCitations = allFacts.filter((fact) =>
    fact.sourceEventIds.length > 0 &&
    fact.sourceEventIds.every((sourceId) => allowedSources.has(sourceId)),
  ).length;
  const forbiddenClaims = testCase.forbiddenTerms.filter((term) =>
    allFacts.some(
      (fact) =>
        fact.text.toLowerCase().includes(term.toLowerCase()) &&
        !safelyReferencesForbiddenTerm(fact.text),
    ),
  );
  const totalCriticalFacts = testCase.expectations.filter(
    (expectation) => expectation.critical,
  ).length;
  const expectedFactRecallPercent = percent(
    matchedExpectedFacts,
    testCase.expectations.length,
  );
  const criticalFactRecallPercent = percent(
    matchedCriticalFacts,
    totalCriticalFacts,
  );
  const citationValidityPercent = percent(validCitations, allFacts.length);
  return {
    caseId: testCase.id,
    citationValidityPercent,
    criticalFactRecallPercent,
    estimatedSourceTokens,
    expectedFactRecallPercent,
    forbiddenClaims,
    matchedCriticalFacts,
    matchedExpectedFacts,
    parseError: null,
    pass:
      expectedFactRecallPercent === 100 &&
      criticalFactRecallPercent === 100 &&
      citationValidityPercent === 100 &&
      unsupportedFacts.length === 0 &&
      forbiddenClaims.length === 0,
    providerReportedInputTokens,
    totalCriticalFacts,
    totalExpectedFacts: testCase.expectations.length,
    unsupportedFacts,
  };
}

class RecordedOpenAIClient implements OpenAIChatCompletionsClient {
  readonly #body: ContinuityHandoffBody;
  readonly #inputTokens: number;

  constructor(body: ContinuityHandoffBody, inputTokens: number) {
    this.#body = body;
    this.#inputTokens = inputTokens;
  }

  create(): Promise<AsyncIterable<unknown>> {
    const body = this.#body;
    const inputTokens = this.#inputTokens;
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: { content: JSON.stringify(body) },
              finish_reason: "stop",
              index: 0,
            },
          ],
        };
        yield {
          choices: [],
          usage: {
            completion_tokens: estimateContextTokens(body),
            prompt_tokens: inputTokens,
            total_tokens: inputTokens + estimateContextTokens(body),
          },
        };
      },
    });
  }
}

class RecordedAnthropicClient implements AnthropicMessagesClient {
  readonly #body: ContinuityHandoffBody;
  readonly #inputTokens: number;

  constructor(body: ContinuityHandoffBody, inputTokens: number) {
    this.#body = body;
    this.#inputTokens = inputTokens;
  }

  create(_body: AnthropicMessagesRequest): Promise<AsyncIterable<unknown>> {
    const body = this.#body;
    const inputTokens = this.#inputTokens;
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        yield {
          message: {
            content: [],
            usage: { input_tokens: inputTokens, output_tokens: 1 },
          },
          type: "message_start",
        };
        yield {
          content_block: { text: "", type: "text" },
          index: 0,
          type: "content_block_start",
        };
        yield {
          delta: { text: JSON.stringify(body), type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        };
        yield {
          delta: { stop_reason: "end_turn" },
          type: "message_delta",
          usage: { output_tokens: estimateContextTokens(body) },
        };
        yield { type: "message_stop" };
      },
    });
  }
}

function sourceMessages(testCase: ContextQualityCase): readonly ModelMessage[] {
  return testCase.sourceEvents.map((source) => ({
    content: source.text,
    role: "user" as const,
  }));
}

export function contextQualityCompactionEffect(
  testCase: ContextQualityCase,
  protocol: LLMApi,
  model: string,
  previousHandoff: AcceptedContinuityHandoff | null,
  modelCapabilities: ModelCapabilityProfile = {
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    resolvedModel: model,
    schemaVersion: 1,
    source: { kind: "explicit", name: "context-quality-probe" },
  },
): ContextCompactEffect {
  const messages = sourceMessages(testCase);
  const policy = defineContextPolicy({}, modelCapabilities);
  const sourceManifest: readonly ModelContextSourceManifest[] =
    testCase.sourceEvents.map((source, index) => ({
      causedByEventId: source.id,
      digest: null,
      disposition: "included",
      estimatedTokens: estimateContextTokens(messages[index]),
      id: `message:${source.id}`,
      kind: "message",
      priority: 100,
      reason: "context-quality-corpus",
      sensitivity: "private",
      trust: "accepted",
      version: "1",
    }));
  const input: ContextCompactionInput = {
    activePlan: null,
    clearBoundary: null,
    continuation: {
      eventId: testCase.sourceEvents.at(-1)?.id ?? "missing-source",
      reason: "input_received",
    },
    model: { model, provider: protocol },
    modelCapabilities,
    minimumInputTokens: estimateContextTokens(messages),
    nextEffectIndex: 1,
    policy,
    previousHandoff,
    sourceEventIds: testCase.sourceEvents.map((source) => source.id),
    sourceFromSequence: 1,
    sourceManifest,
    sourceMessageThroughSequence: testCase.sourceEvents.length,
    sourceMessages: messages,
    sourceThreadId: `quality-${protocol}`,
    sourceThroughSequence: testCase.sourceEvents.length,
    targetTokens: policy.rawTailTokens,
  };
  return {
    attempt: 1,
    id: `effect-${protocol}-${testCase.id}`,
    idempotencyKey: `quality:${protocol}:${testCase.id}`,
    input,
    requestedByEventId: input.continuation.eventId,
    threadId: input.sourceThreadId,
    type: "context.compact",
  };
}

export const contextQualityDriverContext: ModelDriverContext = {
  artifacts: new InMemoryEventStore(),
  cancellation: new AbortController().signal,
  signals: { emit: () => undefined },
};

export async function acceptContextQualityHandoff(
  effect: ContextCompactEffect,
  body: ContinuityHandoffBody,
): Promise<AcceptedContinuityHandoff> {
  const handoff = createContinuityHandoff(effect.input, body);
  const bytes = new TextEncoder().encode(JSON.stringify(handoff));
  return {
    artifact: {
      byteLength: bytes.byteLength,
      digest: await artifactDigest(bytes),
      mediaType: CONTINUITY_HANDOFF_MEDIA_TYPE,
    },
    handoff,
  };
}

export async function runRecordedProtocolFixtures(
  corpus: ContextQualityCorpus,
): Promise<readonly ContextQualityProtocolReport[]> {
  const protocols: readonly LLMApi[] = [
    "openai-chat-completions",
    "anthropic-messages",
  ];
  const reports: ContextQualityProtocolReport[] = [];
  for (const protocol of protocols) {
    const accepted = new Map<string, AcceptedContinuityHandoff>();
    const results: ContextQualityCaseResult[] = [];
    for (const testCase of corpus.cases) {
      const previous = testCase.previousCaseId === undefined
        ? null
        : accepted.get(testCase.previousCaseId) ?? null;
      if (testCase.previousCaseId !== undefined) {
        assert.ok(previous, `Missing previous fixture ${testCase.previousCaseId}`);
      }
      const inputTokens = estimateContextTokens(sourceMessages(testCase));
      const driver = protocol === "openai-chat-completions"
        ? createLLMModelDriver({
            api: protocol,
            baseURL: "https://fixture.invalid/v1",
            openAIChatCompletionsClient: new RecordedOpenAIClient(
              testCase.recordedBody,
              inputTokens,
            ),
            provider: "context-quality-fixture",
          })
        : createLLMModelDriver({
            anthropicMessagesClient: new RecordedAnthropicClient(
              testCase.recordedBody,
              inputTokens,
            ),
            api: protocol,
            baseURL: "https://fixture.invalid",
            maxOutputTokens: 4_096,
            provider: "context-quality-fixture",
          });
      const effect = contextQualityCompactionEffect(
        testCase,
        protocol,
        "context-quality-fixture",
        previous,
      );
      const compact = driver.compact?.bind(driver);
      assert.ok(compact, `${protocol} fixture Driver does not support compaction`);
      const outcome = await compact(effect, contextQualityDriverContext);
      if (outcome.status !== "succeeded") {
        throw new Error(
          outcome.status === "cancelled"
            ? `${protocol} ${testCase.id} fixture was cancelled`
            : `${protocol} ${testCase.id} fixture failed: ${outcome.error.message}`,
        );
      }
      const result = evaluateContextQualityCase(
        testCase,
        outcome.value,
        outcome.accounting?.usage?.inputTokens ?? null,
      );
      results.push(result);
      accepted.set(
        testCase.id,
        await acceptContextQualityHandoff(effect, outcome.value),
      );
    }
    reports.push({
      cases: results,
      pass: results.every((result) => result.pass),
      protocol,
    });
  }
  return reports;
}
