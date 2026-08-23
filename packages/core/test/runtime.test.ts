import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CURRENT_EVENT_SCHEMA_VERSION,
  createHarness,
  decodeThreadEvent,
  defineAgent,
  defineSchema,
  defineTool,
  InMemoryEventStore,
  replayEvents,
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
  fail,
  SequenceIdGenerator,
  SequenceModelDriver,
  succeed,
} from "../../testkit/src/index.ts";

const TEST_MODEL_CAPABILITIES = {
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  resolvedModel: "deterministic",
  source: { kind: "explicit", name: "runtime-test" },
} as const;

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
    modelCapabilities: TEST_MODEL_CAPABILITIES,
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
  const events = await thread.events();

  assert.equal((await thread.state()).status, "idle");
  assert.equal((await thread.state()).activePlan, null);
  assert.equal(
    (await thread.events()).some((event) => event.type === "plan.updated"),
    false,
  );
  assert.equal(model.effects.length, 3);
  assert.deepEqual(model.effects[0]?.input.runtimeContext?.continuation, {
    causedByEventId: events[1]?.id,
    reason: "input_received",
    receipt: { eventId: events[1]?.id, type: "input.received" },
  });
  assert.deepEqual(model.effects[1]?.input.runtimeContext?.continuation, {
    causedByEventId: events[5]?.id,
    reason: "tool_completed",
    receipt: {
      eventId: events[5]?.id,
      toolCallId: "weather-1",
      toolName: "weather",
      type: "tool.completed",
    },
  });
  assert.deepEqual(model.effects[1]?.input.runtimeContext?.obligations, [
    "respond_or_act",
  ]);
  assert.equal(
    model.effects[1]?.input.contextManifest?.sources.find(
      (source) => source.kind === "runtime",
    )?.disposition,
    "included",
  );
  assert.deepEqual(model.effects[2]?.input.messages.slice(-2), [
    { content: "Shanghai is sunny.", role: "assistant", toolCalls: [] },
    { content: "Challenge that answer.", role: "user" },
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
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

test("JX-AC-053 Thread mode is durable, idempotent, clear-safe, and inherited by Fork", async () => {
  const store = new InMemoryEventStore();
  const agent = agentWith();
  const model = new SequenceModelDriver([
    succeed({ content: "Parent used Ultra.", toolCalls: [] }),
    succeed({ content: "Child inherited Ultra.", toolCalls: [] }),
  ]);
  const harness = createHarness({
    agent,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
    store,
  });
  const thread = await harness.createThread();

  assert.equal((await thread.state()).mode, "standard");
  const ultra = await thread.setMode("ultra");
  assert.equal(ultra.mode, "ultra");
  const afterFirstChange = await thread.events();
  await thread.setMode("ultra");
  assert.equal((await thread.events()).length, afterFirstChange.length);

  await thread.send("Use full reasoning.");
  assert.equal(model.effects[0]?.input.mode, "ultra");
  assert.equal((await thread.clear()).mode, "ultra");
  assert.equal((await thread.replay()).mode, "ultra");

  const modeEvent = afterFirstChange.find(
    (event) => event.type === "thread.mode_changed",
  );
  assert.ok(modeEvent !== undefined);
  const child = await thread.fork({
    at: modeEvent.id,
    input: "Continue from Ultra.",
  });
  assert.equal((await child.wait()).mode, "ultra");
  assert.equal(model.effects[1]?.input.mode, "ultra");

  const reopened = await createHarness({
    agent,
    modelDrivers: { mock: new SequenceModelDriver([]) },
    store,
  }).openThread(thread.id);
  assert.equal((await reopened.state()).mode, "ultra");
  assert.equal((await reopened.setMode("standard")).mode, "standard");
});

test("JX-AC-047 Tool ask is durable and only allow_once dispatches the pending Effect", async () => {
  let executions = 0;
  const tool = defineTool({
    authorization: { action: "inspect", resources: () => ["workspace/file.ts"] },
    description: "Inspect a file",
    execute: () => {
      executions += 1;
      return "inspected";
    },
    idempotency: "idempotent",
    input: objectSchema,
    name: "inspect",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [{ arguments: {}, id: "inspect-1", name: "inspect" }],
    }),
    succeed({ content: "Inspection complete.", toolCalls: [] }),
  ]);
  const thread = await createHarness({
    agent: agentWith([tool]),
    modelDrivers: { mock: model },
    toolPermissionPolicy: { defaultEffect: "ask", rules: [] },
  }).createThread();

  const waiting = await thread.send("Inspect it");
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.waitingReason?.reasonCode, "tool_approval_required");
  assert.equal(executions, 0);
  const approval = Object.values(waiting.toolApprovals)[0];
  assert.ok(approval !== undefined);
  assert.equal(approval.action, "inspect");
  assert.deepEqual(approval.resources, ["workspace/file.ts"]);

  const completed = await thread.decideApproval(
    approval.effectId,
    "allow_once",
  );
  assert.equal(completed.status, "idle");
  assert.equal(completed.result, "Inspection complete.");
  assert.equal(executions, 1);
  assert.deepEqual(
    (await thread.events())
      .filter((event) => event.type.startsWith("approval."))
      .map((event) => event.type),
    ["approval.requested", "approval.decided"],
  );
});

test("JX-AC-010 JX-AC-047 JX-AC-049 denied Tool Effects remain in the Agent loop without driver execution", async () => {
  let executions = 0;
  const tool = defineTool({
    description: "Dangerous operation",
    execute: () => {
      executions += 1;
      return "unexpected";
    },
    input: objectSchema,
    name: "danger",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [{ arguments: {}, id: "danger-1", name: "danger" }],
    }),
    succeed({ content: "The operation was denied.", toolCalls: [] }),
  ]);
  const thread = await createHarness({
    agent: agentWith([tool]),
    modelDrivers: { mock: model },
    toolPermissionPolicy: {
      defaultEffect: "allow",
      rules: [{ action: "danger", effect: "deny", resource: "*" }],
    },
  }).createThread();

  const state = await thread.send("Try it");
  assert.equal(state.status, "idle");
  assert.equal(state.error, null);
  assert.equal(state.result, "The operation was denied.");
  assert.equal(executions, 0);
  const failure = (await thread.events()).findLast(
    (event) => event.type === "tool.failed",
  );
  assert.equal(failure?.type, "tool.failed");
  if (failure?.type === "tool.failed") {
    assert.equal(failure.payload.error.code, "tool_permission_denied");
    assert.equal(failure.payload.disposition, "failed");
  }
  assert.equal(model.effects.length, 2);
  assert.deepEqual(model.effects[1]?.input.messages.at(-1), {
    disposition: "failed",
    error: {
      code: "tool_permission_denied",
      message: "Tool danger is denied by the configured permission policy",
      retryable: false,
    },
    name: "danger",
    role: "tool",
    toolCallId: "danger-1",
  });
  assert.deepEqual(model.effects[1]?.input.runtimeContext, {
    continuation: {
      causedByEventId: failure?.id,
      reason: "tool_failed",
      receipt: {
        errorCode: "tool_permission_denied",
        errorMessage: "Tool danger is denied by the configured permission policy",
        errorRetryable: false,
        eventId: failure?.id,
        toolCallId: "danger-1",
        toolDisposition: "failed",
        toolName: "danger",
        type: "tool.failed",
      },
    },
    obligations: ["handle_tool_failure", "respond_or_act"],
    planRepair: null,
    prohibitions: ["assume_failed_tool_succeeded"],
    schemaVersion: 2,
  });
});

test("JX-AC-010 JX-AC-039 JX-AC-049 typed Tool rejection is model-visible and continues the turn", async () => {
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
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [{ arguments: {}, id: "typed-1", name: "typed" }],
    }),
    succeed({ content: "That path is outside the configured scope.", toolCalls: [] }),
  ]);
  const thread = await createHarness({
    agent: agentWith([typed]),
    modelDrivers: { mock: model },
  }).createThread();

  const state = await thread.send("Call typed");
  const failure = (await thread.events()).findLast(
    (event) => event.type === "tool.failed",
  );
  assert.equal(failure?.payload.disposition, "failed");
  assert.equal(failure?.payload.error.code, "tool_path_outside_scope");
  assert.equal(state.status, "idle");
  assert.equal(state.result, "That path is outside the configured scope.");
  assert.equal(model.effects.length, 2);
  assert.deepEqual(model.effects[1]?.input.messages.at(-1), {
    disposition: "failed",
    error: {
      code: "tool_path_outside_scope",
      message: "Path escapes the configured scope",
      retryable: false,
    },
    name: "typed",
    role: "tool",
    toolCallId: "typed-1",
  });
  assert.equal(
    model.effects[1]?.input.runtimeContext?.continuation.reason,
    "tool_failed",
  );

  const events = await thread.events();
  const failureIndex = events.findIndex((event) => event.id === failure?.id);
  const legacyEvents = events
    .slice(0, failureIndex + 1)
    .map((event) => ({ ...event, schemaVersion: 10 }));
  const legacyState = replayEvents(thread.id, legacyEvents);
  assert.equal(legacyState.status, "idle");
  assert.equal(legacyState.error?.code, "tool_path_outside_scope");
  assert.equal(
    legacyState.messages.some(
      (message) => message.role === "tool" && "error" in message,
    ),
    false,
  );
  const currentContinuation = events.find(
    (event, index) => index > failureIndex && event.type === "model.requested",
  );
  assert.ok(currentContinuation !== undefined);
  assert.throws(
    () => decodeThreadEvent({ ...currentContinuation, schemaVersion: 10 }),
    /requires Event schema 11/,
  );
});

test("JX-AC-001 JX-AC-010 JX-AC-049 a mixed Tool batch waits for every receipt and continues from its failure", async () => {
  const bad = defineTool({
    description: "Fail deterministically",
    execute: () => {
      throw new ToolExecutionError("fixture_failed", "Fixture failed", true);
    },
    input: objectSchema,
    name: "bad",
    output: stringSchema,
  });
  const good = defineTool({
    description: "Succeed deterministically",
    execute: () => "ok",
    input: objectSchema,
    name: "good",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [
        { arguments: {}, id: "bad-1", name: "bad" },
        { arguments: {}, id: "good-1", name: "good" },
      ],
    }),
    succeed({ content: "One Tool failed and the other succeeded.", toolCalls: [] }),
  ]);
  const thread = await createHarness({
    agent: agentWith([bad, good]),
    modelDrivers: { mock: model },
  }).createThread();

  const state = await thread.send("Run both");
  assert.equal(state.status, "idle");
  assert.equal(state.result, "One Tool failed and the other succeeded.");
  assert.deepEqual(
    model.effects[1]?.input.messages.slice(-2).map((message) =>
      message.role === "tool" && "error" in message
        ? { disposition: message.disposition, name: message.name }
        : message.role === "tool"
          ? { name: message.name, output: message.output }
          : message
    ),
    [
      { disposition: "failed", name: "bad" },
      { name: "good", output: "ok" },
    ],
  );
  assert.equal(
    model.effects[1]?.input.runtimeContext?.continuation.reason,
    "tool_failed",
  );
  assert.equal(
    model.effects[1]?.input.runtimeContext?.continuation.receipt.toolCallId,
    "bad-1",
  );
});

test("JX-AC-004 JX-AC-005 JX-AC-039 JX-AC-049 indeterminate Tool failure is explained once and waits without redispatch", async () => {
  const unknown = defineTool({
    description: "Throw an unknown exception",
    execute: () => {
      throw new Error("Unknown execution state");
    },
    input: objectSchema,
    name: "unknown",
    output: stringSchema,
  });

  const store = new InMemoryEventStore();
  const agent = agentWith([unknown]);
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [{ arguments: {}, id: "unknown-1", name: "unknown" }],
    }),
    succeed({
      content: "The Tool outcome is unknown, so I stopped before taking more action.",
      toolCalls: [],
    }),
  ]);
  const thread = await createHarness({
    agent,
    modelDrivers: { mock: model },
    store,
  }).createThread();

  const state = await thread.send("Call unknown");
  const failure = (await thread.events()).findLast(
    (event) => event.type === "tool.failed",
  );
  assert.equal(failure?.payload.disposition, "indeterminate");
  assert.equal(failure?.payload.error.code, "tool_driver_exception");
  assert.equal(state.status, "waiting");
  assert.deepEqual(state.waitingReason, {
    effectId: failure?.payload.effectId,
    reasonCode: "effect_outcome_unknown",
  });
  assert.equal(state.pendingEffects[failure?.payload.effectId ?? ""]?.attempt, 1);
  assert.equal(model.effects.length, 2);
  assert.deepEqual(state.messages.at(-2), {
    disposition: "indeterminate",
    error: {
      code: "tool_driver_exception",
      message: "Unknown execution state",
      retryable: false,
    },
    name: "unknown",
    role: "tool",
    toolCallId: "unknown-1",
  });
  assert.deepEqual(model.effects[1]?.input.runtimeContext, {
    continuation: {
      causedByEventId: failure?.id,
      reason: "tool_indeterminate",
      receipt: {
        errorCode: "tool_driver_exception",
        errorMessage: "Unknown execution state",
        errorRetryable: false,
        eventId: failure?.id,
        toolCallId: "unknown-1",
        toolDisposition: "indeterminate",
        toolName: "unknown",
        type: "tool.failed",
      },
    },
    obligations: ["explain_unknown_tool_outcome"],
    planRepair: null,
    prohibitions: [
      "assume_failed_tool_succeeded",
      "perform_tool_or_plan_actions",
    ],
    schemaVersion: 2,
  });
  const explanationRequest = (await thread.events()).findLast(
    (event) => event.type === "model.requested",
  );
  assert.ok(explanationRequest !== undefined);
  assert.deepEqual(decodeThreadEvent(explanationRequest), explanationRequest);
  assert.equal(
    state.result,
    "The Tool outcome is unknown, so I stopped before taking more action.",
  );
  assert.deepEqual(await thread.replay(), state);

  const recoveryModel = new SequenceModelDriver([
    succeed({ content: "must not run", toolCalls: [] }),
  ]);
  const reopened = await createHarness({
    agent,
    modelDrivers: { mock: recoveryModel },
    store,
  }).openThread(thread.id);
  assert.equal((await reopened.state()).status, "waiting");
  assert.equal(recoveryModel.effects.length, 0);

  const events = await thread.events();
  const failureIndex = events.findIndex((event) => event.id === failure?.id);
  const legacyState = replayEvents(
    thread.id,
    events
      .slice(0, failureIndex + 1)
      .map((event) => ({ ...event, schemaVersion: 10 })),
  );
  assert.equal(legacyState.status, "waiting");
  assert.equal(legacyState.error?.code, "tool_driver_exception");
  assert.equal(
    legacyState.messages.some(
      (message) => message.role === "tool" && "error" in message,
    ),
    false,
  );
});

test("JX-AC-005 JX-AC-049 multiple indeterminate Tool outcomes share one constrained explanation", async () => {
  let executions = 0;
  const unknownTool = (name: string) =>
    defineTool({
      description: `Unknown ${name}`,
      execute: () => {
        executions += 1;
        throw new Error(`${name} outcome unknown`);
      },
      input: objectSchema,
      name,
      output: stringSchema,
    });
  const first = unknownTool("unknown_first");
  const second = unknownTool("unknown_second");
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [
        { arguments: {}, id: "unknown-1", name: "unknown_first" },
        { arguments: {}, id: "unknown-2", name: "unknown_second" },
      ],
    }),
    succeed({
      content: "Both Tool outcomes are unknown; no further action was taken.",
      planUpdates: [
        planUpdate("create", "Must be suppressed", ["pending"], null),
      ],
      toolCalls: [
        { arguments: {}, id: "must-not-run", name: "unknown_first" },
      ],
    }),
  ]);
  const thread = await createHarness({
    agent: agentWith([first, second]),
    modelDrivers: { mock: model },
  }).createThread();

  const state = await thread.send("Run both unknown Tools");
  const events = await thread.events();
  const failures = events.filter((event) => event.type === "tool.failed");
  const pending = Object.values(state.pendingEffects);

  assert.equal(executions, 2);
  assert.equal(failures.length, 2);
  assert.equal(model.effects.length, 2);
  assert.equal(state.status, "waiting");
  assert.equal(state.activePlan, null);
  assert.equal(state.pendingPlanUpdates.length, 0);
  assert.equal(pending.length, 2);
  assert.ok(pending.every((effect) => effect.type === "tool.execute"));
  assert.ok(
    pending.every((effect) =>
      failures.some(
        (failure) =>
          failure.type === "tool.failed" &&
          failure.payload.effectId === effect.id &&
          failure.payload.disposition === "indeterminate",
      ),
    ),
  );
  assert.ok(state.waitingReason !== null);
  assert.ok(
    pending.some((effect) => effect.id === state.waitingReason?.effectId),
  );
  assert.deepEqual(
    model.effects[1]?.input.messages
      .filter((message) => message.role === "tool" && "error" in message)
      .map((message) =>
        message.role === "tool" && "error" in message
          ? {
              disposition: message.disposition,
              message: message.error.message,
              name: message.name,
            }
          : null
      ),
    [
      {
        disposition: "indeterminate",
        message: "unknown_first outcome unknown",
        name: "unknown_first",
      },
      {
        disposition: "indeterminate",
        message: "unknown_second outcome unknown",
        name: "unknown_second",
      },
    ],
  );
  assert.equal(
    model.effects[1]?.input.runtimeContext?.continuation.reason,
    "tool_indeterminate",
  );
  assert.deepEqual(state.messages.at(-1), {
    content: "Both Tool outcomes are unknown; no further action was taken.",
    role: "assistant",
    toolCalls: [],
  });
  assert.equal(
    events.filter((event) => event.type === "model.requested").length,
    2,
  );
  assert.equal(
    events.filter((event) => event.type === "tool.requested").length,
    2,
  );
  assert.equal(events.some((event) => event.type === "plan.updated"), false);
  const explanation = events.findLast(
    (event) => event.type === "model.completed",
  );
  assert.equal(explanation?.type, "model.completed");
  if (explanation?.type === "model.completed") {
    assert.equal(explanation.payload.response.toolCalls.length, 1);
    assert.equal(explanation.payload.response.planUpdates?.length, 1);
  }
  assert.deepEqual(await thread.replay(), state);
});

test("JX-AC-005 indeterminate explanation failure preserves the unknown Tool wait", async () => {
  const unknown = defineTool({
    description: "Unknown outcome",
    execute: () => {
      throw new Error("Side effect may have happened");
    },
    input: objectSchema,
    name: "unknown_failure",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [
        { arguments: {}, id: "unknown-failure-1", name: "unknown_failure" },
      ],
    }),
    fail("explanation_unavailable", "Could not explain", true),
  ]);
  const thread = await createHarness({
    agent: agentWith([unknown]),
    modelDrivers: { mock: model },
  }).createThread();

  const state = await thread.send("Run it");
  assert.equal(state.status, "waiting");
  assert.equal(state.error?.code, "tool_driver_exception");
  assert.equal(state.result, null);
  assert.equal(Object.keys(state.pendingEffects).length, 1);
  assert.equal(model.effects.length, 2);
  assert.equal(
    (await thread.events()).findLast((event) => event.type === "model.failed")
      ?.payload.error.code,
    "explanation_unavailable",
  );
  assert.deepEqual(await thread.replay(), state);
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
      cancelled: 0,
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
      cancelled: 0,
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
        planUpdate(
          "supersede",
          replacementObjective,
          ["in_progress"],
          "Run checks",
        ),
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

test("JX-AC-031 Plan-only control commits before a model-generated public continuation", async () => {
  const objective = "Create a reliable execution Plan";
  const publicReply = "I created the Plan and it is ready to use.";
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      planUpdates: [
        planUpdate("create", objective, ["in_progress", "pending"], "Inspect"),
      ],
      toolCalls: [],
    }),
    succeed({ content: publicReply, toolCalls: [] }),
  ]);
  const thread = await createHarness({
    agent: agentWith(),
    modelDrivers: { mock: model },
  }).createThread();

  const state = await thread.send("Create a Plan");
  const events = await thread.events();

  assert.equal(state.result, publicReply);
  assert.equal(state.activePlan?.objective, objective);
  assert.equal(model.effects.length, 2);
  assert.equal(model.effects[1]?.input.activePlan?.objective, objective);
  assert.equal(
    model.effects[1]?.input.runtimeContext?.continuation.reason,
    "plan_updated",
  );
  assert.deepEqual(
    model.effects[1]?.input.runtimeContext?.continuation.receipt,
    {
      eventId: events[4]?.id,
      planId: state.activePlan?.id,
      planRevision: 1,
      planStatus: "active",
      type: "plan.updated",
    },
  );
  assert.deepEqual(model.effects[1]?.input.runtimeContext?.obligations, [
    "respond_or_act",
  ]);
  assert.deepEqual(model.effects[1]?.input.runtimeContext?.prohibitions, [
    "repeat_accepted_plan_change",
  ]);
  assert.equal(
    model.effects[1]?.input.contextManifest?.activePlanRevision,
    1,
  );
  assert.deepEqual(
    model.effects[1]?.input.contextManifest?.sources.map((source) => source.kind),
    ["agent", "tools", "active_plan", "handoff", "message", "runtime"],
  );
  assert.deepEqual(model.effects[1]?.input.messages, [
    { content: "Create a Plan", role: "user" },
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "thread.created",
      "input.received",
      "model.requested",
      "model.completed",
      "plan.updated",
      "model.requested",
      "model.completed",
    ],
  );
});

test("JX-AC-031 rejected Plan-only control feeds correction back to the model", async () => {
  const objective = "Inspect the repository without executing";
  const publicReply = "I created the Plan and will wait for your instruction.";
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      planUpdates: [planUpdate("create", objective, ["pending"], null)],
      toolCalls: [],
    }),
    succeed({
      content: publicReply,
      planUpdates: [
        planUpdate("create", objective, ["pending"], "Wait for user instruction"),
      ],
      toolCalls: [],
    }),
  ]);
  const thread = await createHarness({
    agent: agentWith(),
    modelDrivers: { mock: model },
  }).createThread();

  const state = await thread.send("Create a Plan but do not execute it");
  const events = await thread.events();

  assert.equal(state.result, publicReply);
  assert.equal(state.activePlan?.objective, objective);
  assert.equal(model.effects.length, 2);
  assert.match(
    model.effects[1]?.input.planRejectionFeedback ?? "",
    /nextAction is required while active/,
  );
  assert.equal(
    model.effects[1]?.input.runtimeContext?.continuation.reason,
    "plan_rejected",
  );
  assert.deepEqual(
    model.effects[1]?.input.runtimeContext?.continuation.receipt,
    {
      errorCode: "plan_update_invalid",
      errorMessage:
        "Plan updates[0].nextAction is required while active",
      eventId: events[4]?.id,
      type: "plan.rejected",
    },
  );
  assert.deepEqual(model.effects[1]?.input.runtimeContext?.obligations, [
    "repair_plan_control",
    "respond_or_act",
  ]);
  assert.deepEqual(model.effects[1]?.input.runtimeContext?.planRepair, {
    attempt: 1,
    limit: 1,
  });
  assert.deepEqual(model.effects[1]?.input.runtimeContext?.prohibitions, [
    "repeat_rejected_plan_change",
  ]);
  assert.deepEqual(
    model.effects[1]?.input.planControl,
    model.effects[0]?.input.planControl,
  );
  assert.deepEqual(model.effects[1]?.input.messages, [
    { content: "Create a Plan but do not execute it", role: "user" },
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "thread.created",
      "input.received",
      "model.requested",
      "model.completed",
      "plan.rejected",
      "model.requested",
      "model.completed",
      "plan.updated",
    ],
  );
});

test("JX-AC-049 repeated invalid Plan repair settles without an unbounded model loop", async () => {
  const rejection = {
    code: "plan_update_invalid",
    message: "Plan control call-invalid.steps[0] must be a JSON object",
    retryable: false,
  } as const;
  const invalid = {
    planRejections: [rejection],
    status: "succeeded" as const,
    value: { content: "", planUpdates: [], toolCalls: [] },
  };
  const model = new SequenceModelDriver([invalid, invalid]);
  const thread = await createHarness({
    agent: agentWith(),
    modelDrivers: { mock: model },
  }).createThread();

  const state = await thread.send("Create a Plan but do not execute it");
  const events = await thread.events();

  assert.equal(state.status, "idle");
  assert.equal(state.error?.code, "plan_repair_exhausted");
  assert.equal(state.planRepairAttempts, 2);
  assert.equal(model.effects.length, 2);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "thread.created",
      "input.received",
      "model.requested",
      "model.completed",
      "plan.rejected",
      "model.requested",
      "model.completed",
      "plan.rejected",
    ],
  );
  assert.equal(
    events.filter((event) => event.type === "model.requested").length,
    2,
  );
});

test("JX-AC-031 malformed Plan metadata retries without model.failed and can abandon", async () => {
  const objective = "Inspect the repository";
  const model = new SequenceModelDriver([
    succeed({
      content: "Plan created.",
      planUpdates: [
        planUpdate("create", objective, ["pending"], "Wait for user instruction"),
      ],
      toolCalls: [],
    }),
    {
      planRejections: [{
        code: "plan_update_invalid",
        message: "Plan control call-1.steps[0] must be a JSON object",
        retryable: false,
      }],
      status: "succeeded",
      value: { content: "", planUpdates: [], toolCalls: [] },
    },
    succeed({
      content: "Plan cancelled.",
      planUpdates: [planUpdate("abandon", objective, ["pending"], null)],
      toolCalls: [],
    }),
  ]);
  const thread = await createHarness({
    agent: agentWith(),
    modelDrivers: { mock: model },
  }).createThread();

  await thread.send("Create a Plan");
  const beforeCancel = (await thread.events()).length;
  const state = await thread.send("Cancel the Plan");
  const cancelEvents = (await thread.events()).slice(beforeCancel);

  assert.equal(state.result, "Plan cancelled.");
  assert.equal(state.activePlan, null);
  assert.deepEqual(
    model.effects[1]?.input.planControl.inputSchema.required,
    ["operation"],
  );
  assert.equal(cancelEvents.some((event) => event.type === "model.failed"), false);
  assert.deepEqual(
    cancelEvents.map((event) => event.type),
    [
      "input.received",
      "model.requested",
      "model.completed",
      "plan.rejected",
      "model.requested",
      "model.completed",
      "plan.updated",
    ],
  );
  assert.match(
    model.effects[2]?.input.planRejectionFeedback ?? "",
    /steps\[0\] must be a JSON object/,
  );
  assert.deepEqual(
    model.effects[2]?.input.planControl,
    model.effects[1]?.input.planControl,
  );
  assert.equal(
    model.effects[2]?.input.messages.some(
      (message) =>
        message.role === "assistant" && message.content.trim().length === 0,
    ),
    false,
  );
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

test("JX-AC-020 JX-AC-052 queued multimodal input is durable and starts in Event order", async () => {
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
  const secondAccepted = (async () => {
    let acceptedCount = 0;
    for await (const item of thread.stream()) {
      if (item.kind === "event" && item.event.type === "input.received") {
        acceptedCount += 1;
        if (acceptedCount === 2) return;
      }
    }
    assert.fail("Thread stream ended before the queued input was accepted");
  })();
  const second = thread.send({
    content: [
      { text: "帮我看看这个 ", type: "text" },
      {
        data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
        mediaType: "image/png",
        placeholder: "pasted image 1",
        type: "image",
      },
      { text: " 是啥， 这个 ", type: "text" },
      {
        data: Uint8Array.from([255, 216, 255, 2]),
        mediaType: "image/jpeg",
        placeholder: "pasted image 2",
        type: "image",
      },
      { text: " 又是啥", type: "text" },
    ],
  });
  await secondAccepted;
  const accepted = (await thread.events()).filter(
    (event) => event.type === "input.received",
  );
  assert.deepEqual(accepted.map((event) => event.payload.content), [
    "first",
    "帮我看看这个 [pasted image 1] 是啥， 这个 [pasted image 2] 又是啥",
  ]);
  assert.equal(accepted[1]?.schemaVersion, CURRENT_EVENT_SCHEMA_VERSION);
  assert.doesNotMatch(JSON.stringify(accepted[1]), /iVBOR|\/9j/u);
  const structuredParts = accepted[1]?.payload.parts;
  assert.equal(structuredParts?.filter((part) => part.type === "image").length, 2);
  for (const part of structuredParts ?? []) {
    if (part.type === "image") {
      assert.equal(
        (await store.readArtifact(part.artifact)).byteLength,
        part.artifact.byteLength,
      );
    }
  }

  release(succeed({ content: "first reply", toolCalls: [] }));
  await Promise.all([first, second]);
  assert.equal((await thread.state()).status, "idle");
  assert.deepEqual(effects[1]?.input.messages.slice(-3), [
    { content: "first", role: "user" },
    { content: "first reply", role: "assistant", toolCalls: [] },
    {
      content:
        "帮我看看这个 [pasted image 1] 是啥， 这个 [pasted image 2] 又是啥",
      parts: structuredParts,
      role: "user",
    },
  ]);
  assert.deepEqual(await thread.replay(), await thread.state());
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
