import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialThreadState,
  createThreadEvent,
  EMPTY_MODEL_ACCOUNTING,
  reduce,
} from "../src/index.ts";

const snapshot = {
  instructions: "Be precise.",
  model: { model: "deterministic", provider: "mock" },
  tools: [],
} as const;

test("JX-AC-007 foundation: Reducer is deterministic and does not mutate input State", () => {
  const initial = createInitialThreadState("run-1");
  const created = createThreadEvent({
    id: "event-1",
    payload: { agent: snapshot },
    threadId: "run-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "thread.created",
  });
  const afterCreated = reduce(initial, created).state;
  const input = createThreadEvent({
    id: "event-2",
    payload: { content: "hello" },
    threadId: "run-1",
    sequence: 2,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "input.received",
  });
  const before = structuredClone(afterCreated);

  const first = reduce(afterCreated, input);
  const second = reduce(afterCreated, input);

  assert.deepEqual(first, second);
  assert.deepEqual(afterCreated, before);
  assert.equal(first.effects[0]?.id, "event-2:effect:0");
});

test("JX-AC-031 legacy schema 5 plan.rejected remains replayable", () => {
  const threadId = "thread-legacy-plan-rejection";
  let state = reduce(
    createInitialThreadState(threadId),
    createThreadEvent({
      id: "event-1",
      payload: { agent: snapshot },
      threadId,
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "thread.created",
    }),
  ).state;
  const input = reduce(
    state,
    createThreadEvent({
      id: "event-2",
      payload: { content: "Create a Plan" },
      threadId,
      sequence: 2,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "input.received",
    }),
  );
  state = input.state;
  const effect = input.effects[0];
  assert.notEqual(effect, undefined);
  if (effect === undefined || effect.type !== "model.generate") return;
  state = reduce(
    state,
    createThreadEvent({
      id: "event-3",
      payload: { effect },
      threadId,
      sequence: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "model.requested",
    }),
  ).state;
  state = reduce(
    state,
    createThreadEvent({
      id: "event-4",
      payload: {
        accounting: EMPTY_MODEL_ACCOUNTING,
        effectId: effect.id,
        response: { content: "", planUpdates: [], toolCalls: [] },
      },
      threadId,
      sequence: 4,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "model.completed",
    }),
  ).state;
  const proposal = {
    acceptanceCriteria: ["Plan is visible"],
    assumptions: [],
    blockers: [],
    nextAction: null,
    objective: "Inspect without executing",
    operation: "create" as const,
    steps: [{
      description: "Inspect later",
      evidence: [],
      id: "inspect",
      status: "pending" as const,
    }],
  };

  const legacy = reduce(
    state,
    createThreadEvent({
      id: "event-5",
      payload: {
        effectId: effect.id,
        error: {
          code: "plan_update_invalid",
          message: "Plan updates[0].nextAction is required while active",
          retryable: false,
        },
        proposals: [proposal],
      },
      threadId,
      sequence: 5,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "plan.rejected",
    }),
  );

  assert.equal(legacy.state.status, "idle");
  assert.equal(legacy.state.pendingPlanRejections.length, 0);
  assert.deepEqual(legacy.effects, []);
});

test("JX-STORE-009 replays historical reserved-control descriptors by logical Effect identity", () => {
  const threadId = "thread-historical-control-descriptor";
  let state = reduce(
    createInitialThreadState(threadId),
    createThreadEvent({
      id: "event-1",
      payload: { agent: snapshot },
      threadId,
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "thread.created",
    }),
  ).state;
  const input = reduce(
    state,
    createThreadEvent({
      id: "event-2",
      payload: { content: "Continue" },
      threadId,
      sequence: 2,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "input.received",
    }),
  );
  state = input.state;
  const effect = input.effects[0];
  assert.notEqual(effect, undefined);
  if (effect === undefined || effect.type !== "model.generate") return;

  const historical = {
    ...effect,
    input: {
      ...effect.input,
      planControl: {
        ...effect.input.planControl,
        description: "Historical Plan control description.",
        inputSchema: {
          ...effect.input.planControl.inputSchema,
          required: [
            "operation",
            "objective",
            "acceptanceCriteria",
            "steps",
            "assumptions",
            "blockers",
            "nextAction",
          ],
        },
      },
      progressControl: {
        ...effect.input.progressControl,
        description: "Historical progress control description.",
        inputSchema: { type: "object" },
      },
    },
  } as typeof effect;
  const requested = reduce(
    state,
    createThreadEvent({
      id: "event-3",
      payload: { effect: historical },
      threadId,
      sequence: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "model.requested",
    }),
  );

  assert.deepEqual(requested.state.pendingEffects[effect.id], historical);
  assert.deepEqual(requested.effects, []);
});
