import assert from "node:assert/strict";

import { createHarness, defineAgent } from "@jixu/core";
import type { ModelDriver } from "@jixu/core";
import type { TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import type { JixuConnectionConfig } from "../src/config.ts";
import { createThreadController } from "../src/thread-controller.ts";
import type { ThreadController } from "../src/thread-controller.ts";
import { JixuApp } from "../src/tui.tsx";

const successfulDriver: ModelDriver = {
  generate: async (effect, context) => {
    const priced = !effect.input.messages.some(
      (message) => message.role === "user" && message.content === "Compact activity",
    );
    context.signals.emit({
      data: { delta: "Working" },
      kind: "signal",
      threadId: effect.threadId,
      type: "model.output_text.delta",
    });
    return {
      accounting: {
        cost: priced
          ? {
              currency: "USD",
              pricingVersion: "smoke-1",
              source: "calculator",
              usdNanos: 13_200_000,
            }
          : null,
        usage: {
          cacheWriteTokens: null,
          cachedInputTokens: 24,
          inputTokens: 120,
          outputTokens: 30,
          reasoningTokens: 8,
          totalTokens: 150,
        },
      },
      status: "succeeded",
      value: {
        content: "The **durable** run completed.",
        planUpdates: [
          {
            acceptanceCriteria: ["The repository is explained accurately"],
            assumptions: [],
            blockers: [],
            nextAction: "Inspect the architecture",
            objective: "Explain the repository architecture",
            operation: "create",
            steps: [
              {
                description: "Inspect the architecture",
                evidence: [],
                id: "inspect",
                status: "in_progress",
              },
              {
                description: "Explain the durable execution model",
                evidence: [],
                id: "explain",
                status: "pending",
              },
            ],
          },
        ],
        toolCalls: [],
      },
    };
  },
};
const agent = defineAgent({
  instructions: "Be useful.",
  model: { model: "vendor/model-example", provider: "openai-compatible" },
});
const harness = createHarness({
  agent,
  modelDrivers: { "openai-compatible": successfulDriver },
});
let connected: JixuConnectionConfig | null = null;
const activeController: { current: ThreadController | null } = { current: null };
const secret = "openrouter-secret-fixture";

const setup = await testRender(
  <JixuApp
    connect={async (config, controls) => {
      connected = config;
      activeController.current = createThreadController({ harness, ...controls });
      return activeController.current;
    }}
    initial={{ apiFormat: "chat-completions" }}
    onQuit={() => undefined}
    workspace="/workspace"
  />,
  { height: 30, kittyKeyboard: true, width: 120 },
);

try {
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const initialFrame = setup.captureCharFrame();
  // JX-AC-015 JX-AC-018: missing credentials do not gate the working surface.
  assert.match(initialFrame, /JIXU/);
  assert.match(initialFrame, /not configured/i);
  assert.match(initialFrame, /Use \/config to connect a model/);
  assert.match(initialFrame, /Model not configured · use \/config/);
  assert.match(initialFrame, /USD —/);
  assert.doesNotMatch(initialFrame, /Connect a model/);
  assert.doesNotMatch(initialFrame, /API Key/);
  assert.doesNotMatch(initialFrame, /OpenAI|OpenRouter/);

  const composerEditor = setup.renderer.root.findDescendantById(
    "composer-editor",
  ) as TextareaRenderable | undefined;
  assert.notEqual(composerEditor, undefined);
  await act(async () => {
    await setup.mockInput.typeText("line 1");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("line 2");
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  // JX-AC-030: preserve the core keyboard contract without freezing layout.
  assert.equal(composerEditor?.plainText, "line 1\nline 2");

  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.equal(composerEditor?.plainText, "");
  assert.match(setup.captureCharFrame(), /No model configured/);

  await act(async () => {
    await setup.mockInput.typeText("/");
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  let commandFrame = setup.captureCharFrame();
  // JX-AC-018: slash commands appear above the composer and share one list.
  assert.match(commandFrame, /Commands/);
  assert.match(commandFrame, /▶ \/help/);
  assert.match(commandFrame, /↑\/↓ select · Enter use · Esc close/);

  await act(async () => {
    setup.mockInput.pressArrow("down");
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  commandFrame = setup.captureCharFrame();
  assert.match(commandFrame, /▶ \/new/);

  await act(async () => {
    setup.mockInput.pressArrow("up");
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  commandFrame = setup.captureCharFrame();
  assert.match(commandFrame, /▶ \/help/);

  await act(async () => {
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.doesNotMatch(setup.captureCharFrame(), /↑\/↓ select/);

  await act(async () => {
    await setup.mockInput.typeText("config");
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  commandFrame = setup.captureCharFrame();
  assert.match(commandFrame, /▶ \/config/);

  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const configurationFrame = setup.captureCharFrame();
  assert.match(configurationFrame, /Model connection/);

  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    await setup.mockInput.typeText("https://router.example/v1", 1);
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    await setup.mockInput.typeText(secret, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    await setup.mockInput.typeText("vendor/model-example");
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  let connectedFrame = "";
  await act(async () => {
    setup.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    await Promise.resolve();
    await setup.flush();
  });
  connectedFrame = setup.captureCharFrame();
  assert.deepEqual(connected, {
    apiFormat: "chat-completions",
    apiKey: secret,
    baseUrl: "https://router.example/v1",
    model: "vendor/model-example",
  });
  // JX-AC-018: the wide working surface keeps chat dominant beside activity.
  assert.match(connectedFrame, /router\.example · vendor\/model-example/);
  assert.match(connectedFrame, /Chat Completions/);
  assert.match(connectedFrame, /╚█████╔╝/);
  assert.match(connectedFrame, /Ask Jixu anything/);
  assert.match(connectedFrame, /\/help · \/new · \/clear/);
  assert.doesNotMatch(connectedFrame, /read · write · edit · bash/);
  assert.match(connectedFrame, /ACTIVITY\s+0/);
  assert.match(connectedFrame, /No activity yet/);
  assert.match(connectedFrame, /\/config/);
  assert.match(connectedFrame, /Local shell · unsandboxed/);
  assert.match(connectedFrame, /USD —/);
  assert.doesNotMatch(connectedFrame, /Next Level Agent/);
  assert.doesNotMatch(connectedFrame, /Conversation|Run activity|New Run/);
  assert.doesNotMatch(connectedFrame, /openrouter-secret-fixture/);

  assert.notEqual(activeController.current, null);
  await act(async () => {
    if (activeController.current !== null) {
      await activeController.current.submit("Explain this repository");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await setup.flush();
  });
  const completedFrame = setup.captureCharFrame();
  assert.match(completedFrame, /Explain this repository/);
  assert.match(completedFrame, /ACTIVITY\s+5/);
  assert.match(completedFrame, /\+ Thinking/);
  assert.match(completedFrame, /vendor\/model-example/);
  assert.match(completedFrame, /✓ Model response/);
  assert.match(completedFrame, /committed/);
  assert.match(completedFrame, /The durable run completed\./);
  assert.match(completedFrame, /PLAN · r1/);
  assert.match(completedFrame, /Explain the repository architecture/);
  assert.match(completedFrame, /→ Inspect the architecture/);
  assert.match(completedFrame, /Next · Inspect the architecture/);
  // JX-AC-028: the footer reads durable Thread cost, not UI-local counters.
  assert.match(completedFrame, /USD \$0\.0132/);
  assert.doesNotMatch(completedFrame, /Conversation|Run activity|New Run/);

  let reconfiguredFrame = "";
  await act(async () => {
    if (activeController.current !== null) {
      await activeController.current.submit("/config");
    }
    await setup.flush();
  });
  await act(async () => {
    await Promise.resolve();
    await setup.flush();
  });
  reconfiguredFrame = setup.captureCharFrame();
  assert.match(reconfiguredFrame, /openrouter-secret-fixture/);
  assert.match(reconfiguredFrame, /vendor\/model-example/);
} finally {
  act(() => {
    setup.renderer.destroy();
  });
}

let restored: JixuConnectionConfig | null = null;
let releaseRestore!: () => void;
const restoreGate = new Promise<void>((resolve) => {
  releaseRestore = resolve;
});
const restoredSetup = await testRender(
  <JixuApp
    connect={async (config, controls) => {
      await restoreGate;
      restored = config;
      return createThreadController({ harness, ...controls });
    }}
    initial={{
      apiFormat: "responses",
      apiKey: secret,
      autoConnect: true,
      baseUrl: "https://router.example/v1",
      model: "vendor/model-example",
    }}
    onQuit={() => undefined}
    workspace="/workspace"
  />,
  { height: 36, width: 160 },
);

try {
  await act(async () => {
    releaseRestore();
    await restoredSetup.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await restoredSetup.flush();
  });
  await act(async () => {
    await Promise.resolve();
    await restoredSetup.flush();
  });
  const restoredFrame = restoredSetup.captureCharFrame();
  assert.deepEqual(restored, {
    apiFormat: "responses",
    apiKey: secret,
    baseUrl: "https://router.example/v1",
    model: "vendor/model-example",
  });
  // JX-AC-018: wide terminals use the available width for the 4:1 workspace.
  const headerLine = restoredFrame
    .split("\n")
    .find((line) => line.includes("JIXU"));
  assert.notEqual(headerLine, undefined);
  assert.ok((headerLine?.indexOf("JIXU") ?? 99) <= 2);
  const activityLine = restoredFrame
    .split("\n")
    .find((line) => line.includes("ACTIVITY"));
  assert.notEqual(activityLine, undefined);
  assert.ok((activityLine?.indexOf("ACTIVITY") ?? 0) >= 125);
  assert.match(restoredFrame, /╚█████╔╝/);
  assert.match(restoredFrame, /ACTIVITY/);
  assert.match(restoredFrame, /Ask Jixu anything/);
  assert.match(restoredFrame, /router\.example · vendor\/model-example/);
  assert.doesNotMatch(restoredFrame, /Next Level Agent/);
  assert.doesNotMatch(restoredFrame, /Conversation|Run activity|New Run/);
  assert.doesNotMatch(restoredFrame, /openrouter-secret-fixture/);
} finally {
  act(() => {
    restoredSetup.renderer.destroy();
  });
}

let releaseCompact!: () => void;
const compactGate = new Promise<void>((resolve) => {
  releaseCompact = resolve;
});
let compactController: ThreadController | null = null;
const compactSetup = await testRender(
  <JixuApp
    connect={async (config, controls) => {
      await compactGate;
      assert.equal(config.model, "vendor/model-example");
      compactController = createThreadController({ harness, ...controls });
      return compactController;
    }}
    initial={{
      apiFormat: "responses",
      apiKey: secret,
      autoConnect: true,
      baseUrl: "https://router.example/v1",
      model: "vendor/model-example",
    }}
    onQuit={() => undefined}
    workspace="/workspace"
  />,
  { height: 24, width: 80 },
);

try {
  await act(async () => {
    releaseCompact();
    await compactSetup.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await compactSetup.flush();
  });
  await act(async () => {
    await Promise.resolve();
    await compactSetup.flush();
  });
  // JX-AC-018: 80x24 retains the prompt, status, and safety context.
  const compactFrame = compactSetup.captureCharFrame();
  assert.match(compactFrame, /╚█████╔╝/);
  assert.match(compactFrame, /Ask Jixu anything/);
  assert.match(compactFrame, /Local shell · unsandboxed/);
  assert.match(compactFrame, /USD —/);
  assert.match(compactFrame, /\/help · \/new · \/clear/);
  assert.doesNotMatch(compactFrame, /ACTIVITY/);
  assert.doesNotMatch(compactFrame, /Conversation|Run activity|New Run/);
  assert.doesNotMatch(compactFrame, /openrouter-secret-fixture/);

  await act(async () => {
    await compactSetup.mockInput.typeText("/fork");
  });
  await act(async () => {
    await compactSetup.renderOnce();
    await compactSetup.flush();
  });
  let compactCommandFrame = compactSetup.captureCharFrame();
  // JX-AC-018: the 80x24 surface keeps a usable composer and command picker.
  assert.match(compactCommandFrame, /Commands/);
  assert.match(compactCommandFrame, /▶ \/fork/);
  assert.match(compactCommandFrame, /Local shell · unsandboxed/);

  await act(async () => {
    compactSetup.mockInput.pressEnter();
  });
  await act(async () => {
    await compactSetup.renderOnce();
    await compactSetup.flush();
  });
  compactCommandFrame = compactSetup.captureCharFrame();
  assert.doesNotMatch(compactCommandFrame, /↑\/↓ select/);
  assert.match(compactCommandFrame, /\/fork/);

  await act(async () => {
    if (compactController !== null) {
      await compactController.submit("Compact activity");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await compactSetup.flush();
  });
  const compactCompletedFrame = compactSetup.captureCharFrame();
  assert.match(compactCompletedFrame, /\+ Thinking · vendor\/model-example/);
  assert.match(compactCompletedFrame, /The durable run completed\./);
  assert.match(compactCompletedFrame, /PLAN · r1/);
  assert.match(compactCompletedFrame, /Explain the repository architecture/);
  assert.match(compactCompletedFrame, /USD —/);
  assert.doesNotMatch(compactCompletedFrame, /ACTIVITY/);
} finally {
  act(() => {
    compactSetup.renderer.destroy();
  });
}
