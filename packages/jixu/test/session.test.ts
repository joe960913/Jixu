import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createRuntime,
  defineAgent,
  InMemoryEventStore,
} from "@jixu/core";
import type {
  ModelDriver,
  ModelGenerateEffect,
  ModelOutcome,
  ModelDriverContext,
} from "@jixu/core";
import { createNodeTools } from "@jixu/tools-node";

import { createJixuSession } from "../src/session.ts";

test("JX-AC-015 ordinary Agent is runnable through the session with live Signals and Node Tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "jixu-session-"));
  try {
    await writeFile(join(root, "note.txt"), "durable hello", "utf8");
    let calls = 0;
    const driver: ModelDriver = {
      async generate(
        effect: ModelGenerateEffect,
        context: ModelDriverContext,
      ): Promise<ModelOutcome> {
        calls += 1;
        if (calls === 1) {
          context.signals.emit({
            data: { delta: "Reading" },
            kind: "signal",
            runId: effect.runId,
            type: "model.output_text.delta",
          });
          return {
            status: "succeeded",
            value: {
              content: "",
              toolCalls: [
                {
                  arguments: { path: "note.txt" },
                  id: "call-read",
                  name: "read",
                },
              ],
            },
          };
        }
        if (calls === 2) {
          const toolMessage = effect.input.messages.at(-1);
          assert.equal(toolMessage?.role, "tool");
          if (toolMessage?.role === "tool") {
            assert.deepEqual(toolMessage.output, {
              content: "durable hello",
              path: "note.txt",
              truncated: false,
            });
          }
          return {
            status: "succeeded",
            value: { content: "The file says durable hello.", toolCalls: [] },
          };
        }
        return {
          status: "succeeded",
          value: { content: "Fork continued.", toolCalls: [] },
        };
      },
    };
    const store = new InMemoryEventStore();
    const runtime = createRuntime({ modelDrivers: { mock: driver }, store });
    const tools = createNodeTools({ root });
    const agent = defineAgent({
      instructions: "Use the available tools.",
      model: { model: "deterministic", provider: "mock" },
      tools: tools.all,
    });
    let quit = false;
    const session = createJixuSession({
      agent,
      onQuit: () => {
        quit = true;
      },
      runtime,
    });
    assert.deepEqual(session.getSnapshot().transcript, []);
    const observedLiveText: string[] = [];
    const unsubscribe = session.subscribe(() => {
      observedLiveText.push(session.getSnapshot().streamingText);
    });

    await session.submit("Read note.txt");

    const completed = session.getSnapshot();
    assert.equal(completed.busy, false);
    assert.equal(completed.runStatus, "completed");
    assert.ok(observedLiveText.includes("Reading"));
    assert.equal(completed.transcript[0]?.role, "user");
    assert.equal(completed.transcript.at(-1)?.role, "assistant");
    assert.equal(completed.transcript.at(-1)?.content, "The file says durable hello.");
    assert.ok(completed.activity.some((entry) => entry.detail === "read"));
    assert.ok(
      completed.activity.some(
        (entry) => entry.kind === "tool" && entry.label === "Tool completed",
      ),
    );
    // JX-AC-018: shared sequence IDs let the TUI render activity causally inline.
    const firstThinking = completed.activity.find(
      (entry) => entry.kind === "model" && entry.label === "Thinking",
    );
    assert.ok((firstThinking?.id ?? 0) > (completed.transcript[0]?.id ?? 0));
    assert.ok((firstThinking?.id ?? 0) < (completed.transcript.at(-1)?.id ?? 0));

    await session.submit("/events");
    assert.equal(session.getSnapshot().inspection?.title, "Durable Events");
    assert.match(session.getSnapshot().inspection?.content ?? "", /tool\.completed/);

    await session.submit("/state");
    assert.equal(session.getSnapshot().inspection?.title, "Authoritative state");
    assert.match(session.getSnapshot().inspection?.content ?? "", /"status": "completed"/);

    await session.submit("/replay");
    assert.equal(session.getSnapshot().inspection?.title, "Replay result");
    assert.match(session.getSnapshot().inspection?.content ?? "", /"revision": 8/);

    const firstRunId = completed.currentRunId;
    assert.notEqual(firstRunId, null);
    if (firstRunId === null) return;
    const forkPoint = (await store.read(firstRunId))[0];
    assert.notEqual(forkPoint, undefined);
    if (forkPoint === undefined) return;

    await session.submit(`/fork ${forkPoint.id} Try another direction`);
    const forked = session.getSnapshot();
    assert.equal(forked.runStatus, "completed");
    assert.notEqual(forked.currentRunId, firstRunId);
    assert.equal(forked.transcript.at(-1)?.content, "Fork continued.");
    assert.ok(forked.activity.some((entry) => entry.label === "Run forked"));

    await session.submit("/quit");
    assert.equal(quit, true);
    unsubscribe();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
