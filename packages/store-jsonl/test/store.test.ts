import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createThreadEvent,
  DEFAULT_CONTEXT_POLICY,
} from "../../core/src/index.ts";
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
          contextPolicy: DEFAULT_CONTEXT_POLICY,
          instructions: "persist",
          model: { model: "deterministic", provider: "mock" },
          modelCapabilities: {
            contextWindowTokens: 32_768,
            maxOutputTokens: 4_096,
            resolvedModel: "deterministic",
            schemaVersion: 1,
            source: { kind: "explicit", name: "jsonl-store-test" },
          },
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

test("JX-STORE-010 JX-AC-057 constructor validation stays observed until Store readiness is awaited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jixu-jsonl-readiness-"));
  try {
    const threads = join(directory, "threads");
    await mkdir(threads, { recursive: true });
    await writeFile(
      join(threads, "incompatible.jsonl"),
      `${JSON.stringify({
        id: "incompatible-event",
        payload: {},
        schemaVersion: 99,
        sequence: 1,
        threadId: "incompatible",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "thread.created",
      })}\n`,
      "utf8",
    );

    const store = new JsonlEventStore(directory);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      store.listThreads(),
      /Event uses unsupported schema version 99/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
