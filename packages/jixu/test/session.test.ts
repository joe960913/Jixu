import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createHarness,
  defineAgent,
  InMemoryEventStore,
} from "@jixu/core";
import type {
  ModelDriver,
  ModelDriverContext,
  ModelGenerateEffect,
  ModelOutcome,
} from "@jixu/core";
import { createNodeTools } from "@jixu/tools-node";

import { createThreadController } from "../src/thread-controller.ts";

test("JX-AC-015 JX-AC-018 TUI controller uses the public multi-turn Thread path", async () => {
  const root = await mkdtemp(join(tmpdir(), "jixu-controller-"));
  try {
    await writeFile(join(root, "note.txt"), "durable hello", "utf8");
    let calls = 0;
    const effects: ModelGenerateEffect[] = [];
    const driver: ModelDriver = {
      async generate(
        effect: ModelGenerateEffect,
        context: ModelDriverContext,
      ): Promise<ModelOutcome> {
        calls += 1;
        effects.push(structuredClone(effect));
        if (calls === 1) {
          context.signals.emit({
            data: { delta: "Reading" },
            kind: "signal",
            threadId: effect.threadId,
            type: "model.output_text.delta",
          });
          return {
            status: "succeeded",
            value: {
              content: "",
              toolCalls: [
                { arguments: { path: "note.txt" }, id: "read-1", name: "read" },
              ],
            },
          };
        }
        if (calls === 2) {
          assert.equal(effect.input.messages.at(-1)?.role, "tool");
          return {
            status: "succeeded",
            value: { content: "The file says durable hello.", toolCalls: [] },
          };
        }
        return {
          status: "succeeded",
          value: { content: `reply-${calls}`, toolCalls: [] },
        };
      },
    };
    const tools = createNodeTools({ root });
    const agent = defineAgent({
      instructions: "Use the available tools.",
      model: { model: "deterministic", provider: "mock" },
      tools: tools.all,
    });
    const store = new InMemoryEventStore();
    const harness = createHarness({ agent, modelDrivers: { mock: driver }, store });
    let quit = false;
    const controller = createThreadController({
      harness,
      onQuit: () => {
        quit = true;
      },
    });
    const observedLiveText: string[] = [];
    const unsubscribe = controller.subscribe(() => {
      observedLiveText.push(controller.getSnapshot().streamingText);
    });

    await controller.submit("Read note.txt");
    const first = controller.getSnapshot();
    assert.equal(first.busy, false);
    assert.equal(first.threadStatus, "idle");
    assert.ok(observedLiveText.includes("Reading"));
    assert.equal(first.transcript.at(-1)?.content, "The file says durable hello.");
    const originalThreadId = first.currentThreadId;
    assert.notEqual(originalThreadId, null);
    if (originalThreadId === null) return;

    await controller.submit("Follow up");
    assert.equal(controller.getSnapshot().currentThreadId, originalThreadId);
    assert.deepEqual(effects[2]?.input.messages.slice(-2), [
      {
        content: "The file says durable hello.",
        role: "assistant",
        toolCalls: [],
      },
      { content: "Follow up", role: "user" },
    ]);

    await controller.submit("/events");
    assert.equal(controller.getSnapshot().inspection?.title, "Durable Events");
    await controller.submit("/state");
    assert.match(controller.getSnapshot().inspection?.content ?? "", /"status": "idle"/);
    await controller.submit("/replay");
    assert.equal(controller.getSnapshot().inspection?.title, "Replay result");

    await controller.submit("/clear");
    assert.deepEqual(controller.getSnapshot().transcript, []);
    await controller.submit("Fresh start");
    assert.equal(controller.getSnapshot().currentThreadId, originalThreadId);
    assert.deepEqual(effects[3]?.input.messages, [
      { content: "Fresh start", role: "user" },
    ]);

    await controller.submit("/new");
    const emptyThreadId = controller.getSnapshot().currentThreadId;
    assert.notEqual(emptyThreadId, originalThreadId);
    await controller.submit("/resume");
    assert.equal(controller.getSnapshot().threadPickerOpen, true);
    assert.ok(controller.getSnapshot().threads.length >= 2);
    await controller.selectThread(originalThreadId);
    assert.equal(controller.getSnapshot().currentThreadId, originalThreadId);
    assert.equal(controller.getSnapshot().transcript[0]?.content, "Fresh start");

    const forkPoint = (await store.read(originalThreadId)).at(-1);
    assert.notEqual(forkPoint, undefined);
    if (forkPoint !== undefined) {
      await controller.submit(`/fork ${forkPoint.id} Alternate path`);
      assert.notEqual(controller.getSnapshot().currentThreadId, originalThreadId);
      assert.equal(controller.getSnapshot().threadStatus, "idle");
    }

    await controller.submit("/quit");
    assert.equal(quit, true);
    unsubscribe();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
