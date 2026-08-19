import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHarness,
  defineAgent,
  defineSchema,
  defineTool,
  InMemoryEventStore,
  ToolExecutionError,
} from "../src/index.ts";
import type {
  AgentConfig,
  JsonObject,
  ModelDriver,
  ModelOutcome,
  PlanStepStatus,
  PlanUpdateOperation,
  PlanUpdateProposal,
} from "../src/index.ts";
import {
  FixedClock,
  SequenceIdGenerator,
  SequenceModelDriver,
  succeed,
} from "../../testkit/src/index.ts";

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

function agentWith(driverTools: NonNullable<AgentConfig["tools"]> = []) {
  return defineAgent({
    instructions: "Be precise.",
    model: { model: "deterministic", provider: "mock" },
    tools: driverTools,
  });
}

function planUpdate(
  operation: PlanUpdateOperation,
  objective: string,
  statuses: readonly PlanStepStatus[],
  nextAction: string | null,
): PlanUpdateProposal {
  return {
    acceptanceCriteria: ["The requested change is verified"],
    assumptions: [],
    blockers: [],
    nextAction,
    objective,
    operation,
    steps: statuses.map((status, index) => ({
      description: index === 0 ? "Inspect the current state" : "Apply and verify",
      evidence: status === "completed" ? [`evidence-${index + 1}`] : [],
      id: `step-${index + 1}`,
      status,
    })),
  };
}

test("JX-AC-001 JX-AC-002 JX-AC-014 Tool use and later send continue one Thread", async () => {
  const store = new InMemoryEventStore();
  const weather = defineTool({
    description: "Get weather",
    execute: async (_input, context) => {
      assert.equal((await store.read(context.threadId)).at(-1)?.type, "tool.requested");
      return "sunny";
    },
    input: objectSchema,
    name: "weather",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [
        { arguments: { city: "Shanghai" }, id: "weather-1", name: "weather" },
      ],
    }),
    succeed({ content: "Shanghai is sunny.", toolCalls: [] }),
    succeed({ content: "The strongest caveat is humidity.", toolCalls: [] }),
  ]);
  const harness = createHarness({
    agent: agentWith([weather]),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
    store,
  });

  const thread = await harness.createThread();
  await thread.send("What is the weather?");
  await thread.send("Challenge that answer.");

  assert.equal((await thread.state()).status, "idle");
  assert.equal((await thread.state()).activePlan, null);
  assert.equal(
    (await thread.events()).some((event) => event.type === "plan.updated"),
    false,
  );
  assert.equal(model.effects.length, 3);
  assert.deepEqual(model.effects[2]?.input.messages.slice(-2), [
    { content: "Shanghai is sunny.", role: "assistant", toolCalls: [] },
    { content: "Challenge that answer.", role: "user" },
  ]);
  assert.deepEqual(
    (await thread.events()).map((event) => event.type),
    [
      "thread.created",
      "input.received",
      "model.requested",
      "model.completed",
      "tool.requested",
      "tool.completed",
      "model.requested",
      "model.completed",
      "input.received",
      "model.requested",
      "model.completed",
    ],
  );
});

test("JX-AC-039 typed Tool rejection stays failed while unknown exceptions stay indeterminate", async () => {
  const typed = defineTool({
    description: "Reject outside scope",
    execute: () => {
      throw new ToolExecutionError(
        "tool_path_outside_scope",
        "Path escapes the configured scope",
      );
    },
    input: objectSchema,
    name: "typed",
    output: stringSchema,
  });
  const unknown = defineTool({
    description: "Throw an unknown exception",
    execute: () => {
      throw new Error("Unknown execution state");
    },
    input: objectSchema,
    name: "unknown",
    output: stringSchema,
  });

  for (const [tool, name, disposition, code] of [
    [typed, "typed", "failed", "tool_path_outside_scope"],
    [unknown, "unknown", "indeterminate", "tool_driver_exception"],
  ] as const) {
    const model = new SequenceModelDriver([
      succeed({
        content: "",
        toolCalls: [{ arguments: {}, id: `${name}-1`, name }],
      }),
    ]);
    const thread = await createHarness({
      agent: agentWith([tool]),
      modelDrivers: { mock: model },
    }).createThread();

    await thread.send(`Call ${name}`);
    const failure = (await thread.events()).findLast(
      (event) => event.type === "tool.failed",
    );
    assert.equal(failure?.payload.disposition, disposition);
    assert.equal(failure?.payload.error.code, code);
  }
});

test("JX-AC-028 Thread metrics durably project tokens, USD cost, and Tool efficiency", async () => {
  const inspect = defineTool({
    description: "Inspect state",
    execute: () => "inspected",
    idempotency: "idempotent",
    input: objectSchema,
    name: "inspect",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    {
      accounting: {
        cost: {
          currency: "USD",
          pricingVersion: "fixture-1",
          source: "calculator",
          usdNanos: 1_250_000,
        },
        usage: {
          cacheWriteTokens: 5,
          cachedInputTokens: 20,
          inputTokens: 100,
          outputTokens: 30,
          reasoningTokens: 12,
          totalTokens: 130,
        },
      },
      status: "succeeded",
      value: {
        content: "",
        toolCalls: [{ arguments: {}, id: "inspect-1", name: "inspect" }],
      },
    },
    {
      accounting: {
        cost: null,
        usage: {
          cacheWriteTokens: null,
          cachedInputTokens: null,
          inputTokens: 50,
          outputTokens: 10,
          reasoningTokens: 4,
          totalTokens: 60,
        },
      },
      status: "succeeded",
      value: { content: "Verified.", toolCalls: [] },
    },
  ]);
  const thread = await createHarness({
    agent: agentWith([inspect]),
    modelDrivers: { mock: model },
  }).createThread();

  const state = await thread.send("Inspect and verify");
  assert.deepEqual(state.metrics, {
    cost: {
      pricedOutcomes: 1,
      unpricedOutcomes: 1,
      usdNanos: 1_250_000,
    },
    model: {
      attempts: 2,
      calls: 2,
      failed: 0,
      indeterminate: 0,
      succeeded: 2,
    },
    tokens: {
      cacheWriteReports: 1,
      cacheWriteTokens: 5,
      cachedInputReports: 1,
      cachedInputTokens: 20,
      inputTokens: 150,
      missingReports: 0,
      outputTokens: 40,
      reasoningReports: 2,
      reasoningTokens: 16,
      reports: 2,
      totalTokens: 190,
    },
    tools: {
      attempts: 1,
      calls: 1,
      failed: 0,
      indeterminate: 0,
      succeeded: 1,
    },
  });

  await thread.clear();
  assert.deepEqual((await thread.state()).metrics, state.metrics);
  assert.deepEqual((await thread.replay()).metrics, state.metrics);
});

test("JX-AC-021 JX-AC-035 adaptive Plan lifecycle keeps instructions stable without scheduling work", async () => {
  const store = new InMemoryEventStore();
  const inspect = defineTool({
    description: "Inspect state",
    execute: () => "inspected",
    idempotency: "idempotent",
    input: objectSchema,
    name: "inspect",
    output: stringSchema,
  });
  const firstObjective = "Safely update the repository";
  const secondObjective = "Prepare the release notes";
  const replacementObjective = "Verify the release instead";
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      planUpdates: [
        planUpdate("create", firstObjective, ["in_progress", "pending"], "Inspect"),
      ],
      toolCalls: [{ arguments: {}, id: "inspect-1", name: "inspect" }],
    }),
    succeed({
      content: "Inspection complete.",
      planUpdates: [
        planUpdate("revise", firstObjective, ["completed", "in_progress"], "Verify"),
      ],
      toolCalls: [],
    }),
    succeed({
      content: "Repository update verified.",
      planUpdates: [
        planUpdate("revise", firstObjective, ["completed", "completed"], null),
      ],
      toolCalls: [],
    }),
    succeed({
      content: "Release work started.",
      planUpdates: [
        planUpdate("create", secondObjective, ["in_progress"], "Draft notes"),
      ],
      toolCalls: [],
    }),
    succeed({
      content: "Objective replaced.",
      planUpdates: [
        planUpdate("supersede", secondObjective, ["pending"], null),
        planUpdate("create", replacementObjective, ["in_progress"], "Run checks"),
      ],
      toolCalls: [],
    }),
    succeed({ content: "Child continued the accepted Plan.", toolCalls: [] }),
  ]);
  const thread = await createHarness({
    agent: agentWith([inspect]),
    modelDrivers: { mock: model },
    store,
  }).createThread();

  await thread.send("Update this safely");
  await thread.send("Finish verification");
  await thread.send("Prepare release notes");
  await thread.send("Actually verify the release");

  const events = await thread.events();
  const plans = events.flatMap((event) =>
    event.type === "plan.updated" ? [event.payload.plan] : [],
  );
  assert.deepEqual(
    plans.map((plan) => [plan.objective, plan.revision, plan.status]),
    [
      [firstObjective, 1, "active"],
      [firstObjective, 2, "active"],
      [firstObjective, 3, "completed"],
      [secondObjective, 1, "active"],
      [secondObjective, 2, "superseded"],
      [replacementObjective, 1, "active"],
    ],
  );
  assert.equal(plans[0]?.id, plans[2]?.id);
  assert.equal(plans[3]?.id, plans[4]?.id);
  assert.notEqual(plans[4]?.id, plans[5]?.id);
  assert.ok(
    plans.every(
      (plan) =>
        plan.steps.filter((step) => step.status === "in_progress").length <= 1,
    ),
  );
  assert.equal((await thread.state()).activePlan?.objective, replacementObjective);
  assert.equal(
    events.filter((event) => event.type === "tool.requested").length,
    1,
  );
  assert.ok(
    events.findIndex((event) => event.type === "plan.updated") <
      events.findIndex((event) => event.type === "tool.requested"),
  );
  assert.ok(
    model.effects.every(
      (effect) => effect.input.instructions === "Be precise.",
    ),
  );
  const firstPlanEffects = model.effects.filter(
    (effect) => effect.input.activePlan?.objective === firstObjective,
  );
  assert.ok(firstPlanEffects.length >= 2);
  assert.deepEqual(
    firstPlanEffects[1]?.input.planControl,
    firstPlanEffects[0]?.input.planControl,
  );

  const forkPoint = events.at(-1);
  assert.notEqual(forkPoint, undefined);
  if (forkPoint !== undefined) {
    const child = await thread.fork({ at: forkPoint.id, input: "Continue in child" });
    const childState = await child.wait();
    assert.equal(childState.activePlan?.id, plans.at(-1)?.id);
    assert.equal(model.effects.at(-1)?.input.activePlan?.id, plans.at(-1)?.id);
  }
});

test("JX-AC-031 invalid Plan metadata preserves the model response and Tool path", async () => {
  let executions = 0;
  const inspect = defineTool({
    description: "Inspect state",
    execute: () => {
      executions += 1;
      return "inspected";
    },
    idempotency: "idempotent",
    input: objectSchema,
    name: "inspect",
    output: stringSchema,
  });
  const objective = "Inspect and explain the repository";
  const model = new SequenceModelDriver([
    succeed({
      content: "Plan ready.",
      planUpdates: [planUpdate("create", objective, ["in_progress"], "Inspect")],
      toolCalls: [],
    }),
    succeed({
      content: "Starting inspection.",
      planUpdates: [
        planUpdate("create", "Duplicate Plan", ["in_progress"], "Inspect"),
      ],
      toolCalls: [{ arguments: {}, id: "inspect-1", name: "inspect" }],
    }),
    succeed({ content: "Inspection complete.", toolCalls: [] }),
  ]);
  const thread = await createHarness({
    agent: agentWith([inspect]),
    modelDrivers: { mock: model },
  }).createThread();

  await thread.send("Make a Plan");
  const acceptedPlan = (await thread.state()).activePlan;
  const state = await thread.send("Execute it");
  const events = await thread.events();
  const rejected = events.find((event) => event.type === "plan.rejected");
  const rejectedIndex = events.findIndex((event) => event.type === "plan.rejected");

  assert.equal(executions, 1);
  assert.equal(state.result, "Inspection complete.");
  assert.equal(state.activePlan?.id, acceptedPlan?.id);
  assert.equal(events.some((event) => event.type === "model.failed"), false);
  assert.equal(rejected?.payload.error.code, "plan_update_invalid");
  assert.equal(events[rejectedIndex - 1]?.type, "model.completed");
  assert.ok(
    rejectedIndex < events.findIndex((event) => event.type === "tool.requested"),
  );
  assert.match(
    JSON.stringify(model.effects[0]?.input.planControl.inputSchema),
    /"enum":\["create"\]/,
  );
  assert.doesNotMatch(
    JSON.stringify(model.effects[1]?.input.planControl.inputSchema),
    /"create"/,
  );
});

test("JX-AC-020 input accepted while running is durable and starts in Event order", async () => {
  let release!: (outcome: ModelOutcome) => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const effects: Parameters<ModelDriver["generate"]>[0][] = [];
  const driver: ModelDriver = {
    generate(effect) {
      effects.push(structuredClone(effect));
      if (effects.length === 1) {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(
        succeed({ content: "second reply", toolCalls: [] }),
      );
    },
  };
  const store = new InMemoryEventStore();
  const harness = createHarness({
    agent: agentWith(),
    modelDrivers: { mock: driver },
    store,
  });
  const thread = await harness.createThread();

  const first = thread.send("first");
  await firstStarted;
  const second = thread.send("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    (await thread.events())
      .filter((event) => event.type === "input.received")
      .map((event) => event.payload.content),
    ["first", "second"],
  );

  release(succeed({ content: "first reply", toolCalls: [] }));
  await Promise.all([first, second]);
  assert.equal((await thread.state()).status, "idle");
  assert.deepEqual(effects[1]?.input.messages.slice(-3), [
    { content: "first", role: "user" },
    { content: "first reply", role: "assistant", toolCalls: [] },
    { content: "second", role: "user" },
  ]);
});

test("JX-AC-003 clear retains Thread history but resets later model context", async () => {
  const model = new SequenceModelDriver([
    succeed({ content: "before", toolCalls: [] }),
    succeed({ content: "after", toolCalls: [] }),
  ]);
  const harness = createHarness({
    agent: agentWith(),
    modelDrivers: { mock: model },
  });
  const thread = await harness.createThread();
  await thread.send("old context");
  const id = thread.id;
  await thread.clear();
  await thread.send("fresh context");

  assert.equal(thread.id, id);
  assert.deepEqual(model.effects[1]?.input.messages, [
    { content: "fresh context", role: "user" },
  ]);
  assert.ok((await thread.events()).some((event) => event.type === "context.cleared"));
});

test("JX-API-004 Thread stream catches up Events and observes live Signals", async () => {
  const driver: ModelDriver = {
    async generate(effect, context) {
      context.signals.emit({
        data: { delta: "live" },
        kind: "signal",
        threadId: effect.threadId,
        type: "model.output_text.delta",
      });
      return succeed({ content: "done", toolCalls: [] });
    },
  };
  const harness = createHarness({
    agent: agentWith(),
    modelDrivers: { mock: driver },
  });
  const thread = await harness.createThread();
  const cancellation = new AbortController();
  const observed = [] as Array<{ readonly kind: string; readonly type?: string }>;
  const observation = (async () => {
    for await (const item of thread.stream({ signal: cancellation.signal })) {
      observed.push(
        item.kind === "event"
          ? { kind: item.kind, type: item.event.type }
          : { kind: item.kind, type: item.type },
      );
      if (item.kind === "event" && item.event.type === "model.completed") {
        cancellation.abort();
      }
    }
  })();

  await thread.send("observe");
  await observation;
  assert.ok(observed.some((item) => item.type === "thread.created"));
  assert.ok(observed.some((item) => item.type === "model.output_text.delta"));
  assert.equal(
    observed.filter((item) => item.type === "model.completed").length,
    1,
  );
});
