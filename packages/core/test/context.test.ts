import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTINUITY_HANDOFF_MEDIA_TYPE,
  compileContext,
  createContinuityHandoff,
  createHarness,
  createInitialThreadState,
  defineAgent,
  InMemoryEventStore,
  replayEvents,
} from "../src/index.ts";
import type {
  AnyThreadEvent,
  ArtifactReference,
  Checkpoint,
  ContextCompactEffect,
  ContextCompactionOutcome,
  ContinuityHandoffBody,
  EventStore,
  ModelDriver,
  ModelGenerateEffect,
  ModelOutcome,
  PlanSnapshot,
  ThreadState,
} from "../src/index.ts";
import {
  FixedClock,
  SequenceIdGenerator,
  succeed,
} from "../../testkit/src/index.ts";

const TEST_MODEL_CAPABILITIES = {
  contextWindowTokens: 4_096,
  maxOutputTokens: 512,
  resolvedModel: "deterministic",
  source: { kind: "explicit", name: "context-test" },
} as const;

class ContextDriver implements ModelDriver {
  readonly compactions: ContextCompactEffect[] = [];
  readonly generations: ModelGenerateEffect[] = [];
  readonly #replies: string[];

  constructor(replies: readonly string[]) {
    this.#replies = [...replies];
  }

  async compact(
    effect: ContextCompactEffect,
  ): Promise<ContextCompactionOutcome> {
    this.compactions.push(structuredClone(effect));
    const sourceEventId = effect.input.sourceEventIds[0];
    assert.notEqual(sourceEventId, undefined);
    const fact = {
      sourceEventIds: [sourceEventId ?? "unreachable"],
      text: "The accepted source history must remain available through this Handoff.",
    };
    const body: ContinuityHandoffBody = {
      acceptanceCriteria: [fact],
      artifacts: [],
      attemptedApproaches: [fact],
      blockers: [],
      completedEvidence: [fact],
      constraints: [fact],
      currentState: [fact],
      decisions: [fact],
      doNotRetry: [fact],
      failures: [fact],
      nextAction: fact,
      objective: fact,
      pendingEffects: [],
      permissions: [fact],
      rejectedAlternatives: [fact],
      relevantFiles: [],
      scope: [fact],
      summary: [fact],
      unresolvedQuestions: [],
      validation: [fact],
      waitsAndApprovals: [],
    };
    return succeed(body);
  }

  async generate(effect: ModelGenerateEffect): Promise<ModelOutcome> {
    this.generations.push(structuredClone(effect));
    const reply = this.#replies.shift();
    if (reply === undefined) throw new Error("ContextDriver has no reply");
    return succeed({ content: reply, toolCalls: [] });
  }
}

class RejectHandoffArtifactStore implements EventStore {
  readonly #inner = new InMemoryEventStore();

  append(
    threadId: string,
    expectedRevision: number,
    event: AnyThreadEvent,
  ): Promise<void> {
    return this.#inner.append(threadId, expectedRevision, event);
  }

  createFork(threadId: string, events: readonly AnyThreadEvent[]): Promise<void> {
    return this.#inner.createFork(threadId, events);
  }

  createThread(threadId: string): Promise<void> {
    return this.#inner.createThread(threadId);
  }

  listThreads(): Promise<readonly string[]> {
    return this.#inner.listThreads();
  }

  putArtifact(reference: ArtifactReference, bytes: Uint8Array): Promise<void> {
    if (reference.mediaType === CONTINUITY_HANDOFF_MEDIA_TYPE) {
      return Promise.reject(new Error("simulated Handoff Artifact outage"));
    }
    return this.#inner.putArtifact(reference, bytes);
  }

  read(
    threadId: string,
    fromSequence?: number,
  ): Promise<readonly AnyThreadEvent[]> {
    return this.#inner.read(threadId, fromSequence);
  }

  readArtifact(reference: ArtifactReference): Promise<Uint8Array> {
    return this.#inner.readArtifact(reference);
  }

  readCheckpoint(threadId: string): Promise<Checkpoint | null> {
    return this.#inner.readCheckpoint(threadId);
  }

  writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.#inner.writeCheckpoint(checkpoint);
  }
}

class CrashBeforeCompactedEventStore implements EventStore {
  readonly #inner: EventStore;
  #crashed = false;

  constructor(inner: EventStore) {
    this.#inner = inner;
  }

  append(
    threadId: string,
    expectedRevision: number,
    event: AnyThreadEvent,
  ): Promise<void> {
    if (!this.#crashed && event.type === "context.compacted") {
      this.#crashed = true;
      return Promise.reject(new Error("simulated process stop"));
    }
    return this.#inner.append(threadId, expectedRevision, event);
  }

  createFork(threadId: string, events: readonly AnyThreadEvent[]): Promise<void> {
    return this.#inner.createFork(threadId, events);
  }

  createThread(threadId: string): Promise<void> {
    return this.#inner.createThread(threadId);
  }

  listThreads(): Promise<readonly string[]> {
    return this.#inner.listThreads();
  }

  putArtifact(reference: ArtifactReference, bytes: Uint8Array): Promise<void> {
    return this.#inner.putArtifact(reference, bytes);
  }

  read(
    threadId: string,
    fromSequence?: number,
  ): Promise<readonly AnyThreadEvent[]> {
    return this.#inner.read(threadId, fromSequence);
  }

  readArtifact(reference: ArtifactReference): Promise<Uint8Array> {
    return this.#inner.readArtifact(reference);
  }

  readCheckpoint(threadId: string): Promise<Checkpoint | null> {
    return this.#inner.readCheckpoint(threadId);
  }

  writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.#inner.writeCheckpoint(checkpoint);
  }
}

function boundedAgent() {
  return defineAgent({
    context: {
      rawTailTokens: 512,
      reservedOutputTokens: 512,
      safetyMarginTokens: 256,
    },
    instructions: "Preserve durable continuity and answer precisely.",
    model: { model: "deterministic", provider: "mock" },
    modelCapabilities: TEST_MODEL_CAPABILITIES,
  });
}

function minimalHandoffBody(
  sourceEventId: string,
): ContinuityHandoffBody {
  const fact = {
    sourceEventIds: [sourceEventId],
    text: "Preserve the accepted continuity boundary.",
  };
  return {
    acceptanceCriteria: [],
    artifacts: [],
    attemptedApproaches: [],
    blockers: [],
    completedEvidence: [],
    constraints: [],
    currentState: [],
    decisions: [],
    doNotRetry: [],
    failures: [],
    nextAction: null,
    objective: fact,
    pendingEffects: [],
    permissions: [],
    rejectedAlternatives: [],
    relevantFiles: [],
    scope: [],
    summary: [fact],
    unresolvedQuestions: [],
    validation: [],
    waitsAndApprovals: [],
  };
}

test("JX-AC-054 a verified 1.05M model compiles against its real capacity", async () => {
  const driver = new ContextDriver(["large-context reply"]);
  const agent = defineAgent({
    instructions: "Use the verified model capacity.",
    model: { model: "gpt-5.6-sol", provider: "mock" },
    modelCapabilities: {
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      resolvedModel: "gpt-5.6-sol",
      source: { kind: "catalog", name: "openai-official@fixture" },
    },
  });
  const policy = agent.snapshot.contextPolicy;
  assert.notEqual(policy, undefined);
  assert.equal(policy?.contextWindowTokens, 1_050_000);
  assert.equal(policy?.reservedOutputTokens, 4_096);

  const thread = await createHarness({
    agent,
    modelDrivers: { mock: driver },
  }).createThread();
  await thread.send("Keep the full verified context available.");

  const manifest = driver.generations[0]?.input.contextManifest;
  assert.equal(manifest?.modelCapabilities.contextWindowTokens, 1_050_000);
  assert.equal(manifest?.inputBudgetTokens, 1_043_856);
  assert.equal(manifest?.outputBudgetTokens, 4_096);
});

test("JX-AC-022 JX-AC-023 Plan source range does not hide a later selected raw-tail message", () => {
  const agent = boundedAgent();
  const oldHandoff = {
    activePlan: null,
    body: minimalHandoffBody("event-old-input"),
    model: agent.snapshot.model,
    previousHandoffDigest: null,
    schemaVersion: 1 as const,
    source: {
      clearBoundary: null,
      compilerVersion: 2 as const,
      eventIds: ["event-old-input"],
      fromSequence: 2,
      messageThroughSequence: 2,
      threadId: "thread-plan-boundary",
      throughSequence: 2,
    },
  };
  const activePlan: PlanSnapshot = {
    acceptanceCriteria: ["The raw tail remains visible"],
    assumptions: [],
    blockers: [],
    id: "plan-boundary",
    nextAction: "Continue with the raw tail",
    objective: "Preserve Plan and raw-tail causality",
    revision: 1,
    schemaVersion: 1,
    status: "active",
    steps: [
      {
        description: "Compile bounded Context",
        evidence: [],
        id: "compile",
        status: "in_progress",
      },
    ],
  };
  const state: ThreadState = {
    ...createInitialThreadState("thread-plan-boundary"),
    acceptedHandoff: {
      artifact: {
        byteLength: 100,
        digest: `sha256:${"a".repeat(64)}`,
        mediaType: CONTINUITY_HANDOFF_MEDIA_TYPE,
      },
      handoff: oldHandoff,
    },
    activePlan,
    activePlanSource: { eventId: "event-plan", sequence: 10 },
    agent: agent.snapshot,
    messages: [
      { content: "old represented input", role: "user" },
      {
        content: `large completed operation ${"h".repeat(15_000)}`,
        role: "assistant",
        toolCalls: [],
      },
      { content: "keep this recent raw message", role: "user" },
    ],
    messageSources: [
      { eventId: "event-old-input", sequence: 2 },
      { eventId: "event-large", sequence: 6 },
      { eventId: "event-raw-tail", sequence: 8 },
    ],
    revision: 10,
    status: "running",
  };
  const continuation = {
    eventId: "event-plan",
    plan: activePlan,
    reason: "plan_updated" as const,
  };

  const compact = compileContext(state, continuation);
  assert.equal(compact.kind, "compaction");
  if (compact.kind !== "compaction") return;
  assert.equal(compact.input.sourceThroughSequence, 10);
  assert.equal(compact.input.sourceMessageThroughSequence, 6);
  assert.ok(compact.input.sourceEventIds.includes("event-plan"));
  assert.deepEqual(compact.input.sourceMessages, [state.messages[1]]);

  const handoff = createContinuityHandoff(
    compact.input,
    minimalHandoffBody("event-old-input"),
  );
  const resumed = compileContext(
    {
      ...state,
      acceptedHandoff: {
        artifact: {
          byteLength: 100,
          digest: `sha256:${"b".repeat(64)}`,
          mediaType: CONTINUITY_HANDOFF_MEDIA_TYPE,
        },
        handoff,
      },
    },
    continuation,
  );
  assert.equal(resumed.kind, "model");
  if (resumed.kind !== "model") return;
  assert.deepEqual(resumed.input.messages, [state.messages[2]]);
});

test("JX-AC-023 JX-AC-024 JX-AC-025 JX-AC-026 bounded Context compacts durably and survives Replay and Fork", async () => {
  const store = new InMemoryEventStore();
  const driver = new ContextDriver([
    "first parent reply",
    "second parent reply",
    "child reply",
  ]);
  const thread = await createHarness({
    agent: boundedAgent(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: driver },
    store,
  }).createThread();

  const firstState = await thread.send(`retain this history ${"x".repeat(15_000)}`);
  const firstEvents = await thread.events();
  const compacted = firstEvents.find((event) => event.type === "context.compacted");
  assert.notEqual(compacted, undefined);
  if (compacted === undefined || compacted.type !== "context.compacted") return;

  assert.deepEqual(
    firstEvents.map((event) => event.type),
    [
      "thread.created",
      "input.received",
      "context.compaction_requested",
      "context.compacted",
      "model.requested",
      "model.completed",
    ],
  );
  assert.equal(driver.compactions.length, 1);
  assert.equal(driver.generations.length, 1);
  assert.equal(firstState.acceptedHandoff?.artifact.digest, compacted.payload.artifact.digest);
  assert.equal(
    new TextDecoder().decode(await store.readArtifact(compacted.payload.artifact)),
    JSON.stringify(compacted.payload.handoff),
  );
  const generated = driver.generations[0];
  assert.equal(generated?.input.messages.length, 0);
  assert.equal(
    generated?.input.continuityHandoff?.body.summary[0]?.sourceEventIds[0],
    firstEvents[1]?.id,
  );
  assert.ok(
    (generated?.input.contextManifest?.estimatedInputTokens ?? Infinity) <=
      (generated?.input.contextManifest?.inputBudgetTokens ?? 0),
  );
  assert.deepEqual(replayEvents(thread.id, firstEvents), firstState);

  const parentState = await thread.send(
    `merge the next phase ${"z".repeat(15_000)}`,
  );
  const parentEvents = await thread.events();
  const compactions = parentEvents.filter(
    (event) => event.type === "context.compacted",
  );
  assert.equal(compactions.length, 2);
  const replacement = compactions[1];
  assert.notEqual(replacement, undefined);
  if (replacement === undefined || replacement.type !== "context.compacted") return;
  assert.equal(driver.compactions.length, 2);
  assert.equal(driver.generations.length, 2);
  const requestedEffectIds = parentEvents.flatMap((event) =>
    event.type === "context.compaction_requested" || event.type === "model.requested"
      ? [event.payload.effect.id]
      : [],
  );
  assert.equal(new Set(requestedEffectIds).size, requestedEffectIds.length);
  assert.equal(
    replacement.payload.handoff.previousHandoffDigest,
    compacted.payload.artifact.digest,
  );
  assert.equal(
    replacement.payload.handoff.body.doNotRetry[0]?.sourceEventIds[0],
    firstEvents[1]?.id,
  );
  assert.equal(
    replacement.payload.handoff.body.completedEvidence[0]?.text,
    compacted.payload.handoff.body.completedEvidence[0]?.text,
  );
  assert.deepEqual(replayEvents(thread.id, parentEvents), parentState);

  const forkPoint = parentEvents.at(-1);
  assert.notEqual(forkPoint, undefined);
  if (forkPoint === undefined) return;
  const child = await thread.fork({ at: forkPoint.id, input: "continue from it" });
  const childState = await child.wait();
  assert.equal(childState.result, "child reply");
  assert.deepEqual(
    childState.agent?.modelCapabilities,
    parentState.agent?.modelCapabilities,
  );
  assert.equal(driver.compactions.length, 2);
  assert.equal(driver.generations.length, 3);
  assert.equal(childState.acceptedHandoff?.handoff.source.threadId, child.id);
  assert.notEqual(
    childState.acceptedHandoff?.artifact.digest,
    parentState.acceptedHandoff?.artifact.digest,
  );
  assert.equal((await thread.state()).acceptedHandoff?.artifact.digest, parentState.acceptedHandoff?.artifact.digest);
});

test("JX-AC-025 JX-AC-027 Handoff Artifact failure records a typed failure and dispatches no partial model Context", async () => {
  const driver = new ContextDriver(["must not be used"]);
  const thread = await createHarness({
    agent: boundedAgent(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: driver },
    store: new RejectHandoffArtifactStore(),
  }).createThread();

  const state = await thread.send(`force compaction ${"y".repeat(15_000)}`);
  const events = await thread.events();
  assert.equal(state.status, "idle");
  assert.equal(state.acceptedHandoff, null);
  assert.equal(state.error?.code, "context_handoff_artifact_write_failed");
  assert.equal(driver.compactions.length, 1);
  assert.equal(driver.generations.length, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "thread.created",
      "input.received",
      "context.compaction_requested",
      "context.compaction_failed",
    ],
  );
});

test("JX-AC-023 JX-AC-025 an irreducible Agent prefix fails once without a compaction loop", async () => {
  const driver = new ContextDriver(["must not be used"]);
  const agent = defineAgent({
    context: {
      rawTailTokens: 512,
      reservedOutputTokens: 512,
      safetyMarginTokens: 256,
    },
    instructions: `immutable prefix ${"i".repeat(15_000)}`,
    model: { model: "deterministic", provider: "mock" },
    modelCapabilities: TEST_MODEL_CAPABILITIES,
  });
  const thread = await createHarness({
    agent,
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: driver },
  }).createThread();

  const state = await thread.send("small input");
  assert.equal(state.error?.code, "context_budget_uncompactable");
  assert.equal(driver.compactions.length, 0);
  assert.equal(driver.generations.length, 0);
  assert.equal(
    (await thread.events()).filter(
      (event) => event.type === "context.compaction_requested",
    ).length,
    1,
  );
});

test("JX-AC-004 JX-AC-024 pending Context compaction recovers with the same durable Effect identity", async () => {
  const inner = new InMemoryEventStore();
  const firstDriver = new ContextDriver(["not reached"]);
  const firstHarness = createHarness({
    agent: boundedAgent(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: firstDriver },
    store: new CrashBeforeCompactedEventStore(inner),
  });
  const thread = await firstHarness.createThread();
  await assert.rejects(
    thread.send(`recover this compaction ${"r".repeat(15_000)}`),
    /simulated process stop/u,
  );
  const request = (await inner.read(thread.id)).find(
    (event) => event.type === "context.compaction_requested",
  );
  assert.notEqual(request, undefined);
  assert.equal(firstDriver.compactions.length, 1);

  const recoveredDriver = new ContextDriver(["recovered reply"]);
  const recovered = await createHarness({
    agent: boundedAgent(),
    ids: new SequenceIdGenerator(100),
    modelDrivers: { mock: recoveredDriver },
    store: inner,
  }).openThread(thread.id);
  const state = await recovered.wait();
  assert.equal(state.result, "recovered reply");
  assert.equal(recoveredDriver.compactions.length, 1);
  assert.equal(
    recoveredDriver.compactions[0]?.id,
    request?.type === "context.compaction_requested"
      ? request.payload.effect.id
      : undefined,
  );
  const requests = (await recovered.events()).filter(
    (event) => event.type === "context.compaction_requested",
  );
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(
      (event) =>
        request?.type === "context.compaction_requested" &&
        event.payload.effect.id === request.payload.effect.id &&
        event.payload.effect.idempotencyKey ===
          request.payload.effect.idempotencyKey,
    ),
  );
});
