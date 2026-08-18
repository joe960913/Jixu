import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createThreadEvent } from "../../core/src/index.ts";
import { defineStoreContract } from "../../testkit/src/store-contract.ts";
import { JsonlEventStore } from "../src/index.ts";

defineStoreContract("JsonlEventStore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jixu-jsonl-contract-"));
  return {
    cleanup: () => rm(directory, { force: true, recursive: true }),
    store: new JsonlEventStore(directory),
  };
});

test("JX-AC-003 JsonlEventStore survives adapter reconstruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jixu-jsonl-reopen-"));
  try {
    const first = new JsonlEventStore(directory);
    await first.createThread("durable-jsonl");
    const event = createThreadEvent({
      id: "durable-jsonl-event",
      payload: {
        agent: {
          instructions: "persist",
          model: { model: "deterministic", provider: "mock" },
          tools: [],
        },
      },
      threadId: "durable-jsonl",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "thread.created",
    });
    await first.append("durable-jsonl", 0, event);

    const reopened = new JsonlEventStore(directory);
    assert.deepEqual(await reopened.read("durable-jsonl"), [event]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
