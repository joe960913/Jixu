import assert from "node:assert/strict";

import {
  createHarness,
  defineAgent,
  defineSchema,
  defineTool,
} from "@jixu/core";
import type { ModelDriver } from "@jixu/core";
import {
  ImageRenderable,
  type BaseRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { setRendererCapabilities } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import type { JixuConnectionConfig } from "../src/config.ts";
import { createThreadController } from "../src/thread-controller.ts";
import type { ThreadController } from "../src/thread-controller.ts";
import { JixuApp } from "../src/tui.tsx";

let resolveThinkingStarted!: () => void;
const thinkingStarted = new Promise<void>((resolve) => {
  resolveThinkingStarted = resolve;
});
let releaseThinkingText!: () => void;
const thinkingTextGate = new Promise<void>((resolve) => {
  releaseThinkingText = resolve;
});
let resolveThinkingTextStarted!: () => void;
const thinkingTextStarted = new Promise<void>((resolve) => {
  resolveThinkingTextStarted = resolve;
});
let releaseThinkingFinal!: () => void;
const thinkingFinalGate = new Promise<void>((resolve) => {
  releaseThinkingFinal = resolve;
});
let resolveToolStarted!: () => void;
const toolStarted = new Promise<void>((resolve) => {
  resolveToolStarted = resolve;
});
let releaseTool!: () => void;
const toolGate = new Promise<void>((resolve) => {
  releaseTool = resolve;
});
let resolveContinuationStarted!: () => void;
const continuationStarted = new Promise<void>((resolve) => {
  resolveContinuationStarted = resolve;
});
let releaseContinuation!: () => void;
const continuationGate = new Promise<void>((resolve) => {
  releaseContinuation = resolve;
});

function smokeAccounting(priced: boolean) {
  return {
    cost: priced
      ? {
          currency: "USD" as const,
          pricingVersion: "smoke-1",
          source: "calculator" as const,
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
  };
}

const successfulDriver: ModelDriver = {
  generate: async (effect, context) => {
    const latestMessage = effect.input.messages.at(-1);
    const latestUser = effect.input.messages.findLast(
      (message) => message.role === "user",
    );
    const directExecution = latestUser?.content === "Direct task";
    const priced = latestUser?.content !== "Compact activity";
    if (latestUser?.content === "Thinking task") {
      resolveThinkingStarted();
      await thinkingTextGate;
      context.signals.emit({
        data: { delta: "A partial answer" },
        kind: "signal",
        threadId: effect.threadId,
        type: "model.output_text.delta",
      });
      resolveThinkingTextStarted();
      await thinkingFinalGate;
      return {
        accounting: smokeAccounting(false),
        status: "succeeded",
        value: { content: "A complete answer.", toolCalls: [] },
      };
    }
    if (directExecution && latestMessage?.role === "tool") {
      resolveContinuationStarted();
      await continuationGate;
      return {
        accounting: smokeAccounting(true),
        status: "succeeded",
        value: { content: "The **durable** run completed.", toolCalls: [] },
      };
    }
    context.signals.emit({
      data: { delta: "Working" },
      kind: "signal",
      threadId: effect.threadId,
      type: "model.output_text.delta",
    });
    return {
      accounting: smokeAccounting(priced),
      status: "succeeded",
      value: {
        content:
          directExecution && latestMessage?.role !== "tool"
            ? "Creating the requested file."
            : "The **durable** run completed.",
        planUpdates: directExecution
          ? []
          : [{
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
          }],
        toolCalls:
          directExecution && latestMessage?.role !== "tool"
            ? [
                {
                  arguments: { command: "cat > /tmp/hello.html" },
                  id: "bash-1",
                  name: "bash",
                },
              ]
            : [],
      },
    };
  },
};
const bashInput = defineSchema<{ readonly command: string }>({
  jsonSchema: {
    additionalProperties: false,
    properties: { command: { type: "string" } },
    required: ["command"],
    type: "object",
  },
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("command" in value) ||
      typeof value.command !== "string"
    ) {
      throw new TypeError("bash command must be a string");
    }
    return { command: value.command };
  },
});
const textOutput = defineSchema<string>({
  jsonSchema: { type: "string" },
  parse(value) {
    if (typeof value !== "string") throw new TypeError("output must be a string");
    return value;
  },
});
const bash = defineTool({
  description: "Run a fixture shell command",
  execute: async () => {
    resolveToolStarted();
    await toolGate;
    return "completed";
  },
  input: bashInput,
  name: "bash",
  output: textOutput,
});
const agent = defineAgent({
  instructions: "Be useful.",
  model: { model: "vendor/model-example", provider: "openai-compatible" },
  tools: [bash],
});
const harness = createHarness({
  agent,
  modelDrivers: { "openai-compatible": successfulDriver },
});
let connected: JixuConnectionConfig | null = null;
const activeController: { current: ThreadController | null } = { current: null };
const secret = "openrouter-secret-fixture";

function containsImageRenderable(renderable: BaseRenderable): boolean {
  return (
    renderable instanceof ImageRenderable ||
    renderable.getChildren().some(containsImageRenderable)
  );
}

const setup = await testRender(
  <JixuApp
    connect={async (config, controls) => {
      connected = config;
      activeController.current = createThreadController({ harness, ...controls });
      return activeController.current;
    }}
    initial={{ api: "openai-chat-completions" }}
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
  // JX-AC-015 JX-AC-037 JX-AC-038: first launch keeps work and discovery visible.
  assert.match(initialFrame, /JIXU/);
  assert.match(initialFrame, /not configured/i);
  assert.match(initialFrame, /Use \/config to connect a model/);
  assert.match(initialFrame, /Model not configured · use \/config/);
  assert.match(initialFrame, /USD —/);
  assert.match(initialFrame, /NOW/);
  assert.match(initialFrame, /PLAN/);
  assert.match(initialFrame, /Direct execution/);
  assert.match(initialFrame, /VERIFIED/);
  assert.match(initialFrame, /NEEDS YOU/);
  assert.match(initialFrame, /\/events · durable history/);
  assert.match(initialFrame, /Type \/ to view commands\./);
  assert.doesNotMatch(initialFrame, /\/help · \/new · \/clear/);
  assert.notEqual(
    setup.renderer.root.findDescendantById("jixu-creation-mark"),
    undefined,
  );
  assert.equal(containsImageRenderable(setup.renderer.root), false);
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
    api: "openai-chat-completions",
    apiKey: secret,
    baseUrl: "https://router.example/v1",
    model: "vendor/model-example",
  });
  // JX-AC-030 JX-AC-037: the wide surface keeps chat beside the attention rail.
  assert.match(connectedFrame, /vendor\/model-example/);
  assert.doesNotMatch(connectedFrame, /router\.example|OpenAI Chat/);
  assert.match(connectedFrame, /Ask Jixu anything/);
  assert.doesNotMatch(connectedFrame, /│\s+YOU\s+Ask Jixu anything/);
  assert.match(connectedFrame, /Type \/ to view commands\./);
  assert.doesNotMatch(connectedFrame, /\/help · \/new · \/clear/);
  assert.doesNotMatch(connectedFrame, /read · write · edit · bash/);
  assert.match(connectedFrame, /NOW/);
  assert.match(connectedFrame, /PLAN/);
  assert.match(connectedFrame, /Direct execution/);
  assert.match(connectedFrame, /VERIFIED/);
  assert.match(connectedFrame, /NEEDS YOU/);
  assert.match(connectedFrame, /LOCAL I\/O · process access/);
  assert.match(connectedFrame, /USD —/);
  assert.doesNotMatch(connectedFrame, /ACTIVITY|No activity yet|Thread created/);
  assert.doesNotMatch(connectedFrame, /Next Level Agent/);
  assert.doesNotMatch(connectedFrame, /Conversation|Run activity|New Run/);
  assert.doesNotMatch(connectedFrame, /openrouter-secret-fixture/);

  assert.notEqual(activeController.current, null);
  let thinkingSubmission: Promise<void> | null = null;
  await act(async () => {
    if (activeController.current !== null) {
      thinkingSubmission = activeController.current.submit("Thinking task");
    }
    await thinkingStarted;
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  // JX-AC-033 JX-AC-036: pending Agent work lives in transcript flow.
  const thinkingFrame = setup.captureCharFrame();
  assert.notEqual(
    setup.renderer.root.findDescendantById("ephemeral-agent-status"),
    undefined,
  );
  const thinkingMotion = setup.renderer.root.findDescendantById(
    "thinking-motion-label",
  );
  assert.notEqual(thinkingMotion, undefined);
  assert.equal(thinkingMotion?.width, "Thinking ...".length);
  assert.equal(thinkingMotion?.getChildren().length, "Thinking ...".length);
  assert.match(thinkingFrame, /Thinking task/);
  assert.match(thinkingFrame, /Thinking \.\.\./);
  assert.match(thinkingFrame, /MODEL\s+vendor\/model-example/);
  assert.match(thinkingFrame, /LOCAL I\/O · process access/);

  await act(async () => {
    releaseThinkingText();
    await thinkingTextStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const streamingFrame = setup.captureCharFrame();
  assert.equal(
    setup.renderer.root.findDescendantById("ephemeral-agent-status"),
    undefined,
  );
  assert.match(streamingFrame, /A partial answer/);
  assert.match(streamingFrame, /MODEL\s+vendor\/model-example/);

  await act(async () => {
    releaseThinkingFinal();
    await thinkingSubmission;
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.match(setup.captureCharFrame(), /A complete answer\./);

  let directSubmission: Promise<void> | null = null;
  await act(async () => {
    if (activeController.current !== null) {
      directSubmission = activeController.current.submit("Direct task");
    }
    await toolStarted;
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const liveToolFrame = setup.captureCharFrame();
  assert.equal(
    setup.renderer.root.findDescendantById("ephemeral-agent-status"),
    undefined,
  );
  assert.match(liveToolFrame, /cat > \/tmp\/hello\.html · In progress/);
  assert.match(liveToolFrame, /MODEL\s+vendor\/model-example/);

  await act(async () => {
    releaseTool();
    await continuationStarted;
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const continuationFrame = setup.captureCharFrame();
  assert.notEqual(
    setup.renderer.root.findDescendantById("ephemeral-agent-status"),
    undefined,
  );
  assert.match(continuationFrame, /cat > \/tmp\/hello\.html · Completed/);
  assert.match(continuationFrame, /Thinking \.\.\./);

  await act(async () => {
    releaseContinuation();
    await directSubmission;
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  // JX-AC-021 JX-AC-037 JX-AC-040: a completed simple Tool turn keeps receipts.
  const directFrame = setup.captureCharFrame();
  assert.match(directFrame, /Direct task/);
  assert.match(directFrame, /Direct execution/);
  assert.match(directFrame, /Response committed/);
  assert.match(directFrame, /No intervention required/);
  assert.match(directFrame, /TOOLS/);
  assert.match(directFrame, /bash/);
  assert.match(directFrame, /cat > \/tmp\/hello\.html · Completed/);
  assert.equal(setup.renderer.root.findDescendantById("plan-strip"), undefined);

  await act(async () => {
    if (activeController.current !== null) {
      await activeController.current.submit("Explain this repository");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await setup.flush();
  });
  const completedFrame = setup.captureCharFrame();
  assert.match(completedFrame, /Explain this repository/);
  assert.match(completedFrame, /vendor\/model-example/);
  assert.match(completedFrame, /Response committed/);
  assert.match(completedFrame, /The durable run completed\./);
  assert.match(completedFrame, /PLAN r1/);
  assert.match(completedFrame, /Explain the repository/);
  assert.match(completedFrame, /Inspect the architecture/);
  assert.match(completedFrame, /cat > \/tmp\/hello\.html · Completed/);
  assert.notEqual(setup.renderer.root.findDescendantById("plan-strip"), undefined);
  // JX-AC-028: the footer reads durable Thread cost, not UI-local counters.
  assert.match(completedFrame, /USD \$0\.0396/);
  assert.doesNotMatch(completedFrame, /\b\d+%\b|ETA|ACTIVITY|Thread created/);
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
      api: "anthropic-messages",
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
    api: "anthropic-messages",
    apiKey: secret,
    baseUrl: "https://router.example/v1",
    model: "vendor/model-example",
  });
  // JX-AC-037: wide terminals reserve a stable, right-side attention surface.
  const headerLine = restoredFrame
    .split("\n")
    .find((line) => line.includes("JIXU"));
  assert.notEqual(headerLine, undefined);
  assert.ok((headerLine?.indexOf("JIXU") ?? 99) <= 2);
  const attentionLine = restoredFrame
    .split("\n")
    .find((line) => line.includes("NOW"));
  assert.notEqual(attentionLine, undefined);
  assert.ok((attentionLine?.indexOf("NOW") ?? 0) >= 115);
  assert.match(restoredFrame, /NOW/);
  assert.match(restoredFrame, /Direct execution/);
  assert.match(restoredFrame, /VERIFIED/);
  assert.match(restoredFrame, /NEEDS YOU/);
  assert.match(restoredFrame, /Ask Jixu anything/);
  assert.match(restoredFrame, /vendor\/model-example/);
  assert.doesNotMatch(restoredFrame, /router\.example|Anthropic Messages/);
  assert.doesNotMatch(restoredFrame, /Next Level Agent/);
  assert.doesNotMatch(restoredFrame, /Conversation|Run activity|New Run/);
  assert.doesNotMatch(restoredFrame, /openrouter-secret-fixture/);

  // JX-TUI-024 JX-AC-037: markers stay one-row text even when Kitty is available.
  await act(async () => {
    const capabilities = setRendererCapabilities(restoredSetup.renderer, {
      image_protocol: "kitty",
      kitty_graphics: true,
      multiplexer: "none",
    });
    restoredSetup.renderer.emit("capabilities", capabilities);
  });
  await act(async () => {
    await restoredSetup.renderOnce();
    await restoredSetup.flush();
  });
  const attentionGlyph = restoredSetup.renderer.root.findDescendantById(
    "attention-glyph-now",
  );
  assert.notEqual(attentionGlyph, undefined);
  assert.equal(attentionGlyph?.constructor.name, "TextRenderable");
  assert.equal(attentionGlyph?.height, 1);
  assert.equal(attentionGlyph?.width, 2);
  assert.equal(containsImageRenderable(restoredSetup.renderer.root), false);
  assert.match(restoredSetup.captureCharFrame(), /[!○•←‖≡→✱$…⚙✓◈]/u);
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
      api: "openai-chat-completions",
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
  // JX-AC-030 JX-AC-037 JX-AC-038: 80x24 keeps discovery over decoration.
  const compactFrame = compactSetup.captureCharFrame();
  assert.match(compactFrame, /Ask Jixu anything/);
  assert.match(compactFrame, /LOCAL I\/O · process access/);
  assert.match(compactFrame, /USD —/);
  assert.match(compactFrame, /Type \/ to view commands\./);
  assert.doesNotMatch(compactFrame, /\/help · \/new · \/clear/);
  assert.equal(
    compactSetup.renderer.root.findDescendantById("jixu-creation-mark"),
    undefined,
  );
  assert.match(compactFrame, /NOW/);
  assert.match(compactFrame, /PLAN/);
  assert.match(compactFrame, /Direct/);
  assert.match(compactFrame, /VERIFIED/);
  assert.match(compactFrame, /NEEDS YOU/);
  assert.equal(compactSetup.renderer.root.findDescendantById("attention-rail"), undefined);
  assert.notEqual(compactSetup.renderer.root.findDescendantById("attention-strip"), undefined);
  assert.doesNotMatch(compactFrame, /ACTIVITY|Thread created/);
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
  assert.match(compactCommandFrame, /LOCAL I\/O · process access/);

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
  assert.match(compactCompletedFrame, /vendor\/model-example/);
  assert.match(compactCompletedFrame, /The durable run completed\./);
  assert.match(compactCompletedFrame, /PLAN r1/);
  assert.match(compactCompletedFrame, /Explain the repository/);
  assert.match(compactCompletedFrame, /USD —/);
  assert.doesNotMatch(compactCompletedFrame, /ACTIVITY/);
} finally {
  act(() => {
    compactSetup.renderer.destroy();
  });
}
