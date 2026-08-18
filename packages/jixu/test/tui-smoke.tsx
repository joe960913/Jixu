import assert from "node:assert/strict";

import { createRuntime, defineAgent } from "@jixu/core";
import type { ModelDriver } from "@jixu/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import type { JixuConnectionConfig } from "../src/config.ts";
import { createJixuSession } from "../src/session.ts";
import type { JixuSession } from "../src/session.ts";
import { JixuApp } from "../src/tui.tsx";

const successfulDriver: ModelDriver = {
  generate: async (effect, context) => {
    context.signals.emit({
      data: { delta: "Working" },
      kind: "signal",
      runId: effect.runId,
      type: "model.output_text.delta",
    });
    return {
      status: "succeeded",
      value: {
        content: "The **durable** run completed.",
        toolCalls: [],
      },
    };
  },
};
const runtime = createRuntime({
  modelDrivers: { "openai-compatible": successfulDriver },
});
const agent = defineAgent({
  instructions: "Be useful.",
  model: { model: "vendor/model-example", provider: "openai-compatible" },
});
let connected: JixuConnectionConfig | null = null;
const activeSession: { current: JixuSession | null } = { current: null };
const secret = "openrouter-secret-fixture";
const setup = await testRender(
  <JixuApp
    connect={async (config, controls) => {
      connected = config;
      activeSession.current = createJixuSession({ agent, ...controls, runtime });
      return activeSession.current;
    }}
    initial={{ apiFormat: "chat-completions" }}
    onQuit={() => undefined}
    workspace="/workspace"
  />,
  { height: 30, width: 120 },
);

try {
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const initialFrame = setup.captureCharFrame();
  assert.match(initialFrame, /JIXU/);
  assert.match(initialFrame, /Connect a model/);
  assert.match(initialFrame, /Responses/);
  assert.match(initialFrame, /Chat Completions/);
  assert.match(initialFrame, /Base URL/);
  assert.match(initialFrame, /API Key/);
  assert.match(initialFrame, /Model ID/);
  assert.match(initialFrame, /saved in ~\/\.jixu/);
  assert.doesNotMatch(initialFrame, /OpenAI|OpenRouter/);

  await act(async () => {
    await setup.mockInput.pressKeys(["TAB"], 5);
    await setup.flush();
  });
  await act(async () => {
    await setup.mockInput.typeText("https://router.example/v1", 1);
    await setup.flush();
  });
  await act(async () => {
    setup.mockInput.pressEnter();
    await setup.flush();
  });
  await act(async () => {
    await setup.mockInput.typeText(secret, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
  });
  const credentialFrame = setup.captureCharFrame();
  assert.match(credentialFrame, /openrouter-secret-fixture/);

  await act(async () => {
    setup.mockInput.pressEnter();
    await setup.flush();
  });
  await act(async () => {
    await setup.mockInput.typeText("vendor/model-example");
    await setup.flush();
  });
  let connectedFrame = "";
  await act(async () => {
    setup.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 10));
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
  assert.match(connectedFrame, /\/help · \/events · \/state/);
  assert.doesNotMatch(connectedFrame, /read · write · edit · bash/);
  assert.match(connectedFrame, /ACTIVITY\s+0/);
  assert.match(connectedFrame, /No activity yet/);
  assert.match(connectedFrame, /\/config/);
  assert.match(connectedFrame, /Local shell · unsandboxed/);
  assert.doesNotMatch(connectedFrame, /Next Level Agent/);
  assert.doesNotMatch(connectedFrame, /Conversation|Run activity|New Run/);
  assert.doesNotMatch(connectedFrame, /openrouter-secret-fixture/);

  assert.notEqual(activeSession.current, null);
  await act(async () => {
    if (activeSession.current !== null) {
      await activeSession.current.submit("Explain this repository");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await setup.flush();
  });
  const completedFrame = setup.captureCharFrame();
  assert.match(completedFrame, /Explain this repository/);
  assert.match(completedFrame, /ACTIVITY\s+4/);
  assert.match(completedFrame, /\+ Thinking/);
  assert.match(completedFrame, /vendor\/model-example/);
  assert.match(completedFrame, /✓ Model response/);
  assert.match(completedFrame, /committed/);
  assert.match(completedFrame, /The durable run completed\./);
  assert.doesNotMatch(completedFrame, /Conversation|Run activity|New Run/);

  let reconfiguredFrame = "";
  await act(async () => {
    if (activeSession.current !== null) {
      await activeSession.current.submit("/config");
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
      return createJixuSession({ agent, ...controls, runtime });
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
let compactSession: JixuSession | null = null;
const compactSetup = await testRender(
  <JixuApp
    connect={async (config, controls) => {
      await compactGate;
      assert.equal(config.model, "vendor/model-example");
      compactSession = createJixuSession({ agent, ...controls, runtime });
      return compactSession;
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
  assert.match(compactFrame, /\/help · \/events · \/state/);
  assert.doesNotMatch(compactFrame, /ACTIVITY/);
  assert.doesNotMatch(compactFrame, /Conversation|Run activity|New Run/);
  assert.doesNotMatch(compactFrame, /openrouter-secret-fixture/);

  await act(async () => {
    if (compactSession !== null) {
      await compactSession.submit("Compact activity");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await compactSetup.flush();
  });
  const compactCompletedFrame = compactSetup.captureCharFrame();
  assert.match(compactCompletedFrame, /Compact activity/);
  assert.match(compactCompletedFrame, /\+ Thinking · vendor\/model-example/);
  assert.match(compactCompletedFrame, /The durable run completed\./);
  assert.doesNotMatch(compactCompletedFrame, /ACTIVITY/);
} finally {
  act(() => {
    compactSetup.renderer.destroy();
  });
}
