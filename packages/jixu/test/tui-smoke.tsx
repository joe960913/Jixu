import assert from "node:assert/strict";

import {
  createHarness,
  defineAgent,
  defineSchema,
  defineTool,
  TOOL_OUTPUT_SIGNAL_TYPE,
} from "@jixu/core";
import type { ModelDriver } from "@jixu/core";
import {
  BoxRenderable,
  CodeRenderable,
  getTreeSitterClient,
  ImageRenderable,
  RGBA,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  type BaseRenderable,
  type Renderable,
  type TextareaRenderable,
} from "@opentui/core";
import { setRendererCapabilities } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import type { JixuConnectionConfig } from "../src/config.ts";
import { createThreadController } from "../src/thread-controller.ts";
import type { ThreadController } from "../src/thread-controller.ts";
import { jixuTheme } from "../src/theme.ts";
import { CODE_BLOCK_MAX_CONTENT_HEIGHT } from "../src/tui-markdown.ts";
import { registerJixuCodeParsers } from "../src/tui-parsers.ts";
import { jixuMarkdownSyntaxStyle } from "../src/tui-syntax-theme.ts";
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
let resolveScrollSubmissionStarted!: () => void;
const scrollSubmissionStarted = new Promise<void>((resolve) => {
  resolveScrollSubmissionStarted = resolve;
});
let releaseScrollSubmission!: () => void;
const scrollSubmissionGate = new Promise<void>((resolve) => {
  releaseScrollSubmission = resolve;
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
    const batchExecution = latestUser?.content === "Batch task";
    const codeExecution = latestUser?.content === "Code task";
    const markdownExecution = latestUser?.content === "Markdown task";
    const scrollExecution = latestUser?.content === "Scroll task";
    const failureBatchExecution = latestUser?.content === "Failure batch";
    const priced = latestUser?.content !== "Compact activity";
    if (latestUser?.content === "Thinking task") {
      resolveThinkingStarted();
      await thinkingTextGate;
      context.signals.emit({
        data: { delta: "```javascript\nconst partial = true;\n```" },
        kind: "signal",
        threadId: effect.threadId,
        type: "model.output_text.delta",
      });
      resolveThinkingTextStarted();
      await thinkingFinalGate;
      return {
        accounting: smokeAccounting(false),
        status: "succeeded",
        value: {
          content: "```javascript\nconst complete = true;\n```",
          toolCalls: [],
        },
      };
    }
    if (scrollExecution) {
      context.signals.emit({
        data: { delta: "Following the latest message" },
        kind: "signal",
        threadId: effect.threadId,
        type: "model.output_text.delta",
      });
      resolveScrollSubmissionStarted();
      await scrollSubmissionGate;
      return {
        accounting: smokeAccounting(true),
        status: "succeeded",
        value: {
          content: "The latest message remains in view.",
          planUpdates: [],
          toolCalls: [],
        },
      };
    }
    if (
      (directExecution || batchExecution || failureBatchExecution) &&
      latestMessage?.role === "tool"
    ) {
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
          markdownExecution
            ? [
                "# Project Overview",
                "",
                "> **Note**: useful guidance with `inline code`.",
                "",
                "---",
                "",
                "## Checklist",
                "",
                "- [x] **Chat**: durable context",
                "- [ ] **Media**: planned",
                "",
                "## Architecture",
                "",
                "| Module | Status | Priority |",
                "| :--- | :---: | ---: |",
                "| **Core** | `Active` | P0 |",
                "| **Tools** | `Beta` | P1 |",
                "",
                "## Start",
                "",
                "```bash",
                "git clone https://example.com/jixu.git",
                "pnpm install",
                "```",
              ].join("\n")
            : codeExecution
            ? [
                "A highlighted example:",
                "",
                "```javascript",
                "function debounce(value, delay = 300) {",
                "  const timer = setTimeout(() => value, delay);",
                "  return timer;",
                "}",
                "```",
                "",
                "```unknown-language",
                "raw fallback remains readable",
                "```",
                "",
                "```json",
                '{"ready": true, "count": 2}',
                "```",
                "",
                "```shell",
                "set -euo pipefail",
                'name="jixu"',
                "printf '%s\\n' \"$name\"",
                "```",
                "",
                "```python",
                "def greet(name: str) -> str:",
                '    message = f"Hello, {name}"',
                "    return message",
                "```",
                "",
                "```html",
                "<!DOCTYPE html>",
                '<html lang="zh-CN">',
                "<head>",
                "  <title>Jixu clock</title>",
                "  <style>",
                "    body {",
                "      color: #f5f3ef;",
                "    }",
                "  </style>",
                "</head>",
                "<body>",
                '  <main data-theme="dark">',
                "    <h1>Jixu</h1>",
                '    <button id="toggle">Toggle</button>',
                "    <script>const ready = true;</script>",
                "  </main>",
                "</body>",
                "</html>",
                "```",
              ].join("\n")
            : directExecution && latestMessage?.role !== "tool"
            ? "Creating the requested file."
            : (batchExecution || failureBatchExecution) &&
                latestMessage?.role !== "tool"
              ? ""
            : "The **durable** run completed.",
        planUpdates:
          directExecution || batchExecution || codeExecution || markdownExecution ||
              failureBatchExecution
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
          (batchExecution || failureBatchExecution) &&
            latestMessage?.role !== "tool"
            ? Array.from({ length: 5 }, (_, index) => ({
                arguments: {
                  command:
                    failureBatchExecution && index === 2
                      ? "fail-indeterminate"
                      : `printf batch-${index + 1}`,
                },
                id: `bash-batch-${index + 1}`,
                name: "bash",
              }))
            : directExecution && latestMessage?.role !== "tool"
            ? [
                {
                  arguments: { command: "cat > /tmp/hello.html" },
                  id: "bash-1",
                  name: "bash",
                },
                {
                  arguments: {
                    newText: Array.from(
                      { length: 8 },
                      (_, index) => `new line ${index + 1}`,
                    ).join("\n"),
                    oldText: Array.from(
                      { length: 8 },
                      (_, index) => `old line ${index + 1}`,
                    ).join("\n"),
                    path: "demo.html",
                    replaceAll: false,
                  },
                  id: "edit-1",
                  name: "edit",
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
type BashFixtureOutput = {
  readonly cancelled: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
};
const bashOutput = defineSchema<BashFixtureOutput>({
  jsonSchema: {
    additionalProperties: false,
    properties: {
      cancelled: { type: "boolean" },
      exitCode: { type: ["integer", "null"] },
      signal: { type: ["string", "null"] },
      stderr: { type: "string" },
      stdout: { type: "string" },
      timedOut: { type: "boolean" },
      truncated: { type: "boolean" },
    },
    required: [
      "stdout",
      "stderr",
      "exitCode",
      "signal",
      "timedOut",
      "cancelled",
      "truncated",
    ],
    type: "object",
  },
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("stdout" in value) ||
      typeof value.stdout !== "string" ||
      !("stderr" in value) ||
      typeof value.stderr !== "string" ||
      !("exitCode" in value) ||
      (value.exitCode !== null && typeof value.exitCode !== "number") ||
      !("signal" in value) ||
      (value.signal !== null && typeof value.signal !== "string") ||
      !("timedOut" in value) ||
      typeof value.timedOut !== "boolean" ||
      !("cancelled" in value) ||
      typeof value.cancelled !== "boolean" ||
      !("truncated" in value) ||
      typeof value.truncated !== "boolean"
    ) {
      throw new TypeError("bash fixture output is invalid");
    }
    return {
      cancelled: value.cancelled,
      exitCode: value.exitCode,
      signal: value.signal,
      stderr: value.stderr,
      stdout: value.stdout,
      timedOut: value.timedOut,
      truncated: value.truncated,
    };
  },
});
const bash = defineTool({
  description: "Run a fixture shell command",
  execute: async (input, context) => {
    if (input.command === "fail-indeterminate") {
      throw new Error("fixture outcome is unknown");
    }
    context.signals.emit({
      data: {
        delta: "fixture output\n",
        effectId: context.effectId,
        name: "bash",
        stream: "stdout",
      },
      kind: "signal",
      threadId: context.threadId,
      type: TOOL_OUTPUT_SIGNAL_TYPE,
    });
    resolveToolStarted();
    await toolGate;
    return {
      cancelled: false,
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: input.command.startsWith("cat >")
        ? `${Array.from(
            { length: 12 },
            (_, index) => `fixture output ${index + 1}`,
          ).join("\n")}\n`
        : "fixture output\n",
      timedOut: false,
      truncated: false,
    };
  },
  input: bashInput,
  name: "bash",
  output: bashOutput,
});
type EditFixtureInput = {
  readonly newText: string;
  readonly oldText: string;
  readonly path: string;
  readonly replaceAll?: boolean;
};
const editInput = defineSchema<EditFixtureInput>({
  jsonSchema: {
    additionalProperties: false,
    properties: {
      newText: { type: "string" },
      oldText: { type: "string" },
      path: { type: "string" },
      replaceAll: { type: "boolean" },
    },
    required: ["path", "oldText", "newText"],
    type: "object",
  },
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new TypeError("edit fixture input is invalid");
    }
    const replaceAll = "replaceAll" in value ? value.replaceAll : undefined;
    if (
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("oldText" in value) ||
      typeof value.oldText !== "string" ||
      !("newText" in value) ||
      typeof value.newText !== "string" ||
      (replaceAll !== undefined && typeof replaceAll !== "boolean")
    ) {
      throw new TypeError("edit fixture input is invalid");
    }
    return {
      newText: value.newText,
      oldText: value.oldText,
      path: value.path,
      ...(replaceAll === undefined ? {} : { replaceAll }),
    };
  },
});
type EditFixtureOutput = {
  readonly path: string;
  readonly replacements: number;
};
const editOutput = defineSchema<EditFixtureOutput>({
  jsonSchema: {
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      replacements: { type: "integer" },
    },
    required: ["path", "replacements"],
    type: "object",
  },
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("replacements" in value) ||
      typeof value.replacements !== "number"
    ) {
      throw new TypeError("edit fixture output is invalid");
    }
    return { path: value.path, replacements: value.replacements };
  },
});
const edit = defineTool({
  description: "Replace a fixture text fragment",
  execute: async (input) => ({ path: input.path, replacements: 1 }),
  input: editInput,
  name: "edit",
  output: editOutput,
});
const agent = defineAgent({
  instructions: "Be useful.",
  model: { model: "vendor/model-example", provider: "openai-compatible" },
  tools: [bash, edit],
});
const harness = createHarness({
  agent,
  modelDrivers: { "openai-compatible": successfulDriver },
});
let connected: JixuConnectionConfig | null = null;
const activeController: { current: ThreadController | null } = { current: null };
const secret = "openrouter-secret-fixture";

const parserRegistration = await registerJixuCodeParsers();
assert.equal(parserRegistration.status, "registered");

function containsImageRenderable(renderable: BaseRenderable): boolean {
  return (
    renderable instanceof ImageRenderable ||
    renderable.getChildren().some(containsImageRenderable)
  );
}

function containsCodeRenderable(renderable: BaseRenderable): boolean {
  return (
    renderable instanceof CodeRenderable ||
    renderable.getChildren().some(containsCodeRenderable)
  );
}

function collectCodeRenderables(
  renderable: BaseRenderable,
): readonly CodeRenderable[] {
  const nested = renderable.getChildren().flatMap(collectCodeRenderables);
  return renderable instanceof CodeRenderable
    ? [renderable, ...nested]
    : nested;
}

function codeFrameAncestor(
  renderable: BaseRenderable,
): BoxRenderable | undefined {
  let current = renderable.parent;
  while (current !== null) {
    if (
      current instanceof BoxRenderable &&
      current.id.startsWith("code-frame-")
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function scrollAncestor(
  renderable: BaseRenderable,
): ScrollBoxRenderable | undefined {
  let current = renderable.parent;
  while (current !== null) {
    if (current instanceof ScrollBoxRenderable) return current;
    current = current.parent;
  }
  return undefined;
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
  // JX-AC-042: Configuration exposes reversible navigation and endpoint presets.
  assert.match(configurationFrame, /Model connection/);
  assert.match(configurationFrame, /BACK TO CHAT/);
  assert.match(configurationFrame, /OpenAI/);
  assert.match(configurationFrame, /OpenRouter/);
  assert.match(configurationFrame, /DeepSeek/);
  assert.match(configurationFrame, /Groq/);
  assert.match(configurationFrame, /Custom/);
  assert.match(configurationFrame, /SETTINGS ~\/\.jixu\/settings\.json/);
  assert.match(configurationFrame, /API KEY ~\/\.jixu\/auth\.json/);
  assert.match(configurationFrame, /Esc Back/);
  assert.match(configurationFrame, /Workspace \/workspace/);
  assert.match(configurationFrame, /Ctrl\+C Quit/);
  assert.doesNotMatch(configurationFrame, /Chat Completions/);
  assert.doesNotMatch(configurationFrame, /·/);

  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    setup.mockInput.pressKey("2");
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.match(setup.captureCharFrame(), /https:\/\/openrouter\.ai\/api\/v1/);

  const configBack = setup.renderer.root.findDescendantById(
    "config-back",
  ) as Renderable | undefined;
  assert.notEqual(configBack, undefined);
  await act(async () => {
    if (configBack !== undefined) {
      await setup.mockMouse.click(configBack.x, configBack.y);
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.doesNotMatch(setup.captureCharFrame(), /Model connection/);
  assert.match(setup.captureCharFrame(), /Model not configured/);

  await act(async () => {
    await setup.mockInput.typeText("/config");
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
  assert.match(setup.captureCharFrame(), /Model connection/);

  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    setup.mockInput.pressKey("5");
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
  const thinkingWordmark = setup.renderer.root.findDescendantById(
    "ephemeral-jixu-wordmark",
  );
  assert.ok(thinkingWordmark instanceof TextRenderable);
  assert.equal(thinkingWordmark.plainText, "JIXU");
  assert.match(thinkingFrame, /Thinking task/);
  assert.match(thinkingFrame, /Thinking \.\.\./);
  assert.match(thinkingFrame, /MODEL\s+vendor\/model-example/);
  assert.match(thinkingFrame, /LOCAL I\/O · process access/);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_050));
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  // JX-AC-033: the forward sweep reaches the dots while the JIXU wordmark
  // remains one static renderable.
  assert.match(setup.captureCharFrame(), /Thinking [.•]*•[.•]*/);
  assert.equal(thinkingWordmark.plainText, "JIXU");

  await act(async () => {
    releaseThinkingText();
    await thinkingTextStarted;
    await new Promise((resolve) => setTimeout(resolve, 500));
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
  assert.match(streamingFrame, /const partial = true/);
  assert.equal(containsCodeRenderable(setup.renderer.root), true);
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
  assert.match(setup.captureCharFrame(), /const complete = true/);
  assert.equal(containsCodeRenderable(setup.renderer.root), true);

  await act(async () => {
    await activeController.current?.submit("/resume");
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  // JX-AC-046: even one previous Thread receives a readable three-row viewport.
  const threadSelect = setup.renderer.root.findDescendantById(
    "thread-select",
  ) as SelectRenderable | undefined;
  assert.equal(threadSelect?.height, 3);
  assert.match(setup.captureCharFrame(), /Threads/);
  assert.match(setup.captureCharFrame(), /Thinking task/);
  await act(async () => {
    setup.mockInput.pressEscape();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.equal(
    setup.renderer.root.findDescendantById("thread-select"),
    undefined,
  );

  let directSubmission: Promise<void> | null = null;
  await act(async () => {
    if (activeController.current !== null) {
      directSubmission = activeController.current.submit("Direct task");
    }
    await toolStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  // JX-AC-036: a Tool-only model response keeps the receipt visibly owned by JIXU.
  const liveToolHeader = liveToolFrame
    .split("\n")
    .find((line) => line.includes("TOOLS"));
  assert.match(liveToolHeader ?? "", /JIXU.*TOOLS/);
  assert.match(
    liveToolFrame,
    /bash\s+cat > \/tmp\/hello\.html\s+· In progress/,
  );
  assert.match(liveToolFrame, /fixture output/);
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
  assert.match(continuationFrame, /cat > \/tmp\/hello\.html\s+· exit 0/);
  assert.doesNotMatch(continuationFrame, /fixture output/);
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
  assert.match(directFrame, /edit/);
  assert.match(directFrame, /cat > \/tmp\/hello\.html\s+· exit 0/);
  assert.match(directFrame, /demo\.html\s+· 1 replacement/);
  assert.match(directFrame, /Ctrl\+O Expand all/);
  assert.doesNotMatch(directFrame, /fixture output/);
  assert.doesNotMatch(directFrame, /REPLACEMENT DIFF/);
  assert.equal(setup.renderer.root.findDescendantById("plan-strip"), undefined);

  const directSnapshot = activeController.current?.getSnapshot();
  const directThreadId = directSnapshot?.currentThreadId;
  const directOperations = directSnapshot?.transcript.flatMap((entry) =>
    entry.kind === "tool-receipts" ? entry.operations : [],
  ) ?? [];
  const bashOperation = directOperations.find((operation) => operation.name === "bash");
  const editOperation = directOperations.find((operation) => operation.name === "edit");
  assert.notEqual(directThreadId, null);
  assert.notEqual(directThreadId, undefined);
  assert.notEqual(bashOperation, undefined);
  assert.notEqual(editOperation, undefined);

  // JX-AC-041: every row independently discloses bounded durable detail.
  const editRow = editOperation === undefined
    ? undefined
    : setup.renderer.root.findDescendantById(
        `tool-operation-${editOperation.effectId}`,
      ) as Renderable | undefined;
  assert.notEqual(editRow, undefined);
  await act(async () => {
    if (editRow !== undefined) {
      await setup.mockMouse.click(editRow.x, editRow.y);
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const editDetailFrame = setup.captureCharFrame();
  assert.match(editDetailFrame, /REPLACEMENT DIFF/);
  assert.match(editDetailFrame, /- old line 1/);
  assert.doesNotMatch(editDetailFrame, /fixture output/);
  const editDetail = editOperation === undefined
    ? undefined
    : setup.renderer.root.findDescendantById(
        `tool-detail-${editOperation.effectId}`,
      ) as Renderable | undefined;
  assert.equal(editDetail?.height, 8);
  await act(async () => {
    if (editDetail !== undefined) {
      for (let index = 0; index < 6; index += 1) {
        await setup.mockMouse.scroll(
          editDetail.x + 1,
          editDetail.y + 2,
          "down",
        );
      }
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.match(setup.captureCharFrame(), /\+ new line 1/);

  if (directThreadId !== null && directThreadId !== undefined) {
    await act(async () => {
      await activeController.current?.submit("/new");
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
    assert.equal(
      editOperation === undefined
        ? undefined
        : setup.renderer.root.findDescendantById(
            `tool-detail-${editOperation.effectId}`,
          ),
      undefined,
    );
    await act(async () => {
      await activeController.current?.selectThread(directThreadId);
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
    assert.notEqual(
      editOperation === undefined
        ? undefined
        : setup.renderer.root.findDescendantById(
            `tool-detail-${editOperation.effectId}`,
          ),
      undefined,
    );
  }

  const restoredEditRow = editOperation === undefined
    ? undefined
    : setup.renderer.root.findDescendantById(
        `tool-operation-${editOperation.effectId}`,
      ) as Renderable | undefined;
  await act(async () => {
    if (restoredEditRow !== undefined) {
      await setup.mockMouse.click(restoredEditRow.x, restoredEditRow.y);
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.doesNotMatch(setup.captureCharFrame(), /REPLACEMENT DIFF/);

  const bashRow = bashOperation === undefined
    ? undefined
    : setup.renderer.root.findDescendantById(
        `tool-operation-${bashOperation.effectId}`,
      ) as Renderable | undefined;
  assert.notEqual(bashRow, undefined);
  await act(async () => {
    if (bashRow !== undefined) {
      await setup.mockMouse.click(bashRow.x, bashRow.y);
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const bashDetailFrame = setup.captureCharFrame();
  assert.match(bashDetailFrame, /COMMAND/);
  assert.match(bashDetailFrame, /fixture output/);
  const bashDetail = bashOperation === undefined
    ? undefined
    : setup.renderer.root.findDescendantById(
        `tool-detail-${bashOperation.effectId}`,
      ) as Renderable | undefined;
  assert.equal(bashDetail?.height, 8);

  await act(async () => {
    setup.mockInput.pressKey("o", { ctrl: true });
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const expandedToolFrame = setup.captureCharFrame();
  assert.match(expandedToolFrame, /fixture output/);
  assert.match(expandedToolFrame, /REPLACEMENT DIFF/);

  await act(async () => {
    setup.mockInput.pressKey("o", { ctrl: true });
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.doesNotMatch(setup.captureCharFrame(), /fixture output/);

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
  assert.match(completedFrame, /cat > \/tmp\/hello\.html\s+· exit 0/);
  assert.notEqual(setup.renderer.root.findDescendantById("plan-strip"), undefined);
  // JX-AC-028: the footer reads durable Thread cost, not UI-local counters.
  assert.match(completedFrame, /USD \$0\.0396/);
  assert.doesNotMatch(completedFrame, /\b\d+%\b|ETA|ACTIVITY|Thread created/);
  assert.doesNotMatch(completedFrame, /Conversation|Run activity|New Run/);

  await act(async () => {
    await activeController.current?.submit("Code task");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const codeFrame = setup.captureCharFrame();
  // JX-AC-045: fenced code uses adaptive frames, compact factual headers, the
  // Jixu palette, and a documented HTML compatibility parser.
  assert.doesNotMatch(codeFrame, /```javascript/);
  assert.equal(containsCodeRenderable(setup.renderer.root), true);
  const codeRenderables = collectCodeRenderables(setup.renderer.root);
  const javascriptCode = codeRenderables.find(
    (renderable) =>
      renderable.filetype === "javascript" &&
      renderable.content.includes("function debounce"),
  );
  const unknownCode = codeRenderables.find(
    (renderable) => renderable.content === "raw fallback remains readable",
  );
  const htmlCode = codeRenderables.find(
    (renderable) =>
      renderable.filetype === "typescriptreact" &&
      renderable.content.startsWith("<!DOCTYPE html>"),
  );
  const jsonCode = codeRenderables.find(
    (renderable) => renderable.content === '{"ready": true, "count": 2}',
  );
  const shellCode = codeRenderables.find(
    (renderable) =>
      renderable.filetype === "shell" &&
      renderable.content.startsWith("set -euo pipefail"),
  );
  const pythonCode = codeRenderables.find(
    (renderable) =>
      renderable.filetype === "python" &&
      renderable.content.startsWith("def greet"),
  );
  assert.notEqual(javascriptCode, undefined);
  assert.equal(unknownCode?.filetype, "unknown-language");
  assert.notEqual(htmlCode, undefined);
  assert.equal(jsonCode?.filetype, "javascript");
  assert.notEqual(shellCode, undefined);
  assert.notEqual(pythonCode, undefined);
  const javascriptFrame = javascriptCode === undefined
    ? undefined
    : codeFrameAncestor(javascriptCode);
  assert.notEqual(javascriptFrame, undefined);
  assert.equal(
    javascriptFrame?.height,
    (javascriptCode?.content.split("\n").length ?? 0) + 3,
  );
  assert.equal(javascriptFrame?.border, true);
  assert.equal(javascriptFrame?.title, undefined);
  for (const [code, label] of [
    [javascriptCode, "JAVASCRIPT"],
    [jsonCode, "JSON"],
    [shellCode, "SHELL"],
    [pythonCode, "PYTHON"],
  ] as const) {
    assert.notEqual(code, undefined);
    if (code === undefined) continue;
    const frame = codeFrameAncestor(code);
    const language = frame?.findDescendantById(`code-language-${code.num}`);
    const lines = frame?.findDescendantById(`code-lines-${code.num}`);
    assert.ok(language instanceof TextRenderable);
    assert.equal(language.plainText, label);
    assert.ok(lines instanceof TextRenderable);
    const lineCount = code.content.split("\n").length;
    assert.equal(
      lines.plainText,
      `${lineCount} ${lineCount === 1 ? "LINE" : "LINES"}`,
    );
  }
  if (htmlCode !== undefined) {
    await htmlCode.highlightingDone;
  }
  assert.ok(
    htmlCode !== undefined &&
      Array.from({ length: htmlCode.content.split("\n").length }, (_, index) =>
        htmlCode.getLineHighlights(index),
      ).some((highlights) => highlights.length > 0),
  );
  if (jsonCode !== undefined) {
    await jsonCode.highlightingDone;
  }
  assert.ok(
    jsonCode !== undefined && jsonCode.getLineHighlights(0).length > 0,
  );
  if (shellCode !== undefined) {
    await shellCode.highlightingDone;
  }
  assert.ok(
    shellCode !== undefined &&
      Array.from({ length: shellCode.content.split("\n").length }, (_, index) =>
        shellCode.getLineHighlights(index),
      ).some((highlights) => highlights.length > 0),
  );
  if (pythonCode !== undefined) {
    await pythonCode.highlightingDone;
  }
  assert.ok(
    pythonCode !== undefined &&
      Array.from({ length: pythonCode.content.split("\n").length }, (_, index) =>
        pythonCode.getLineHighlights(index),
      ).some((highlights) => highlights.length > 0),
  );
  const parserClient = getTreeSitterClient();
  for (const [filetype, content] of [
    ["bash", "echo \"$HOME\""],
    ["sh", "value=ready"],
    ["shell", "printf '%s\\n' ready"],
    ["python", "answer: int = 42"],
    ["py", "print('ready')"],
  ] as const) {
    const highlighted = await parserClient.highlightOnce(content, filetype);
    assert.equal(highlighted.error, undefined);
    assert.ok((highlighted.highlights?.length ?? 0) > 0);
  }
  const htmlFrame = htmlCode === undefined
    ? undefined
    : codeFrameAncestor(htmlCode);
  const htmlViewport = htmlCode === undefined
    ? undefined
    : scrollAncestor(htmlCode);
  const codeTranscriptScrollbox = setup.renderer.root.findDescendantById(
    "transcript-scrollbox",
  ) as ScrollBoxRenderable | undefined;
  assert.notEqual(htmlFrame, undefined);
  assert.notEqual(htmlViewport, undefined);
  assert.notEqual(codeTranscriptScrollbox, undefined);
  assert.equal(htmlFrame?.height, CODE_BLOCK_MAX_CONTENT_HEIGHT + 3);
  assert.equal(htmlFrame?.border, true);
  assert.equal(htmlFrame?.title, undefined);
  const htmlLanguage = htmlCode === undefined
    ? undefined
    : htmlFrame?.findDescendantById(`code-language-${htmlCode.num}`);
  assert.ok(htmlLanguage instanceof TextRenderable);
  assert.equal(htmlLanguage.plainText, "HTML");
  const initialHtmlScrollTop = htmlViewport?.scrollTop ?? 0;
  const initialTranscriptScrollTop = codeTranscriptScrollbox?.scrollTop ?? 0;
  await act(async () => {
    if (htmlViewport !== undefined) {
      await setup.mockMouse.scroll(
        htmlViewport.x + 2,
        htmlViewport.y + 2,
        "down",
      );
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.ok((htmlViewport?.scrollTop ?? 0) > initialHtmlScrollTop);
  assert.equal(codeTranscriptScrollbox?.scrollTop, initialTranscriptScrollTop);

  const maxTranscriptScrollTop = codeTranscriptScrollbox === undefined
    ? 0
    : Math.max(
        0,
        codeTranscriptScrollbox.scrollHeight -
          codeTranscriptScrollbox.viewport.height,
      );
  assert.ok(maxTranscriptScrollTop > 2);
  await act(async () => {
    htmlViewport?.scrollTo(0);
    codeTranscriptScrollbox?.scrollTo(maxTranscriptScrollTop);
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const transcriptBeforeTopChain = codeTranscriptScrollbox?.scrollTop ?? 0;
  await act(async () => {
    if (htmlViewport !== undefined) {
      await setup.mockMouse.scroll(
        htmlViewport.x + 2,
        htmlViewport.y + 2,
        "up",
      );
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.equal(htmlViewport?.scrollTop, 0);
  assert.ok(
    (codeTranscriptScrollbox?.scrollTop ?? 0) < transcriptBeforeTopChain,
  );

  const maxHtmlScrollTop = htmlViewport === undefined
    ? 0
    : Math.max(0, htmlViewport.scrollHeight - htmlViewport.viewport.height);
  await act(async () => {
    htmlViewport?.scrollTo(maxHtmlScrollTop);
    codeTranscriptScrollbox?.scrollTo(maxTranscriptScrollTop - 2);
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const transcriptBeforeBottomChain = codeTranscriptScrollbox?.scrollTop ?? 0;
  await act(async () => {
    if (htmlViewport !== undefined) {
      await setup.mockMouse.scroll(
        htmlViewport.x + 2,
        htmlViewport.y + 2,
        "down",
      );
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.equal(htmlViewport?.scrollTop, maxHtmlScrollTop);
  assert.ok(
    (codeTranscriptScrollbox?.scrollTop ?? 0) > transcriptBeforeBottomChain,
  );
  assert.equal(
    jixuMarkdownSyntaxStyle
      .getStyle("keyword")
      ?.fg?.equals(RGBA.fromHex(jixuTheme.brand)),
    true,
  );
  assert.equal(
    jixuMarkdownSyntaxStyle
      .getStyle("string")
      ?.fg?.equals(RGBA.fromHex(jixuTheme.success)),
    true,
  );
  assert.equal(
    jixuMarkdownSyntaxStyle
      .getStyle("markup.raw.block")
      ?.bg?.equals(RGBA.fromHex(jixuTheme.elevated)),
    true,
  );

  await act(async () => {
    setup.resize(120, 50);
  });
  await act(async () => {
    await activeController.current?.submit("Markdown task");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const markdownFrame = setup.captureCharFrame();
  // JX-AC-045: complete Markdown uses semantic blocks instead of exposing
  // source punctuation, including task state and a compact column table.
  assert.match(markdownFrame, /Project Overview/);
  assert.match(markdownFrame, /Note: useful guidance with inline code\./);
  assert.match(markdownFrame, /Checklist/);
  assert.match(markdownFrame, /✓\s+Chat: durable context/);
  assert.match(markdownFrame, /○\s+Media: planned/);
  assert.match(markdownFrame, /Module\s+Status\s+Priority/);
  assert.match(markdownFrame, /Core\s+Active\s+P0/);
  assert.match(markdownFrame, /BASH/);
  assert.match(markdownFrame, /git clone https:\/\/example\.com\/jixu\.git/);
  assert.match(markdownFrame, /─{10}/);
  assert.doesNotMatch(
    markdownFrame,
    /# Project|## Checklist|> \*\*Note|\*\*Chat\*\*|\[x\]|\[ \]|\| :---|```bash/,
  );

  const transcriptScrollbox = setup.renderer.root.findDescendantById(
    "transcript-scrollbox",
  ) as ScrollBoxRenderable | undefined;
  assert.notEqual(transcriptScrollbox, undefined);
  assert.ok(
    transcriptScrollbox !== undefined &&
      transcriptScrollbox.scrollHeight > transcriptScrollbox.viewport.height,
  );
  await act(async () => {
    transcriptScrollbox?.scrollTo(0);
  });
  assert.equal(transcriptScrollbox?.scrollTop, 0);
  await act(async () => {
    composerEditor?.focus();
    await setup.mockInput.typeText("Scroll task");
    setup.mockInput.pressEnter();
    await scrollSubmissionStarted;
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  // JX-AC-046: Composer submission leaves history view and follows the new turn.
  assert.match(setup.captureCharFrame(), /Scroll task/);
  assert.equal(
    transcriptScrollbox?.scrollTop,
    transcriptScrollbox === undefined
      ? undefined
      : Math.max(
          0,
          transcriptScrollbox.scrollHeight - transcriptScrollbox.viewport.height,
        ),
  );
  await act(async () => {
    releaseScrollSubmission();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (activeController.current?.getSnapshot().busy === false) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await setup.flush();
  });
  assert.equal(activeController.current?.getSnapshot().busy, false);

  await act(async () => {
    setup.resize(120, 30);
    await setup.renderOnce();
    await setup.flush();
  });

  await act(async () => {
    if (activeController.current !== null) {
      await activeController.current.submit("Batch task");
    }
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const collapsedBatchFrame = setup.captureCharFrame();
  assert.match(collapsedBatchFrame, /5 done\s+Ctrl\+O Expand all/);
  assert.doesNotMatch(collapsedBatchFrame, /printf batch-1/);

  await act(async () => {
    setup.mockInput.pressKey("o", { ctrl: true });
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const batchOperations = activeController.current?.getSnapshot().transcript
    .flatMap((entry) => entry.kind === "tool-receipts" ? entry.operations : [])
    .filter((operation) => operation.detail?.startsWith("printf batch-")) ?? [];
  assert.equal(batchOperations.length, 5);
  const batchRows = batchOperations.map((operation) =>
    setup.renderer.root.findDescendantById(
      `tool-operation-${operation.effectId}`,
    ) as Renderable | undefined,
  );
  assert.ok(batchRows.every((row) => row !== undefined));
  assert.ok(
    batchRows.slice(1).every((row, index) =>
      row !== undefined && batchRows[index] !== undefined
        ? row.y > batchRows[index].y
        : false,
    ),
  );
  assert.ok(
    batchOperations.every((operation) =>
      setup.renderer.root.findDescendantById(
        `tool-detail-${operation.effectId}`,
      ) !== undefined,
    ),
  );
  const shortBatchDetail = setup.renderer.root.findDescendantById(
    `tool-detail-${batchOperations[0]?.effectId ?? "missing"}`,
  );
  assert.ok(
    shortBatchDetail !== undefined &&
      shortBatchDetail.height < 8,
  );

  await act(async () => {
    setup.mockInput.pressKey("o", { ctrl: true });
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });

  await act(async () => {
    if (activeController.current !== null) {
      await activeController.current.submit("Failure batch");
    }
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const failedBatchFrame = setup.captureCharFrame();
  assert.match(failedBatchFrame, /4 done · 1 unknown\s+Ctrl\+O Expand all/);
  assert.match(failedBatchFrame, /fail-indeterminate/);
  assert.match(failedBatchFrame, /Outcome unknown/);

  const controllerBeforeConfiguration = activeController.current;
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
  await act(async () => {
    setup.mockInput.pressEscape();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const returnedFrame = setup.captureCharFrame();
  assert.doesNotMatch(returnedFrame, /Model connection/);
  assert.match(returnedFrame, /vendor\/model-example/);
  assert.equal(activeController.current, controllerBeforeConfiguration);
} finally {
  act(() => {
    setup.renderer.destroy();
  });
}

const compactConfigSetup = await testRender(
  <JixuApp
    connect={async (_config, controls) =>
      createThreadController({ harness, ...controls })
    }
    initial={{ api: "openai-chat-completions" }}
    onQuit={() => undefined}
    workspace="/workspace"
  />,
  { height: 24, kittyKeyboard: true, width: 80 },
);

try {
  await act(async () => {
    await compactConfigSetup.renderOnce();
    await compactConfigSetup.flush();
  });
  await act(async () => {
    await compactConfigSetup.mockInput.typeText("/config");
  });
  await act(async () => {
    compactConfigSetup.mockInput.pressEnter();
  });
  await act(async () => {
    await compactConfigSetup.renderOnce();
    await compactConfigSetup.flush();
  });
  const compactConfigFrame = compactConfigSetup.captureCharFrame();
  // JX-AC-029 JX-AC-042: presets and reversible navigation survive 80x24.
  assert.match(compactConfigFrame, /JIXU  Configuration/);
  assert.match(compactConfigFrame, /BACK TO CHAT/);
  assert.match(compactConfigFrame, /Model connection/);
  assert.match(compactConfigFrame, /OpenAI/);
  assert.match(compactConfigFrame, /Groq/);
  assert.match(compactConfigFrame, /BASE URL/);
  assert.match(compactConfigFrame, /API KEY/);
  assert.match(compactConfigFrame, /MODEL ID/);
  assert.match(compactConfigFrame, /CONNECT/);
  assert.match(compactConfigFrame, /SETTINGS settings\.json/);
  assert.match(compactConfigFrame, /API KEY auth\.json/);
  assert.match(compactConfigFrame, /Esc Back/);
  assert.match(compactConfigFrame, /Tab Next/);
  assert.match(compactConfigFrame, /Enter Select/);
  assert.match(compactConfigFrame, /Ctrl\+C Quit/);
  assert.doesNotMatch(compactConfigFrame, /Chat Completions/);
  assert.doesNotMatch(compactConfigFrame, /·/);

  await act(async () => {
    compactConfigSetup.mockInput.pressKey("2");
  });
  await act(async () => {
    compactConfigSetup.mockInput.pressEnter();
  });
  await act(async () => {
    compactConfigSetup.mockInput.pressKey("2");
  });
  await act(async () => {
    await compactConfigSetup.renderOnce();
    await compactConfigSetup.flush();
  });
  assert.match(
    compactConfigSetup.captureCharFrame(),
    /https:\/\/openrouter\.ai\/api(?:\s|$)/,
  );

  await act(async () => {
    compactConfigSetup.mockInput.pressEscape();
  });
  await act(async () => {
    await compactConfigSetup.renderOnce();
    await compactConfigSetup.flush();
  });
  assert.match(compactConfigSetup.captureCharFrame(), /Model not configured/);
} finally {
  act(() => {
    compactConfigSetup.renderer.destroy();
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
