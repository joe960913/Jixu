import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentMismatchError,
  createRuntime,
  defineAgent,
  defineSchema,
  defineTool,
  InMemoryEventStore,
  jsonDigest,
  replayEvents,
} from "../src/index.ts";
import type {
  AnyRunEvent,
  Checkpoint,
  EventStore,
  JsonObject,
  ModelDriver,
  ModelGenerateEffect,
  ModelOutcome,
  RunState,
} from "../src/index.ts";
import {
  FixedClock,
  SequenceIdGenerator,
  SequenceModelDriver,
  succeed,
} from "../../testkit/src/index.ts";

const inputSchema = defineSchema<JsonObject>({
  jsonSchema: { type: "object" },
  parse(value: unknown): JsonObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Expected an object");
    }
    return value as JsonObject;
  },
});

const outputSchema = defineSchema<string>({
  jsonSchema: { type: "string" },
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("Expected a string");
    }
    return value;
  },
});

class CrashStore implements EventStore {
  readonly #afterCommit: boolean;
  readonly #inner: EventStore;
  readonly #matches: (event: AnyRunEvent) => boolean;
  #triggered = false;

  constructor(
    inner: EventStore,
    matches: (event: AnyRunEvent) => boolean,
    afterCommit: boolean,
  ) {
    this.#afterCommit = afterCommit;
    this.#inner = inner;
    this.#matches = matches;
  }

  append(
    runId: string,
    expectedRevision: number,
    event: AnyRunEvent,
  ): Promise<void> {
    if (!this.#triggered && this.#matches(event)) {
      this.#triggered = true;
      if (this.#afterCommit) {
        return this.#inner
          .append(runId, expectedRevision, event)
          .then(() => Promise.reject(new Error("simulated process stop")));
      }
      return Promise.reject(new Error("simulated process stop"));
    }
    return this.#inner.append(runId, expectedRevision, event);
  }

  createFork(runId: string, events: readonly AnyRunEvent[]): Promise<void> {
    return this.#inner.createFork(runId, events);
  }

  createRun(runId: string): Promise<void> {
    return this.#inner.createRun(runId);
  }

  listNonTerminalRuns(): Promise<readonly string[]> {
    return this.#inner.listNonTerminalRuns();
  }

  read(runId: string, fromSequence?: number): Promise<readonly AnyRunEvent[]> {
    return this.#inner.read(runId, fromSequence);
  }

  readCheckpoint(runId: string): Promise<Checkpoint | null> {
    return this.#inner.readCheckpoint(runId);
  }

  writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.#inner.writeCheckpoint(checkpoint);
  }
}

class CheckpointViewStore implements EventStore {
  readonly #checkpoint: () => Checkpoint | null;
  readonly #inner: EventStore;

  constructor(inner: EventStore, checkpoint: () => Checkpoint | null) {
    this.#checkpoint = checkpoint;
    this.#inner = inner;
  }

  append(
    runId: string,
    expectedRevision: number,
    event: AnyRunEvent,
  ): Promise<void> {
    return this.#inner.append(runId, expectedRevision, event);
  }

  createFork(runId: string, events: readonly AnyRunEvent[]): Promise<void> {
    return this.#inner.createFork(runId, events);
  }

  createRun(runId: string): Promise<void> {
    return this.#inner.createRun(runId);
  }

  listNonTerminalRuns(): Promise<readonly string[]> {
    return this.#inner.listNonTerminalRuns();
  }

  read(runId: string, fromSequence?: number): Promise<readonly AnyRunEvent[]> {
    return this.#inner.read(runId, fromSequence);
  }

  async readCheckpoint(): Promise<Checkpoint | null> {
    return this.#checkpoint();
  }

  writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.#inner.writeCheckpoint(checkpoint);
  }
}

class ControlledModelDriver implements ModelDriver {
  readonly effects: ModelGenerateEffect[] = [];
  readonly started: Promise<void>;
  #releaseStarted: () => void = () => undefined;
  #resolveFirst: (outcome: ModelOutcome) => void = () => undefined;
  #sequence = 0;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#releaseStarted = resolve;
    });
  }

  generate(effect: ModelGenerateEffect): Promise<ModelOutcome> {
    this.effects.push(structuredClone(effect));
    this.#sequence += 1;
    if (this.#sequence === 1) {
      this.#releaseStarted();
      return new Promise((resolve) => {
        this.#resolveFirst = resolve;
      });
    }
    return Promise.resolve(
      succeed({ content: "finished after resume", toolCalls: [] }),
    );
  }

  resolveFirst(outcome: ModelOutcome): void {
    this.#resolveFirst(outcome);
  }
}

function toolCallingOutcome(name: string): ModelOutcome {
  return succeed({
    content: "",
    toolCalls: [{ arguments: {}, id: `call-${name}`, name }],
  });
}

test("JX-AC-003 recovery does not dispatch a pending unsafe Tool Effect", async () => {
  const inner = new InMemoryEventStore();
  const store = new CrashStore(
    inner,
    (event) => event.type === "tool.completed",
    false,
  );
  let executions = 0;
  const tool = defineTool({
    description: "Unsafe action",
    execute: () => {
      executions += 1;
      return "acted";
    },
    idempotency: "non-idempotent",
    input: inputSchema,
    name: "unsafe-action",
    output: outputSchema,
  });
  const agent = defineAgent({
    instructions: "Use the action.",
    model: { model: "deterministic", provider: "mock" },
    tools: [tool],
  });
  const firstRuntime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: {
      mock: new SequenceModelDriver([toolCallingOutcome("unsafe-action")]),
    },
    store,
  });
  const interrupted = await firstRuntime.run(agent, "act once");
  await assert.rejects(interrupted.wait(), /simulated process stop/);
  await assert.rejects(interrupted.wait(), /simulated process stop/);
  assert.equal(executions, 1);

  const recoveredRuntime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(100),
    modelDrivers: { mock: new SequenceModelDriver([]) },
    store,
  });
  const recovered = await recoveredRuntime.recover(agent, interrupted.id);
  const state = await recovered.wait();

  assert.equal(executions, 1);
  assert.equal(state.status, "waiting");
  assert.equal(state.waitingReason?.reasonCode, "effect_outcome_unknown");
  assert.equal((await recovered.events()).at(-1)?.type, "run.waiting");
});

test("JX-AC-003 recovery rediscovers an outcome-derived ready Effect", async () => {
  const inner = new InMemoryEventStore();
  const store = new CrashStore(
    inner,
    (event) => event.type === "model.completed" && event.payload.response.toolCalls.length > 0,
    true,
  );
  let executions = 0;
  const tool = defineTool({
    description: "Ready action",
    execute: () => {
      executions += 1;
      return "ready-result";
    },
    idempotency: "non-idempotent",
    input: inputSchema,
    name: "ready-action",
    output: outputSchema,
  });
  const agent = defineAgent({
    instructions: "Use the action.",
    model: { model: "deterministic", provider: "mock" },
    tools: [tool],
  });
  const firstRuntime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: {
      mock: new SequenceModelDriver([toolCallingOutcome("ready-action")]),
    },
    store,
  });
  const interrupted = await firstRuntime.run(agent, "prepare action");
  await assert.rejects(interrupted.wait(), /simulated process stop/);
  assert.equal(executions, 0);

  const recoveredRuntime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(100),
    modelDrivers: {
      mock: new SequenceModelDriver([
        succeed({ content: "ready recovered", toolCalls: [] }),
      ]),
    },
    store,
  });
  const recovered = await recoveredRuntime.recover(agent, interrupted.id);
  const state = await recovered.wait();

  assert.equal(executions, 1);
  assert.equal(state.status, "completed");
  assert.equal(state.result, "ready recovered");
  assert.equal(
    (await recovered.events()).filter((event) => event.type === "tool.requested").length,
    1,
  );
});

test("JX-AC-004 idempotent recovery reuses identity and produces one action", async () => {
  const inner = new InMemoryEventStore();
  const store = new CrashStore(
    inner,
    (event) => event.type === "tool.completed",
    false,
  );
  const actions = new Map<string, string>();
  let actionCount = 0;
  let invocationCount = 0;
  const tool = defineTool({
    description: "Idempotent action",
    execute: (_input, context) => {
      invocationCount += 1;
      const existing = actions.get(context.idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      actionCount += 1;
      actions.set(context.idempotencyKey, "acted-once");
      return "acted-once";
    },
    idempotency: "idempotent",
    input: inputSchema,
    name: "safe-action",
    output: outputSchema,
  });
  const agent = defineAgent({
    instructions: "Use the action.",
    model: { model: "deterministic", provider: "mock" },
    tools: [tool],
  });
  const firstRuntime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: {
      mock: new SequenceModelDriver([toolCallingOutcome("safe-action")]),
    },
    store,
  });
  const interrupted = await firstRuntime.run(agent, "act once");
  await assert.rejects(interrupted.wait(), /simulated process stop/);
  assert.equal(actionCount, 1);

  const recoveredRuntime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(100),
    modelDrivers: {
      mock: new SequenceModelDriver([
        succeed({ content: "recovered", toolCalls: [] }),
      ]),
    },
    store,
  });
  const recovered = await recoveredRuntime.recover(agent, interrupted.id);
  const state = await recovered.wait();

  assert.equal(state.status, "completed");
  assert.equal(actionCount, 1);
  assert.equal(invocationCount, 2);
  const requests = (await recovered.events()).filter(
    (event) => event.type === "tool.requested",
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.payload.effect.id, requests[1]?.payload.effect.id);
  assert.equal(
    requests[0]?.payload.effect.idempotencyKey,
    requests[1]?.payload.effect.idempotencyKey,
  );
  assert.deepEqual(
    requests.map((event) => event.payload.effect.attempt),
    [1, 2],
  );
});

test("JX-AC-005 pause records active outcome and defers newly ready Effects", async () => {
  const model = new ControlledModelDriver();
  let toolCalls = 0;
  const tool = defineTool({
    description: "Deferred action",
    execute: () => {
      toolCalls += 1;
      return "tool-result";
    },
    input: inputSchema,
    name: "deferred-action",
    output: outputSchema,
  });
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
  });
  const run = await runtime.run(
    defineAgent({
      instructions: "Use the Tool.",
      model: { model: "deterministic", provider: "mock" },
      tools: [tool],
    }),
    "start",
  );
  await model.started;

  const pausing = run.pause();
  model.resolveFirst(toolCallingOutcome("deferred-action"));
  const paused = await pausing;

  assert.equal(paused.status, "paused");
  assert.equal(paused.readyEffects[0]?.type, "tool.execute");
  assert.equal(toolCalls, 0);
  assert.equal(
    (await run.events()).filter((event) => event.type === "tool.requested").length,
    0,
  );

  await run.resume();
  const completed = await run.wait();
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "finished after resume");
  assert.equal(toolCalls, 1);
});

function forkProjection(state: RunState): unknown {
  return {
    agent: state.agent,
    error: state.error,
    lineage: state.lineage,
    messages: state.messages,
    pauseRequested: state.pauseRequested,
    pending: Object.values(state.pendingEffects).map((effect) => ({
      input: effect.input,
      type: effect.type,
    })),
    ready: state.readyEffects.map((effect) => ({
      input: effect.input,
      type: effect.type,
    })),
    result: state.result,
    status: state.status,
    waitingReason: state.waitingReason,
  };
}

test("JX-AC-006 Fork copies exact prefix and cannot mutate its parent", async () => {
  const model = new SequenceModelDriver([
    succeed({ content: "parent result", toolCalls: [] }),
    succeed({ content: "child result", toolCalls: [] }),
  ]);
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
  });
  const agent = defineAgent({
    instructions: "Answer.",
    model: { model: "deterministic", provider: "mock" },
  });
  const parent = await runtime.run(agent, "parent input");
  await parent.wait();
  const parentBefore = await parent.events();
  const forkPoint = parentBefore.at(-1);
  assert.ok(forkPoint !== undefined);

  const child = await parent.fork({ at: forkPoint.id, input: "child input" });
  const childState = await child.wait();
  const childEvents = await child.events();
  const parentAtFork = replayEvents(
    parent.id,
    parentBefore.slice(0, forkPoint.sequence),
  );
  const childAtFork = replayEvents(
    child.id,
    childEvents.slice(0, forkPoint.sequence),
  );

  assert.deepEqual(forkProjection(childAtFork), forkProjection(parentAtFork));
  assert.equal(childState.lineage?.parentRunId, parent.id);
  assert.equal(childState.lineage?.parentEventId, forkPoint.id);
  assert.equal(childState.result, "child result");
  assert.deepEqual(await parent.events(), parentBefore);
  assert.equal((await parent.state()).result, "parent result");
});

test("JX-AC-007 replay reconstructs State and invokes zero live Drivers", async () => {
  const model = new SequenceModelDriver([
    succeed({ content: "recorded result", toolCalls: [] }),
  ]);
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
  });
  const run = await runtime.run(
    defineAgent({
      instructions: "Answer.",
      model: { model: "deterministic", provider: "mock" },
    }),
    "input",
  );
  const completed = await run.wait();
  const eventCount = (await run.events()).length;
  const driverCalls = model.effects.length;

  assert.deepEqual(await run.replay(), completed);
  assert.equal(model.effects.length, driverCalls);
  assert.equal((await run.events()).length, eventCount);
});

test("JX-AC-008 invalid or missing Checkpoints never change recovered State", async () => {
  const inner = new InMemoryEventStore();
  const model = new SequenceModelDriver([
    succeed({ content: "checkpoint result", toolCalls: [] }),
  ]);
  const agent = defineAgent({
    instructions: "Answer.",
    model: { model: "deterministic", provider: "mock" },
  });
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
    store: inner,
  });
  const run = await runtime.run(agent, "input");
  const expected = await run.wait();
  const valid = await inner.readCheckpoint(run.id);
  assert.ok(valid !== null);

  const mismatchedAgent = defineAgent({
    instructions: "Different durable definition.",
    model: { model: "deterministic", provider: "mock" },
  });
  await assert.rejects(
    createRuntime({
      modelDrivers: { mock: new SequenceModelDriver([]) },
      store: inner,
    }).recover(mismatchedAgent, run.id),
    AgentMismatchError,
  );

  const corruptState = {
    ...valid.state,
    status: "structurally-invalid",
  } as unknown as RunState;

  const candidates: readonly (() => Checkpoint | null)[] = [
    () => valid,
    () => null,
    () => {
      throw new Error("malformed checkpoint");
    },
    () => ({ ...valid, reducerVersion: REDUCER_VERSION_FOR_TEST }),
    () => ({
      ...valid,
      state: { ...valid.state, status: "failed" },
    }),
    () => ({
      ...valid,
      state: corruptState,
      stateDigest: jsonDigest(corruptState),
    }),
  ];

  for (const checkpoint of candidates) {
    const driver = new SequenceModelDriver([]);
    const recoveredRuntime = createRuntime({
      clock: new FixedClock(),
      ids: new SequenceIdGenerator(200),
      modelDrivers: { mock: driver },
      store: new CheckpointViewStore(inner, checkpoint),
    });
    const recovered = await recoveredRuntime.recover(agent, run.id);
    assert.deepEqual(await recovered.state(), expected);
    assert.equal(driver.effects.length, 0);
  }
});

const REDUCER_VERSION_FOR_TEST = 999;
