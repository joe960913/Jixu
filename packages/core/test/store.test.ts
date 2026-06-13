import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRunEvent,
  InMemoryEventStore,
  RevisionConflictError,
} from "../src/index.ts";

const snapshot = {
  instructions: "Be precise.",
  model: { model: "deterministic", provider: "mock" },
  tools: [],
} as const;

test("JX-AC-012 two writers cannot commit at the same Run revision", async () => {
  const store = new InMemoryEventStore();
  await store.createRun("run-1");
  const first = createRunEvent({
    id: "event-1",
    payload: { agent: snapshot },
    runId: "run-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "run.created",
  });
  const second = createRunEvent({
    id: "event-2",
    payload: { agent: snapshot },
    runId: "run-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "run.created",
  });

  const results = await Promise.allSettled([
    store.append("run-1", 0, first),
    store.append("run-1", 0, second),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection !== undefined && rejection.status === "rejected");
  assert.ok(rejection.reason instanceof RevisionConflictError);
  assert.equal((await store.read("run-1")).length, 1);
});
