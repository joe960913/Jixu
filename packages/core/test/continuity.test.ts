import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentMismatchError,
  createInitialThreadState,
  createHarness,
  createThreadEvent,
  CURRENT_EVENT_SCHEMA_VERSION,
  defineAgent,
  defineSchema,
  defineTool,
  EMPTY_MODEL_ACCOUNTING,
  InMemoryEventStore,
  materializePlanUpdates,
  reduce,
  replayEvents,
} from "../src/index.ts";
import type {
  AgentConfig,
  AnyThreadEvent,
  ArtifactReference,
  Checkpoint,
  EventStore,
  JsonObject,
  ModelDriver,
  ModelGenerateEffect,
  ModelOutcome,
  PlanUpdateProposal,
  ThreadEventPayloads,
  ThreadEventType,
  TransitionResult,
} from "../src/index.ts";
import {
  SequenceIdGenerator,
  SequenceModelDriver,
  succeed,
} from "../../testkit/src/index.ts";

class CrashStore implements EventStore {
  readonly #inner: EventStore;
  readonly #matches: (event: AnyThreadEvent) => boolean;
  #triggered = false;

  constructor(inner: EventStore, matches: (event: AnyThreadEvent) => boolean) {
    this.#inner = inner;
    this.#matches = matches;
  }

  append(
    threadId: string,
    expectedRevision: number,
    event: AnyThreadEvent,
  ): Promise<void> {
    if (!this.#triggered && this.#matches(event)) {
      this.#triggered = true;
      return Promise.reject(new Error("simulated process stop"));
    }
    return this.#inner.append(threadId, expectedRevision, event);
  }

  putArtifact(
    reference: ArtifactReference,
    bytes: Uint8Array,
  ): Promise<void> {
    return this.#inner.putArtifact(reference, bytes);
  }

  readArtifact(reference: ArtifactReference): Promise<Uint8Array> {
    return this.#inner.readArtifact(reference);
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

  read(threadId: string, fromSequence?: number): Promise<readonly AnyThreadEvent[]> {
    return this.#inner.read(threadId, fromSequence);
  }

  readCheckpoint(threadId: string): Promise<Checkpoint | null> {
    return this.#inner.readCheckpoint(threadId);
  }

  writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.#inner.writeCheckpoint(checkpoint);
  }
}

const objectSchema = defineSchema<JsonObject>({
  jsonSchema: { type: "object" },
  parse(value: unknown): JsonObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Expected an object");
    }
    return value as JsonObject;
  },
});

const stringSchema = defineSchema<string>({
  jsonSchema: { type: "string" },
  parse(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("Expected a string");
    return value;
  },
});

function defineTestAgent(tools: NonNullable<AgentConfig["tools"]> = []) {
  return defineAgent({
    instructions: "Continue precisely.",
    model: { model: "deterministic", provider: "mock" },
    tools,
  });
}

function recoveryPlan(
  operation: "create" | "revise",
  status: "completed" | "in_progress",
): PlanUpdateProposal {
  return {
    acceptanceCriteria: ["Recovery completes without duplicate work"],
    assumptions: [],
    blockers: [],
    nextAction: status === "completed" ? null : "Execute the safe Tool",
    objective: "Recover the planned Tool boundary",
    operation,
    steps: [
      {
        description: "Execute once and verify",
        evidence: status === "completed" ? ["tool:safe-1"] : [],
        id: "execute",
        status,
      },
    ],
  };
}

test("JX-AC-004 JX-AC-005 recovery does not repeat an unsafe pending Tool", async () => {
  const inner = new InMemoryEventStore();
  const store = new CrashStore(inner, (event) => event.type === "tool.completed");
  let executions = 0;
  const tool = defineTool({
    description: "Unsafe action",
    execute: () => {
      executions += 1;
      return "acted";
    },
    idempotency: "non-idempotent",
    input: objectSchema,
    name: "unsafe",
    output: stringSchema,
  });
  const agent = defineTestAgent([tool]);
  const firstHarness = createHarness({
    agent,
    ids: new SequenceIdGenerator(),
    modelDrivers: {
      mock: new SequenceModelDriver([
        succeed({
          content: "",
          toolCalls: [{ arguments: {}, id: "unsafe-1", name: "unsafe" }],
        }),
      ]),
    },
    store,
  });
  const thread = await firstHarness.createThread();
  await assert.rejects(thread.send("act once"), /simulated process stop/);
  assert.equal(executions, 1);

  const recovered = await createHarness({
    agent,
    ids: new SequenceIdGenerator(100),
    modelDrivers: { mock: new SequenceModelDriver([]) },
    store,
  }).openThread(thread.id);
  const state = await recovered.wait();

  assert.equal(executions, 1);
  assert.equal(state.status, "waiting");
  assert.equal(state.waitingReason?.reasonCode, "effect_outcome_unknown");
});

test("JX-AC-004 JX-AC-047 pending Tool approval survives restart", async () => {
  const store = new InMemoryEventStore();
  let executions = 0;
  const tool = defineTool({
    description: "Recoverable read",
    execute: () => {
      executions += 1;
      return "recovered";
    },
    idempotency: "idempotent",
    input: objectSchema,
    name: "recoverable",
    output: stringSchema,
  });
  const agent = defineTestAgent([tool]);
  const first = createHarness({
    agent,
    ids: new SequenceIdGenerator(),
    modelDrivers: {
      mock: new SequenceModelDriver([
        succeed({
          content: "",
          toolCalls: [
            { arguments: {}, id: "recoverable-1", name: "recoverable" },
          ],
        }),
      ]),
    },
    store,
    toolPermissionPolicy: { defaultEffect: "ask", rules: [] },
  });
  const original = await first.createThread();
  const waiting = await original.send("Read after approval");
  const effectId = waiting.waitingReason?.effectId;
  assert.equal(waiting.waitingReason?.reasonCode, "tool_approval_required");
  assert.ok(effectId !== undefined);

  const recovered = await createHarness({
    agent,
    ids: new SequenceIdGenerator(100),
    modelDrivers: {
      mock: new SequenceModelDriver([
        succeed({ content: "Recovered after approval.", toolCalls: [] }),
      ]),
    },
    store,
    toolPermissionPolicy: { defaultEffect: "ask", rules: [] },
  }).openThread(original.id);
  assert.equal((await recovered.state()).status, "waiting");

  const complete = await recovered.decideApproval(effectId, "allow_once");
  assert.equal(complete.status, "idle");
  assert.equal(complete.result, "Recovered after approval.");
  assert.equal(executions, 1);
});

test("JX-AC-004 JX-AC-020 queued input survives restart and activates once", async () => {
  const inner = new InMemoryEventStore();
  const store = new CrashStore(inner, (event) => event.type === "model.completed");
  let release!: (outcome: ModelOutcome) => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const firstDriver: ModelDriver = {
    generate() {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const agent = defineTestAgent();
  const firstHarness = createHarness({
    agent,
    modelDrivers: { mock: firstDriver },
    store,
  });
  const thread = await firstHarness.createThread();
  const first = thread.send("first");
  await firstStarted;
  const second = thread.send("second");
  release(succeed({ content: "first reply", toolCalls: [] }));
  await assert.rejects(first, /simulated process stop/);
  await assert.rejects(second, /simulated process stop/);

  const recoveredDriver = new SequenceModelDriver([
    succeed({ content: "first reply", toolCalls: [] }),
    succeed({ content: "second reply", toolCalls: [] }),
  ]);
  const recoveredHarness = createHarness({
    agent,
    modelDrivers: { mock: recoveredDriver },
    store,
  });
  const listed = await recoveredHarness.listThreads();
  assert.ok(listed.some((candidate) => candidate.id === thread.id));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveredDriver.effects.length, 0);

  const recovered = await recoveredHarness.openThread(thread.id);
  const state = await recovered.wait();

  assert.equal(state.status, "idle");
  assert.equal(recoveredDriver.effects.length, 2);
  assert.equal(state.metrics.model.calls, 2);
  assert.equal(state.metrics.model.attempts, 3);
  assert.equal(state.metrics.model.succeeded, 2);
  assert.deepEqual(
    state.messages.filter((message) => message.role === "user"),
    [
      { content: "first", role: "user" },
      { content: "second", role: "user" },
    ],
  );
});

test("JX-AC-022 recovery commits a proposed Plan before Tool dispatch and restores it to context", async () => {
  const inner = new InMemoryEventStore();
  const store = new CrashStore(inner, (event) => event.type === "plan.updated");
  let executions = 0;
  const tool = defineTool({
    description: "Safe action",
    execute: () => {
      executions += 1;
      return "done";
    },
    idempotency: "idempotent",
    input: objectSchema,
    name: "safe",
    output: stringSchema,
  });
  const agent = defineTestAgent([tool]);
  const first = await createHarness({
    agent,
    modelDrivers: {
      mock: new SequenceModelDriver([
        succeed({
          content: "Plan accepted before restart.",
          planUpdates: [recoveryPlan("create", "in_progress")],
          toolCalls: [],
        }),
      ]),
    },
    store,
  }).createThread();

  await assert.rejects(first.send("Run with a recoverable Plan"), /simulated process stop/);
  assert.equal(executions, 0);
  assert.equal((await inner.read(first.id)).at(-1)?.type, "model.completed");

  let restoredPlanId: string | undefined;
  let calls = 0;
  const recoveredDriver: ModelDriver = {
    generate(effect) {
      calls += 1;
      restoredPlanId = effect.input.activePlan?.id;
      assert.equal(effect.input.instructions, "Continue precisely.");
      if (calls === 1) {
        return Promise.resolve(
          succeed({
            content: "",
            planUpdates: [recoveryPlan("revise", "in_progress")],
            toolCalls: [{ arguments: {}, id: "safe-1", name: "safe" }],
          }),
        );
      }
      return Promise.resolve(
        succeed({
          content: "Recovered and verified.",
          planUpdates: [recoveryPlan("revise", "completed")],
          toolCalls: [],
        }),
      );
    },
  };
  const recovered = await createHarness({
    agent,
    modelDrivers: { mock: recoveredDriver },
    store,
  }).openThread(first.id);
  const restored = await recovered.wait();
  assert.equal(restored.status, "idle");
  const recoveredPlanId = restored.activePlan?.id;
  assert.notEqual(recoveredPlanId, undefined);
  const state = await recovered.send("Continue the recovered Plan");
  const events = await recovered.events();
  const planEvents = events.filter((event) => event.type === "plan.updated");

  assert.equal(executions, 1);
  assert.equal(calls, 2);
  assert.equal(restoredPlanId, recoveredPlanId);
  assert.equal(planEvents[0]?.payload.plan.id, restoredPlanId);
  assert.equal(planEvents.at(-1)?.payload.plan.status, "completed");
  assert.equal(state.activePlan, null);
  assert.ok(
    events.findIndex(
      (event) =>
        event.type === "plan.updated" && event.payload.plan.revision === 2,
    ) <
      events.findIndex((event) => event.type === "tool.requested"),
  );
});

test("JX-AC-004 JX-AC-031 rejected Plan-only control survives restart and retries", async () => {
  const inner = new InMemoryEventStore();
  const store = new CrashStore(inner, (event) => event.type === "plan.rejected");
  const rejectionMessage =
    "Plan control call-1.steps[0] must be a JSON object";
  const agent = defineTestAgent();
  const first = await createHarness({
    agent,
    modelDrivers: {
      mock: new SequenceModelDriver([{
        planRejections: [{
          code: "plan_update_invalid",
          message: rejectionMessage,
          retryable: false,
        }],
        status: "succeeded",
        value: { content: "", planUpdates: [], toolCalls: [] },
      }]),
    },
    store,
  }).createThread();

  await assert.rejects(
    first.send("Create a Plan but do not execute it"),
    /simulated process stop/,
  );
  const completed = (await inner.read(first.id)).at(-1);
  assert.equal(completed?.type, "model.completed");
  if (completed?.type === "model.completed") {
    assert.equal(
      completed.payload.planRejections?.[0]?.error.message,
      rejectionMessage,
    );
  }

  const recoveredDriver = new SequenceModelDriver([
    succeed({
      content: "Plan created; execution is waiting for approval.",
      planUpdates: [recoveryPlan("create", "in_progress")],
      toolCalls: [],
    }),
  ]);
  const recovered = await createHarness({
    agent,
    modelDrivers: { mock: recoveredDriver },
    store,
  }).openThread(first.id);
  const state = await recovered.wait();
  const events = await recovered.events();

  assert.equal(state.result, "Plan created; execution is waiting for approval.");
  assert.notEqual(state.activePlan, null);
  assert.match(
    recoveredDriver.effects[0]?.input.planRejectionFeedback ?? "",
    /steps\[0\] must be a JSON object/,
  );
  assert.deepEqual(
    events.slice(-4).map((event) => event.type),
    ["plan.rejected", "model.requested", "model.completed", "plan.updated"],
  );
});

test("JX-AC-004 JX-AC-049 historical unbounded Plan repair settles before redispatch", async () => {
  const threadId = "thread-historical-plan-repair";
  const agent = defineTestAgent();
  const events: AnyThreadEvent[] = [];
  let state = createInitialThreadState(threadId);
  let sequence = 0;
  const apply = <TType extends ThreadEventType>(
    type: TType,
    payload: ThreadEventPayloads[TType],
    schemaVersion = CURRENT_EVENT_SCHEMA_VERSION,
  ): TransitionResult => {
    sequence += 1;
    const event = {
      ...createThreadEvent({
        id: `event-${sequence}`,
        payload,
        threadId,
        sequence,
        timestamp: "2026-01-01T00:00:00.000Z",
        type,
      }),
      schemaVersion,
    } as AnyThreadEvent;
    const transition = reduce(state, event);
    state = transition.state;
    events.push(event);
    return transition;
  };
  const legacyEffect = (effect: ModelGenerateEffect): ModelGenerateEffect =>
    ({
      ...effect,
      input: {
        activePlan: effect.input.activePlan,
        instructions: effect.input.instructions,
        messages: effect.input.messages,
        model: effect.input.model,
        planControl: effect.input.planControl,
        ...(effect.input.planRejectionFeedback === undefined
          ? {}
          : { planRejectionFeedback: effect.input.planRejectionFeedback }),
        progressControl: effect.input.progressControl,
        tools: effect.input.tools,
      },
    }) as unknown as ModelGenerateEffect;
  apply("thread.created", { agent: agent.snapshot });
  let next = apply("input.received", {
    content: "Create a Plan but do not execute it",
  }).effects[0];
  assert.equal(next?.type, "model.generate");
  if (next?.type !== "model.generate") return;
  const initialRequest = legacyEffect(next);
  apply("model.requested", { effect: initialRequest }, 6);
  apply("model.completed", {
    accounting: EMPTY_MODEL_ACCOUNTING,
    effectId: initialRequest.id,
    response: {
      content: "",
      planUpdates: [recoveryPlan("create", "in_progress")],
      toolCalls: [],
    },
  });
  const initialPendingPlan = state.pendingPlanUpdates[0];
  assert.notEqual(initialPendingPlan, undefined);
  if (initialPendingPlan === undefined) return;
  const initialPlan = materializePlanUpdates(
    state.activePlan,
    [initialPendingPlan.proposal],
    initialPendingPlan.identitySeed,
  )[0];
  assert.notEqual(initialPlan, undefined);
  if (initialPlan === undefined) return;
  next = apply("plan.updated", { plan: initialPlan }).effects[0];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(next?.type, "model.generate");
    if (next?.type !== "model.generate") return;
    const persisted = legacyEffect(next);
    apply("model.requested", { effect: persisted }, 6);
    apply("model.completed", {
      accounting: EMPTY_MODEL_ACCOUNTING,
      effectId: persisted.id,
      response: {
        content: "",
        planUpdates: [{
          ...recoveryPlan("revise", "in_progress"),
          objective: `Historical replacement ${attempt + 1}`,
          operation: "supersede",
        }],
        toolCalls: [],
      },
    });
    const pending = state.pendingPlanRejections[0];
    assert.notEqual(pending, undefined);
    if (pending === undefined) return;
    next = apply("plan.rejected", {
      effectId: pending.effectId,
      error: pending.error,
      proposals: pending.proposals,
    }).effects[0];
  }
  assert.equal(next?.type, "model.generate");
  if (next?.type !== "model.generate") return;
  const historicalPendingEffect = legacyEffect(next);
  apply("model.requested", { effect: historicalPendingEffect }, 6);
  assert.equal(state.planRepairAttempts, 3);
  assert.equal(state.status, "running");

  const store = new InMemoryEventStore();
  await store.createThread(threadId);
  for (const event of events) {
    await store.append(threadId, event.sequence - 1, event);
  }
  let calls = 0;
  const recovered = await createHarness({
    agent,
    ids: new SequenceIdGenerator(100),
    modelDrivers: {
      mock: {
        generate() {
          calls += 1;
          return Promise.resolve(
            succeed({ content: "should not run", toolCalls: [] }),
          );
        },
      },
    },
    store,
  }).openThread(threadId);
  const recoveredState = await recovered.wait();
  const recoveredEvents = await recovered.events();

  assert.equal(calls, 0);
  assert.equal(recoveredState.status, "idle");
  assert.equal(recoveredState.error?.code, "plan_repair_exhausted");
  assert.equal(recoveredEvents.length, events.length + 1);
  assert.equal(recoveredEvents.at(-1)?.type, "model.failed");
  assert.equal(
    recoveredEvents.filter((event) => event.type === "model.requested").length,
    5,
  );
});

test("JX-AC-009 pause survives restart and only continue dispatches ready work", async () => {
  let release!: (outcome: ModelOutcome) => void;
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const firstDriver: ModelDriver = {
    generate() {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  let executions = 0;
  const tool = defineTool({
    description: "Safe action",
    execute: () => {
      executions += 1;
      return "done";
    },
    idempotency: "idempotent",
    input: objectSchema,
    name: "safe",
    output: stringSchema,
  });
  const agent = defineTestAgent([tool]);
  const store = new InMemoryEventStore();
  const firstHarness = createHarness({
    agent,
    modelDrivers: { mock: firstDriver },
    store,
  });
  const thread = await firstHarness.createThread();
  const sending = thread.send("do it");
  await modelStarted;
  const pausing = thread.pause();
  release(
    succeed({
      content: "",
      toolCalls: [{ arguments: {}, id: "safe-1", name: "safe" }],
    }),
  );
  assert.equal((await pausing).status, "paused");
  assert.equal((await sending).status, "paused");
  assert.equal(executions, 0);

  const reopened = await createHarness({
    agent,
    modelDrivers: {
      mock: new SequenceModelDriver([
        succeed({ content: "finished", toolCalls: [] }),
      ]),
    },
    store,
  }).openThread(thread.id);
  assert.equal((await reopened.state()).status, "paused");
  assert.equal(executions, 0);
  assert.equal((await reopened.continue()).status, "idle");
  assert.equal(executions, 1);
});

test("JX-AC-006 JX-AC-007 JX-AC-028 JX-AC-052 fork preserves Artifact references while replay stays inert", async () => {
  const driver = new SequenceModelDriver([
    succeed({ content: "parent", toolCalls: [] }),
    succeed({ content: "child", toolCalls: [] }),
  ]);
  const agent = defineTestAgent();
  const store = new InMemoryEventStore();
  const harness = createHarness({
    agent,
    modelDrivers: { mock: driver },
    store,
  });
  const parent = await harness.createThread();
  await parent.send({
    content: [
      { text: "parent ", type: "text" },
      {
        data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 7]),
        mediaType: "image/png",
        placeholder: "pasted image 1",
        type: "image",
      },
    ],
  });
  const parentEvents = await parent.events();
  const parentInput = parentEvents.find(
    (event) => event.type === "input.received",
  );
  assert.notEqual(parentInput, undefined);
  const parentImage = parentInput?.payload.parts?.find(
    (part) => part.type === "image",
  );
  assert.notEqual(parentImage, undefined);
  const forkPoint = parentEvents.at(-1);
  assert.notEqual(forkPoint, undefined);
  if (forkPoint === undefined) return;

  const child = await parent.fork({ at: forkPoint.id, input: "child input" });
  await child.wait();
  const parentState = await parent.state();
  const childEvents = await child.events();
  const forkSequence = childEvents.findIndex(
    (event) => event.type === "thread.forked",
  );
  assert.notEqual(forkSequence, -1);
  const childAtFork = replayEvents(
    child.id,
    childEvents.slice(0, forkSequence + 1),
  );
  const childParentImage = childEvents
    .find((event) => event.type === "input.received")
    ?.payload.parts?.find((part) => part.type === "image");
  assert.deepEqual(childParentImage, parentImage);
  if (childParentImage?.type === "image") {
    assert.equal(
      (await store.readArtifact(childParentImage.artifact)).byteLength,
      childParentImage.artifact.byteLength,
    );
  }
  assert.deepEqual(childAtFork.metrics, parentState.metrics);
  const callsBeforeReplay = driver.effects.length;
  assert.deepEqual(await child.replay(), await child.state());
  assert.equal(driver.effects.length, callsBeforeReplay);
  assert.deepEqual(await parent.state(), parentState);
  assert.notEqual(child.id, parent.id);

  const mismatched = defineAgent({
    instructions: "Different Agent.",
    model: { model: "deterministic", provider: "mock" },
  });
  await assert.rejects(
    createHarness({
      agent: mismatched,
      modelDrivers: { mock: new SequenceModelDriver([]) },
      store,
    }).openThread(parent.id),
    AgentMismatchError,
  );
});
