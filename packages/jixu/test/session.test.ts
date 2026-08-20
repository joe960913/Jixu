import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createHarness,
  defineAgent,
  InMemoryEventStore,
  MODEL_PROGRESS_SIGNAL_TYPE,
} from "jixu-core";
import type {
  ModelDriver,
  ModelDriverContext,
  ModelGenerateEffect,
  ModelOutcome,
} from "jixu-core";
import { createNodeTools } from "jixu-tools-node";

import { createThreadController } from "../src/thread-controller.ts";
import type { ThreadControllerSnapshot } from "../src/tui-model.ts";

test("JX-AC-015 JX-AC-018 JX-AC-034 JX-AC-036 JX-AC-040 JX-AC-041 TUI keeps public text, Tool progress, and durable receipts continuous", async () => {
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
            data: { message: "Inspecting the requested note" },
            kind: "signal",
            threadId: effect.threadId,
            type: MODEL_PROGRESS_SIGNAL_TYPE,
          });
          context.signals.emit({
            data: { delta: "Re" },
            kind: "signal",
            threadId: effect.threadId,
            type: "model.output_text.delta",
          });
          context.signals.emit({
            data: { delta: "ad" },
            kind: "signal",
            threadId: effect.threadId,
            type: "model.output_text.delta",
          });
          await new Promise((resolve) => setTimeout(resolve, 35));
          context.signals.emit({
            data: { delta: "ing" },
            kind: "signal",
            threadId: effect.threadId,
            type: "model.output_text.delta",
          });
          await new Promise((resolve) => setTimeout(resolve, 40));
          return {
            status: "succeeded",
            value: {
              content: "Reading note.txt.",
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
        if (calls === 3) {
          return {
            status: "succeeded",
            value: {
              content: "I will verify this in two steps.",
              planUpdates: [
                {
                  acceptanceCriteria: ["The follow-up is verified"],
                  assumptions: [],
                  blockers: [],
                  nextAction: "Inspect the relevant state",
                  objective: "Verify the follow-up",
                  operation: "create",
                  steps: [
                    {
                      description: "Inspect the relevant state",
                      evidence: [],
                      id: "inspect",
                      status: "in_progress",
                    },
                    {
                      description: "Validate the result",
                      evidence: [],
                      id: "validate",
                      status: "pending",
                    },
                  ],
                },
              ],
              toolCalls: [],
            },
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
    const observedPresentation: Array<{
      readonly activity: ThreadControllerSnapshot["activity"];
      readonly streamingText: string;
      readonly transcript: ThreadControllerSnapshot["transcript"];
    }> = [];
    const observedToolOperations: string[] = [];
    const observedWorkStatus: string[] = [];
    const unsubscribe = controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      observedLiveText.push(snapshot.streamingText);
      observedPresentation.push({
        activity: snapshot.activity,
        streamingText: snapshot.streamingText,
        transcript: snapshot.transcript,
      });
      observedToolOperations.push(
        snapshot.toolOperations
          .map((operation) => `${operation.name}:${operation.status}`)
          .join(","),
      );
      if (snapshot.workStatus !== null) {
        observedWorkStatus.push(
          `${snapshot.workStatus.label}|${snapshot.workStatus.detail ?? ""}`,
        );
      }
    });

    await controller.submit("Read note.txt");
    const first = controller.getSnapshot();
    assert.equal(first.busy, false);
    assert.equal(first.threadStatus, "idle");
    assert.ok(observedLiveText.includes("Reading"));
    assert.ok(observedLiveText.includes("Read"));
    assert.equal(observedLiveText.includes("Re"), false);
    assert.ok(
      first.transcript.some(
        (entry) =>
          entry.kind === "message" && entry.content === "Reading note.txt.",
      ),
    );
    assert.ok(observedToolOperations.includes("read:running"));
    assert.ok(observedToolOperations.includes("read:succeeded"));
    assert.deepEqual(first.toolOperations, []);
    assert.equal(
      observedPresentation.some(
        (frame) =>
          frame.streamingText.length > 0 &&
          frame.transcript.some(
            (entry) =>
              entry.kind === "message" && entry.content === "Reading note.txt.",
          ),
      ),
      false,
    );
    const streamingFrames = observedPresentation.filter(
      (frame) => frame.streamingText.length > 0,
    );
    assert.ok(streamingFrames.length >= 2);
    assert.ok(
      streamingFrames.every(
        (frame) =>
          frame.activity === streamingFrames[0]?.activity &&
          frame.transcript === streamingFrames[0]?.transcript,
      ),
    );
    assert.ok(
      observedWorkStatus.includes(
        "Inspecting the requested note|Reading note.txt",
      ),
    );
    const firstReceipt = first.transcript.find(
      (entry) => entry.kind === "tool-receipts",
    );
    assert.equal(firstReceipt?.kind, "tool-receipts");
    if (firstReceipt?.kind === "tool-receipts") {
      assert.equal(firstReceipt.operations.length, 1);
      assert.equal(firstReceipt.operations[0]?.detail, "note.txt");
      assert.equal(firstReceipt.operations[0]?.name, "read");
      assert.equal(firstReceipt.operations[0]?.outcome, "1 line · 13 B");
      assert.equal(firstReceipt.operations[0]?.preview, "durable hello");
      assert.deepEqual(firstReceipt.operations[0]?.requestDetail, {
        content: "note.txt",
        kind: "text",
        label: "PATH",
      });
      assert.equal(firstReceipt.operations[0]?.status, "succeeded");
      assert.notEqual(firstReceipt.requestEventId, "");
    }
    const firstFinal = first.transcript.at(-1);
    assert.equal(
      firstFinal?.kind === "message" ? firstFinal.content : undefined,
      "The file says durable hello.",
    );
    // JX-AC-028: the controller exposes the canonical Thread projection.
    assert.equal(first.metrics?.model.calls, 2);
    assert.equal(first.metrics?.model.succeeded, 2);
    assert.equal(first.metrics?.tools.calls, 1);
    assert.equal(first.metrics?.cost.unpricedOutcomes, 2);
    const originalThreadId = first.currentThreadId;
    assert.notEqual(originalThreadId, null);
    if (originalThreadId === null) return;

    await controller.submit("Follow up");
    assert.equal(controller.getSnapshot().currentThreadId, originalThreadId);
    assert.equal(
      controller.getSnapshot().activePlan?.objective,
      "Verify the follow-up",
    );
    assert.deepEqual(effects[2]?.input.messages.slice(-2), [
      {
        content: "The file says durable hello.",
        role: "assistant",
        toolCalls: [],
      },
      { content: "Follow up", role: "user" },
    ]);
    const retainedReceipt = controller.getSnapshot().transcript.find(
      (entry) => entry.kind === "tool-receipts",
    );
    assert.equal(retainedReceipt?.kind, "tool-receipts");
    if (retainedReceipt?.kind === "tool-receipts") {
      assert.equal(retainedReceipt.operations[0]?.detail, "note.txt");
      assert.equal(retainedReceipt.operations[0]?.outcome, "1 line · 13 B");
      assert.equal(retainedReceipt.operations[0]?.status, "succeeded");
    }
    await controller.selectThread(originalThreadId);
    const reopenedReceipt = controller.getSnapshot().transcript.find(
      (entry) => entry.kind === "tool-receipts",
    );
    assert.equal(reopenedReceipt?.kind, "tool-receipts");
    if (reopenedReceipt?.kind === "tool-receipts") {
      assert.equal(reopenedReceipt.operations[0]?.detail, "note.txt");
      assert.equal(reopenedReceipt.operations[0]?.outcome, "1 line · 13 B");
      assert.equal(reopenedReceipt.operations[0]?.status, "succeeded");
    }

    await controller.submit("/events");
    assert.equal(controller.getSnapshot().inspection?.title, "Durable Events");
    await controller.submit("/state");
    assert.match(controller.getSnapshot().inspection?.content ?? "", /"status": "idle"/);
    await controller.submit("/replay");
    assert.equal(controller.getSnapshot().inspection?.title, "Replay result");

    await controller.submit("/clear");
    assert.deepEqual(controller.getSnapshot().transcript, []);
    assert.equal(controller.getSnapshot().activePlan, null);
    assert.equal(controller.getSnapshot().metrics?.model.calls, 3);
    assert.equal(controller.getSnapshot().metrics?.cost.unpricedOutcomes, 3);
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
    const restoredFirst = controller.getSnapshot().transcript[0];
    assert.equal(
      restoredFirst?.kind === "message" ? restoredFirst.content : undefined,
      "Fresh start",
    );

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

test("JX-AC-041 Tool-only model decisions retain causal batches and bounded live output", async () => {
  const root = await mkdtemp(join(tmpdir(), "jixu-tool-batches-"));
  try {
    await Promise.all([
      writeFile(join(root, "first.txt"), "a", "utf8"),
      writeFile(join(root, "second.txt"), "b", "utf8"),
    ]);
    let calls = 0;
    const driver: ModelDriver = {
      async generate(): Promise<ModelOutcome> {
        calls += 1;
        if (calls === 1) {
          return {
            status: "succeeded",
            value: {
              content: "",
              toolCalls: [
                { arguments: { path: "first.txt" }, id: "read-1", name: "read" },
                { arguments: { path: "second.txt" }, id: "read-2", name: "read" },
              ],
            },
          };
        }
        if (calls === 2) {
          return {
            status: "succeeded",
            value: {
              content: "",
              toolCalls: [
                {
                  arguments: { command: "printf chained-output; sleep 0.5" },
                  id: "bash-1",
                  name: "bash",
                },
              ],
            },
          };
        }
        return {
          status: "succeeded",
          value: { content: "Checked both batches.", toolCalls: [] },
        };
      },
    };
    const tools = createNodeTools({ root });
    const harness = createHarness({
      agent: defineAgent({
        instructions: "Use the available tools.",
        model: { model: "deterministic", provider: "mock" },
        tools: tools.all,
      }),
      modelDrivers: { mock: driver },
    });
    const controller = createThreadController({ harness });
    const observedLiveOutput: string[] = [];
    const unsubscribe = controller.subscribe(() => {
      observedLiveOutput.push(
        Object.values(controller.getSnapshot().toolLiveOutput)
          .map((output) => output.text)
          .join("\n"),
      );
    });

    await controller.submit("Inspect in stages");
    unsubscribe();

    const receipts = controller.getSnapshot().transcript.filter(
      (entry) => entry.kind === "tool-receipts",
    );
    assert.equal(receipts.length, 2);
    const first = receipts[0];
    const second = receipts[1];
    assert.equal(first?.kind, "tool-receipts");
    assert.equal(second?.kind, "tool-receipts");
    if (first?.kind !== "tool-receipts" || second?.kind !== "tool-receipts") {
      return;
    }
    assert.deepEqual(
      first.operations.map((operation) => operation.detail),
      ["first.txt", "second.txt"],
    );
    assert.deepEqual(
      first.operations.map((operation) => operation.outcome),
      ["1 line · 1 B", "1 line · 1 B"],
    );
    assert.notEqual(first.requestEventId, second.requestEventId);
    assert.equal(second.operations[0]?.name, "bash");
    assert.equal(second.operations[0]?.outcome, "exit 0");
    assert.equal(second.operations[0]?.preview, "chained-output");
    assert.ok(observedLiveOutput.some((output) => output.includes("chained-output")));
    assert.ok(
      observedLiveOutput.every((output) => output.length <= 1_200),
    );
    assert.deepEqual(controller.getSnapshot().toolLiveOutput, {});
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
