import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createThreadEvent,
  DEFAULT_CONTEXT_POLICY,
} from "../../core/src/index.ts";
import { defineStoreContract } from "../../testkit/src/store-contract.ts";
import { SqliteEventStore } from "../src/index.ts";

defineStoreContract("SqliteEventStore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jixu-sqlite-contract-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  return {
    cleanup: async () => {
      store.close();
      await rm(directory, { force: true, recursive: true });
    },
    store,
  };
});

test("JX-AC-003 SqliteEventStore survives adapter reconstruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jixu-sqlite-reopen-"));
  const path = join(directory, "events.sqlite");
  let first: SqliteEventStore | undefined;
  let reopened: SqliteEventStore | undefined;
  try {
    first = new SqliteEventStore(path);
    await first.createThread("durable-sqlite");
    const event = createThreadEvent({
      id: "durable-sqlite-event",
      payload: {
        agent: {
          contextPolicy: DEFAULT_CONTEXT_POLICY,
          instructions: "persist",
          model: { model: "deterministic", provider: "mock" },
          modelCapabilities: {
            contextWindowTokens: 32_768,
            maxOutputTokens: 4_096,
            resolvedModel: "deterministic",
            schemaVersion: 1,
            source: { kind: "explicit", name: "sqlite-store-test" },
          },
          tools: [],
        },
      },
      threadId: "durable-sqlite",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "thread.created",
    });
    await first.append("durable-sqlite", 0, event);
    first.close();
    first = undefined;

    reopened = new SqliteEventStore(path);
    assert.deepEqual(await reopened.read("durable-sqlite"), [event]);
  } finally {
    first?.close();
    reopened?.close();
    await rm(directory, { force: true, recursive: true });
  }
});
