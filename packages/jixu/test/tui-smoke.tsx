import assert from "node:assert/strict";

import {
  createHarness,
  defineAgent,
  defineSchema,
  defineTool,
  EMPTY_MODEL_ACCOUNTING,
  InMemoryEventStore,
  TOOL_OUTPUT_SIGNAL_TYPE,
} from "jixu-core";
import type { ModelDriver } from "jixu-core";
import { createJinaWebSearchTool } from "jixu-tools-jina";
import { createNodeTools } from "jixu-tools-node";
import { encode } from "fast-png";
import {
  BoxRenderable,
  CliRenderEvents,
  CodeRenderable,
  getTreeSitterClient,
  imageInfo,
  ImageRenderable,
  RGBA,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  type BaseRenderable,
  type ClipboardService,
  type Renderable,
  type TextareaRenderable,
} from "@opentui/core";
import { setRendererCapabilities } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import {
  DEFAULT_JIXU_TOOL_SETTINGS,
  type JixuConnectionConfig,
} from "../src/config.ts";
import { createThreadController } from "../src/thread-controller.ts";
import type { ThreadController } from "../src/thread-controller.ts";
import { jixuNipponColors, jixuTheme } from "../src/theme.ts";
import { installJixuSelectionClipboard } from "../src/tui-clipboard.ts";
import { BUTTERFLY_MOTION_CADENCE_MS } from "../src/tui-creation-mark.tsx";
import { CODE_BLOCK_MAX_CONTENT_HEIGHT } from "../src/tui-markdown.ts";
import type { ThreadControllerSnapshot } from "../src/tui-model.ts";
import { registerJixuCodeParsers } from "../src/tui-parsers.ts";
import {
  normalizePastedImage,
  PASTED_IMAGE_MAX_BYTES,
  PASTED_IMAGE_MAX_EDGE,
  PASTED_IMAGE_MAX_PIXELS,
  PastedImageNormalizationError,
} from "../src/tui-pasted-image.ts";
import { jixuMarkdownSyntaxStyle } from "../src/tui-syntax-theme.ts";
import { ToolApprovalPrompt } from "../src/tui-tool-approval.tsx";
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
    const planOnlyExecution = latestUser?.content === "Plan-only task";
    const planCancelExecution = latestUser?.content === "Cancel Plan task";
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
    if (planOnlyExecution) {
      const correctingRejectedPlan =
        effect.input.planRejectionFeedback !== undefined;
      return {
        accounting: smokeAccounting(true),
        status: "succeeded",
        value:
          effect.input.activePlan === null
            ? {
                content: correctingRejectedPlan
                  ? "I created the Plan and it is ready to use."
                  : "",
                planUpdates: [{
                  acceptanceCriteria: ["The Plan is visible and ready"],
                  assumptions: [],
                  blockers: [],
                  nextAction: correctingRejectedPlan
                    ? "Wait for user instruction"
                    : null,
                  objective: "Prepare the requested work",
                  operation: "create",
                  steps: [
                    {
                      description: "Inspect the request",
                      evidence: [],
                      id: "inspect-request",
                      status: "pending",
                    },
                    {
                      description: "Complete the work",
                      evidence: [],
                      id: "complete-work",
                      status: "pending",
                    },
                  ],
                }],
                toolCalls: [],
              }
            : { content: "The Plan is ready to use.", planUpdates: [], toolCalls: [] },
      };
    }
    if (planCancelExecution && effect.input.activePlan !== null) {
      if (effect.input.planRejectionFeedback === undefined) {
        return {
          accounting: smokeAccounting(true),
          planRejections: [{
            code: "plan_update_invalid",
            message: "Plan control fixture.steps[0] must be a JSON object",
            retryable: false,
          }],
          status: "succeeded",
          value: { content: "", planUpdates: [], toolCalls: [] },
        };
      }
      return {
        accounting: smokeAccounting(true),
        status: "succeeded",
        value: {
          content: "I cancelled the Plan.",
          planUpdates: [{
            acceptanceCriteria: effect.input.activePlan.acceptanceCriteria,
            assumptions: effect.input.activePlan.assumptions,
            blockers: effect.input.activePlan.blockers,
            nextAction: null,
            objective: effect.input.activePlan.objective,
            operation: "abandon",
            steps: effect.input.activePlan.steps.map((step) => ({
              ...step,
              status: step.status === "in_progress" ? "skipped" : step.status,
            })),
          }],
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
const toolCatalogue = [
  ...createNodeTools({ root: process.cwd() }).all,
  createJinaWebSearchTool(),
];

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
    toolCatalogue={toolCatalogue}
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
  assert.match(configurationFrame, /API KEY\s+SAVED IN SETTINGS\.JSON/);
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
    tools: DEFAULT_JIXU_TOOL_SETTINGS,
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
  assert.match(connectedFrame, /TOOLS\s+read write edit bash/);
  assert.match(connectedFrame, /FILES workspace/);
  assert.match(connectedFrame, /BASH process/);
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
  assert.match(thinkingFrame, /FILES workspace/);

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
  assert.doesNotMatch(directFrame, /Ctrl\+O/);
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
      ) as ScrollBoxRenderable | undefined;
  assert.equal(editDetail?.height, 8);
  const toolTranscriptScrollbox = setup.renderer.root.findDescendantById(
    "transcript-scrollbox",
  ) as ScrollBoxRenderable | undefined;
  assert.notEqual(toolTranscriptScrollbox, undefined);
  const maxToolTranscriptScrollTop = toolTranscriptScrollbox === undefined
    ? 0
    : Math.max(
        0,
        toolTranscriptScrollbox.scrollHeight -
          toolTranscriptScrollbox.viewport.height,
      );
  const toolTranscriptStart = Math.max(0, maxToolTranscriptScrollTop - 2);
  await act(async () => {
    editDetail?.scrollTo(0);
    toolTranscriptScrollbox?.scrollTo(toolTranscriptStart);
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const editDetailStart = editDetail?.scrollTop ?? 0;
  await act(async () => {
    if (editDetail !== undefined) {
      await setup.mockMouse.scroll(
        editDetail.x + 1,
        editDetail.y + 2,
        "down",
      );
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  // JX-AC-041: an overflowing Tool detail owns wheel input while it can move.
  assert.ok((editDetail?.scrollTop ?? 0) > editDetailStart);
  assert.equal(toolTranscriptScrollbox?.scrollTop, toolTranscriptStart);
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

  const maxEditDetailScrollTop = editDetail === undefined
    ? 0
    : Math.max(0, editDetail.scrollHeight - editDetail.viewport.height);
  await act(async () => {
    editDetail?.scrollTo(maxEditDetailScrollTop);
    toolTranscriptScrollbox?.scrollTo(toolTranscriptStart);
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  await act(async () => {
    if (editDetail !== undefined) {
      await setup.mockMouse.scroll(
        editDetail.x + 1,
        editDetail.y + 2,
        "down",
      );
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  assert.ok(
    (toolTranscriptScrollbox?.scrollTop ?? 0) > toolTranscriptStart,
  );
  await act(async () => {
    if (toolTranscriptScrollbox !== undefined) {
      toolTranscriptScrollbox.scrollTo(
        Math.max(
          0,
          toolTranscriptScrollbox.scrollHeight -
            toolTranscriptScrollbox.viewport.height,
        ),
      );
    }
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });

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
    await activeController.current?.submit("/new");
    await activeController.current?.submit("Plan-only task");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const planOnlyFrame = setup.captureCharFrame();
  assert.match(planOnlyFrame, /I created the Plan and it is ready to use\./);
  assert.match(planOnlyFrame, /Prepare the requested/);
  assert.doesNotMatch(planOnlyFrame, /reply without text|PLAN\s+r\d+/);
  const planStrip = setup.renderer.root.findDescendantById("plan-strip") as
    | Renderable
    | undefined;
  const composer = setup.renderer.root.findDescendantById("composer") as
    | Renderable
    | undefined;
  assert.notEqual(planStrip, undefined);
  assert.notEqual(composer, undefined);
  assert.equal(
    planStrip === undefined || composer === undefined
      ? undefined
      : planStrip.y + planStrip.height,
    composer?.y,
  );

  await act(async () => {
    await activeController.current?.submit("Cancel Plan task");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const cancelledPlanFrame = setup.captureCharFrame();
  assert.match(cancelledPlanFrame, /I cancelled the Plan\./);
  assert.doesNotMatch(cancelledPlanFrame, /reply without text|Model failed/);
  assert.equal(setup.renderer.root.findDescendantById("plan-strip"), undefined);

  if (directThreadId !== null && directThreadId !== undefined) {
    await act(async () => {
      await activeController.current?.selectThread(directThreadId);
    });
  }
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });

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
  assert.match(completedFrame, /PLAN/);
  assert.doesNotMatch(completedFrame, /PLAN\s+r\d+/);
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
  assert.match(collapsedBatchFrame, /5 done/);
  assert.doesNotMatch(collapsedBatchFrame, /Ctrl\+O/);
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
  assert.match(failedBatchFrame, /4 done · 1 unknown/);
  assert.doesNotMatch(failedBatchFrame, /Ctrl\+O/);
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
    toolCatalogue={toolCatalogue}
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
  assert.match(compactConfigFrame, /← BACK/);
  assert.match(compactConfigFrame, /Model connection/);
  assert.match(compactConfigFrame, /OpenAI/);
  assert.match(compactConfigFrame, /Groq/);
  assert.match(compactConfigFrame, /BASE URL/);
  assert.match(compactConfigFrame, /API KEY/);
  assert.match(compactConfigFrame, /MODEL ID/);
  assert.match(compactConfigFrame, /CONNECT/);
  assert.doesNotMatch(compactConfigFrame, /SETTINGS settings\.json/);
  assert.doesNotMatch(compactConfigFrame, /API KEY auth\.json/);
  assert.match(compactConfigFrame, /Esc Back/);
  assert.match(compactConfigFrame, /Tab Next/);
  assert.match(compactConfigFrame, /Enter Select/);
  assert.match(compactConfigFrame, /Ctrl\+C Quit/);
  assert.doesNotMatch(compactConfigFrame, /Chat Completions/);
  assert.doesNotMatch(compactConfigFrame, /·/);

  const toolsTab = compactConfigSetup.renderer.root.findDescendantById(
    "config-tools-tab",
  );
  assert.notEqual(toolsTab, undefined);
  await act(async () => {
    if (toolsTab !== undefined) {
      await compactConfigSetup.mockMouse.click(toolsTab.x, toolsTab.y);
    }
  });
  await act(async () => {
    await compactConfigSetup.renderOnce();
    await compactConfigSetup.flush();
  });
  const toolCenterFrame = compactConfigSetup.captureCharFrame();
  assert.match(toolCenterFrame, /Tool Center/);
  assert.match(toolCenterFrame, /PROFILE\s+BALANCED/);
  assert.match(toolCenterFrame, /FILE SCOPE\s+WORKSPACE/);
  assert.match(toolCenterFrame, /read/);
  assert.match(toolCenterFrame, /write/);
  assert.match(toolCenterFrame, /edit/);
  assert.match(toolCenterFrame, /bash/);
  assert.match(toolCenterFrame, /web_search/);
  assert.match(toolCenterFrame, /Jina key missing/);
  assert.match(toolCenterFrame, /not OS-sandboxed/);

  await act(async () => {
    compactConfigSetup.mockInput.pressEscape();
  });
  await act(async () => {
    await compactConfigSetup.renderOnce();
    await compactConfigSetup.flush();
  });
  assert.match(compactConfigSetup.captureCharFrame(), /Model connection/);

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

const approvalSnapshot = {
  activePlan: null,
  activity: [],
  busy: false,
  currentThreadId: "approval-thread",
  inspection: null,
  metrics: null,
  streamingText: "",
  threadPickerOpen: false,
  threads: [],
  threadStatus: "waiting",
  toolApproval: {
    action: "bash",
    decision: null,
    decisionEventId: null,
    effectId: "approval-effect",
    name: "bash",
    resources: ["process"],
    toolCallId: "approval-call",
  },
  toolLiveOutput: {},
  toolOperations: [],
  transcript: [],
  workStatus: null,
} satisfies ThreadControllerSnapshot;
const approvalSetup = await testRender(
  <ToolApprovalPrompt
    controller={null}
    snapshot={approvalSnapshot}
    width={80}
  />,
  { height: 5, width: 80 },
);

try {
  await act(async () => {
    await approvalSetup.renderOnce();
    await approvalSetup.flush();
  });
  const approvalFrame = approvalSetup.captureCharFrame();
  assert.match(approvalFrame, /APPROVAL/);
  assert.match(approvalFrame, /bash requests bash on process/);
  assert.match(approvalFrame, /ALLOW ONCE/);
  assert.match(approvalFrame, /DENY/);
  assert.notEqual(
    approvalSetup.renderer.root.findDescendantById("tool-approval-allow"),
    undefined,
  );
  assert.notEqual(
    approvalSetup.renderer.root.findDescendantById("tool-approval-deny"),
    undefined,
  );
} finally {
  act(() => {
    approvalSetup.renderer.destroy();
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
    tools: DEFAULT_JIXU_TOOL_SETTINGS,
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
    tools: DEFAULT_JIXU_TOOL_SETTINGS,
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
  assert.match(compactFrame, /FILES workspace/);
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
  assert.match(compactCommandFrame, /FILES workspace/);

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
  assert.match(compactCompletedFrame, /PLAN/);
  assert.doesNotMatch(compactCompletedFrame, /PLAN\s+r\d+/);
  assert.match(compactCompletedFrame, /Explain the repository/);
  assert.match(compactCompletedFrame, /USD —/);
  assert.doesNotMatch(compactCompletedFrame, /ACTIVITY/);
} finally {
  act(() => {
    compactSetup.renderer.destroy();
  });
}

const responsiveButterflyMarkSetup = await testRender(
  <JixuApp
    connect={async () => {
      throw new Error("Responsive butterfly-mark fixture must not connect");
    }}
    initial={{ api: "openai-chat-completions" }}
    motion={false}
    onQuit={() => undefined}
    toolCatalogue={toolCatalogue}
    workspace="/workspace"
  />,
  { height: 30, width: 100 },
);

try {
  await act(async () => {
    await responsiveButterflyMarkSetup.renderOnce();
    await responsiveButterflyMarkSetup.flush();
  });
  const smallButterflyMarkFrame =
    responsiveButterflyMarkSetup.captureCharFrame();
  // Scoped UI regression: 100x30 renders the 25x10 source variant.
  assert.notEqual(
    responsiveButterflyMarkSetup.renderer.root.findDescendantById(
      "jixu-creation-mark",
    ),
    undefined,
  );
  assert.match(
    smallButterflyMarkFrame,
    /=\+{2}=-\..*\.=-\+\*\+-/,
  );
  assert.match(smallButterflyMarkFrame, /-\*%\*=--==\+=\./);

  await act(async () => {
    responsiveButterflyMarkSetup.resize(100, 40);
  });
  await act(async () => {
    await responsiveButterflyMarkSetup.renderOnce();
    await responsiveButterflyMarkSetup.flush();
  });
  const compactButterflyMarkFrame =
    responsiveButterflyMarkSetup.captureCharFrame();
  // Scoped UI regression: 100x40 promotes to the 40x16 source variant.
  assert.match(
    compactButterflyMarkFrame,
    /-\+{2}=\..*-\+{3}:/,
  );
  assert.match(compactButterflyMarkFrame, /=\+\*%%##\*{2}\+=/);

  const butterflySpans = responsiveButterflyMarkSetup
    .captureSpans()
    .lines.flatMap((line) => line.spans);
  assert.equal(
    butterflySpans.some(
      (span) =>
        span.fg.equals(RGBA.fromHex(jixuTheme.brand)) &&
        /[%#*]/u.test(span.text),
    ),
    true,
  );
  assert.equal(
    butterflySpans.some(
      (span) =>
        span.fg.equals(RGBA.fromHex(jixuTheme.brand)) &&
        span.text.includes("#%#"),
    ),
    true,
  );
  assert.equal(
    butterflySpans.some((span) =>
      span.fg.equals(RGBA.fromHex(jixuNipponColors.gofun)),
    ),
    true,
  );
  assert.equal(
    butterflySpans.some((span) =>
      span.fg.equals(RGBA.fromHex(jixuNipponColors.mizuasagi)),
    ),
    true,
  );

  await act(async () => {
    responsiveButterflyMarkSetup.resize(160, 54);
  });
  await act(async () => {
    await responsiveButterflyMarkSetup.renderOnce();
    await responsiveButterflyMarkSetup.flush();
  });
  const cappedButterflyMarkFrame =
    responsiveButterflyMarkSetup.captureCharFrame();
  // Scoped UI regression: a roomy frame keeps the 16-row maximum.
  assert.match(
    cappedButterflyMarkFrame,
    /-\+{2}=\..*-\+{3}:/,
  );
  assert.doesNotMatch(cappedButterflyMarkFrame, /:\*#@@@#\*:/);
  assert.doesNotMatch(
    `${smallButterflyMarkFrame}\n${compactButterflyMarkFrame}\n${cappedButterflyMarkFrame}`,
    /[▀▄█]/u,
  );
  assert.match(cappedButterflyMarkFrame, /Type \/ to view commands\./);
  assert.equal(
    containsImageRenderable(responsiveButterflyMarkSetup.renderer.root),
    false,
  );
} finally {
  act(() => {
    responsiveButterflyMarkSetup.renderer.destroy();
  });
}

const motionButterflyMarkSetup = await testRender(
  <JixuApp
    connect={async () => {
      throw new Error("Motion butterfly-mark fixture must not connect");
    }}
    initial={{ api: "openai-chat-completions" }}
    motion
    onQuit={() => undefined}
    toolCatalogue={toolCatalogue}
    workspace="/workspace"
  />,
  { height: 40, width: 100 },
);

try {
  await act(async () => {
    await motionButterflyMarkSetup.renderOnce();
    await motionButterflyMarkSetup.flush();
  });
  const firstMotionFrame = motionButterflyMarkSetup.captureCharFrame();
  const firstMotionColors = motionButterflyMarkSetup
    .captureSpans()
    .lines.flatMap((line) => line.spans.map((span) => span.fg.toString()));
  let publishedMotionFrames = 0;
  const countMotionFrame = () => {
    publishedMotionFrames += 1;
  };
  motionButterflyMarkSetup.renderer.on(
    CliRenderEvents.FRAME,
    countMotionFrame,
  );

  try {
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, BUTTERFLY_MOTION_CADENCE_MS + 80),
      );
    });
  } finally {
    motionButterflyMarkSetup.renderer.off(
      CliRenderEvents.FRAME,
      countMotionFrame,
    );
  }
  const secondMotionFrame = motionButterflyMarkSetup.captureCharFrame();
  const secondMotionSpans = motionButterflyMarkSetup
    .captureSpans()
    .lines.flatMap((line) => line.spans);
  const secondMotionColors = secondMotionSpans.map((span) =>
    span.fg.toString()
  );

  // The timer must publish through the normal renderer scheduler. A manual
  // renderOnce() here would hide a production regression behind test I/O.
  assert.ok(publishedMotionFrames > 0);
  assert.equal(secondMotionFrame, firstMotionFrame);
  assert.notDeepEqual(secondMotionColors, firstMotionColors);
  assert.equal(
    secondMotionSpans.some(
      (span) =>
        span.fg.equals(RGBA.fromHex(jixuTheme.brand)) &&
        span.text.includes("#%#"),
    ),
    true,
  );
} finally {
  act(() => {
    motionButterflyMarkSetup.renderer.destroy();
  });
}

const selectionClipboardSetup = await testRender(
  <box style={{ flexDirection: "column", height: 4, width: 40 }}>
    <text id="clipboard-copy-one">Alpha copy</text>
    <text id="clipboard-copy-two">Beta copy</text>
    <textarea
      focused
      id="clipboard-editor"
      initialValue="Editor selection"
      style={{ height: 1, width: 24 }}
    />
  </box>,
  { exitOnCtrlC: false, height: 6, kittyKeyboard: true, width: 44 },
);
const clipboardWrites: Array<{
  readonly destination: "best-available";
  readonly text: string;
}> = [];
let clipboardDisposals = 0;
let failNextClipboardWrite = false;
let nextClipboardWriteGate:
  | { readonly started: () => void; readonly wait: Promise<void> }
  | undefined;
const selectionClipboard = installJixuSelectionClipboard(
  selectionClipboardSetup.renderer,
  {
    dispose: async () => {
      clipboardDisposals += 1;
    },
    writeText: async (text, options) => {
      clipboardWrites.push({ destination: options.destination, text });
      const gate = nextClipboardWriteGate;
      nextClipboardWriteGate = undefined;
      if (gate !== undefined) {
        gate.started();
        await gate.wait;
      }
      if (!failNextClipboardWrite) return;
      failNextClipboardWrite = false;
      throw new Error("Clipboard failure fixture");
    },
  },
);

try {
  await act(async () => {
    await selectionClipboardSetup.renderOnce();
    await selectionClipboardSetup.flush();
  });
  const firstCopy = selectionClipboardSetup.renderer.root.findDescendantById(
    "clipboard-copy-one",
  );
  const secondCopy = selectionClipboardSetup.renderer.root.findDescendantById(
    "clipboard-copy-two",
  );
  const clipboardEditor = selectionClipboardSetup.renderer.root.findDescendantById(
    "clipboard-editor",
  ) as TextareaRenderable | undefined;
  assert.ok(firstCopy instanceof TextRenderable);
  assert.ok(secondCopy instanceof TextRenderable);
  assert.notEqual(clipboardEditor, undefined);

  await act(async () => {
    await selectionClipboardSetup.mockMouse.drag(
      firstCopy.x,
      firstCopy.y,
      firstCopy.x + 4,
      firstCopy.y,
    );
  });
  const firstSelectedText =
    selectionClipboardSetup.renderer.getSelection()?.getSelectedText();
  assert.notEqual(firstSelectedText, undefined);
  await selectionClipboard.settled();
  // Scoped UI regression: selection completion copies its exact text once.
  assert.deepEqual(clipboardWrites, [
    { destination: "best-available", text: firstSelectedText },
  ]);

  failNextClipboardWrite = true;
  await act(async () => {
    await selectionClipboardSetup.mockMouse.drag(
      secondCopy.x,
      secondCopy.y,
      secondCopy.x + 3,
      secondCopy.y,
    );
  });
  const secondSelectedText =
    selectionClipboardSetup.renderer.getSelection()?.getSelectedText();
  assert.notEqual(secondSelectedText, undefined);
  clipboardEditor?.setSelection(0, 6);
  act(() => {
    selectionClipboardSetup.mockInput.pressKey("c", { super: true });
  });
  await selectionClipboard.settled();
  // Scoped UI regression: failure is contained and editor selection wins.
  assert.deepEqual(clipboardWrites.slice(1), [
    { destination: "best-available", text: secondSelectedText },
    { destination: "best-available", text: "Editor" },
  ]);

  clipboardEditor?.clearSelection();
  selectionClipboardSetup.renderer.clearSelection();
  const writesBeforeEmptyCopy = clipboardWrites.length;
  act(() => {
    selectionClipboardSetup.mockInput.pressKey("c", { super: true });
  });
  await selectionClipboard.settled();
  assert.equal(clipboardWrites.length, writesBeforeEmptyCopy);

  let ctrlCObserved = 0;
  selectionClipboardSetup.renderer.keyInput.on("keypress", (key) => {
    if (key.name === "c" && key.ctrl === true) ctrlCObserved += 1;
  });
  act(() => {
    selectionClipboardSetup.mockInput.pressCtrlC();
  });
  assert.equal(ctrlCObserved, 1);

  clipboardEditor?.setCursor(0, "Editor selection".length);
  await act(async () => {
    await selectionClipboardSetup.mockInput.pasteBracketedText(" pasted");
  });
  await act(async () => {
    await selectionClipboardSetup.renderOnce();
    await selectionClipboardSetup.flush();
  });
  assert.equal(clipboardEditor?.plainText, "Editor selection pasted");

  let releaseClipboardWrite!: () => void;
  const clipboardWriteGate = new Promise<void>((resolve) => {
    releaseClipboardWrite = resolve;
  });
  let markClipboardWriteStarted!: () => void;
  const clipboardWriteStarted = new Promise<void>((resolve) => {
    markClipboardWriteStarted = resolve;
  });
  nextClipboardWriteGate = {
    started: markClipboardWriteStarted,
    wait: clipboardWriteGate,
  };
  clipboardEditor?.setSelection(0, 6);
  act(() => {
    selectionClipboardSetup.mockInput.pressKey("c", { super: true });
  });
  await clipboardWriteStarted;
  const writesBeforeDispose = clipboardWrites.length;
  const clipboardDispose = selectionClipboard.dispose();
  await Promise.resolve();
  assert.equal(clipboardDisposals, 0);
  releaseClipboardWrite();
  await clipboardDispose;
  await selectionClipboard.dispose();
  assert.equal(clipboardDisposals, 1);
  act(() => {
    selectionClipboardSetup.mockInput.pressKey("c", { super: true });
  });
  await selectionClipboard.settled();
  assert.equal(clipboardWrites.length, writesBeforeDispose);
} finally {
  await selectionClipboard.dispose();
  act(() => {
    selectionClipboardSetup.renderer.destroy();
  });
}

const pastedPngFixture = encode({
  channels: 4,
  data: Uint8Array.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]),
  depth: 8,
  height: 2,
  width: 2,
});
const pastedJpegFixture = Uint8Array.from(
  Buffer.from(
    [
      "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKAC",
      "AAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZ",
      "jwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIB",
      "AwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNE",
      "RUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfI",
      "ycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIB",
      "AgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpD",
      "REVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG",
      "x8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgK",
      "CgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
      "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/FeiiiucD//Z",
    ].join(""),
    "base64",
  ),
);

{
  // JX-TUI-035 JX-AC-052: conforming PNG is retained, while other or oversized
  // clipboard formats become bounded, decodable, orientation-corrected PNG.
  const retained = normalizePastedImage(pastedPngFixture, "image/png");
  assert.deepEqual(retained.bytes, pastedPngFixture);
  assert.equal(retained.sourceByteLength, pastedPngFixture.byteLength);

  const converted = normalizePastedImage(pastedJpegFixture, "image/jpeg");
  assert.equal(converted.mediaType, "image/png");
  assert.equal(imageInfo(converted.bytes).format, "png");
  assert.equal(converted.sourceByteLength, pastedJpegFixture.byteLength);

  const width = 2_300;
  const height = 1_900;
  const sourcePixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < sourcePixels.length; index += 4) {
    const pixel = index / 4;
    sourcePixels[index] = pixel % 251;
    sourcePixels[index + 1] = Math.floor(pixel / width) % 251;
    sourcePixels[index + 2] = (pixel * 17) % 251;
    sourcePixels[index + 3] = 255;
  }
  const oversized = encode(
    { channels: 4, data: sourcePixels, depth: 8, height, width },
    { zlib: { level: 3 } },
  );
  const bounded = normalizePastedImage(oversized, "image/png");
  assert.ok(bounded.bytes.byteLength <= PASTED_IMAGE_MAX_BYTES);
  assert.ok(bounded.width <= PASTED_IMAGE_MAX_EDGE);
  assert.ok(bounded.height <= PASTED_IMAGE_MAX_EDGE);
  assert.ok(bounded.width * bounded.height <= PASTED_IMAGE_MAX_PIXELS);
  assert.ok(Math.abs(bounded.width / bounded.height - width / height) < 0.01);
  assert.equal(imageInfo(bounded.bytes).format, "png");

  assert.throws(
    () => normalizePastedImage(pastedJpegFixture, "image/png"),
    PastedImageNormalizationError,
  );
}

const multimodalEffects: Parameters<ModelDriver["generate"]>[0][] = [];
const multimodalStore = new InMemoryEventStore();
const multimodalHarness = createHarness({
  agent: defineAgent({
    instructions: "Describe pasted images.",
    model: { model: "multimodal-fixture", provider: "mock" },
  }),
  modelDrivers: {
    mock: {
      generate: async (effect) => {
        multimodalEffects.push(structuredClone(effect));
        return {
          accounting: EMPTY_MODEL_ACCOUNTING,
          status: "succeeded",
          value: { content: "Both images received.", toolCalls: [] },
        };
      },
    },
  },
  store: multimodalStore,
});
const pastedClipboardImages = [
  {
    bytes: pastedPngFixture,
    mimeType: "image/png",
  },
  {
    bytes: pastedJpegFixture,
    mimeType: "image/jpeg",
  },
] as const;
let pastedClipboardIndex = 0;
const pastedClipboard: Pick<ClipboardService, "read"> = {
  read: async (options) => {
    assert.equal(options.preferredTypes.includes("image/png"), true);
    const representation = pastedClipboardImages[pastedClipboardIndex];
    pastedClipboardIndex += 1;
    return representation === undefined
      ? { status: "unsupported" }
      : { representation, status: "read" };
  },
};
let multimodalController: ThreadController | null = null;
const multimodalSetup = await testRender(
  <JixuApp
    clipboard={pastedClipboard}
    connect={async (_config, controls) => {
      multimodalController = createThreadController({
        harness: multimodalHarness,
        ...controls,
      });
      return multimodalController;
    }}
    initial={{
      api: "openai-chat-completions",
      apiKey: "fixture",
      autoConnect: true,
      baseUrl: "https://fixture.invalid/v1",
      model: "multimodal-fixture",
    }}
    motion={false}
    onQuit={() => undefined}
    workspace="/workspace"
  />,
  { height: 30, kittyKeyboard: true, width: 120 },
);

try {
  await act(async () => {
    await multimodalSetup.renderOnce();
    await Promise.resolve();
    await multimodalSetup.flush();
  });
  await act(async () => {
    await Promise.resolve();
    await multimodalSetup.flush();
  });
  const multimodalComposer = multimodalSetup.renderer.root.findDescendantById(
    "composer-editor",
  ) as TextareaRenderable | undefined;
  assert.notEqual(multimodalComposer, undefined);

  await act(async () => {
    await multimodalSetup.mockInput.typeText("帮我看看这个 ");
    multimodalSetup.mockInput.pressKey("v", { ctrl: true });
    await Promise.resolve();
  });
  await act(async () => {
    await multimodalSetup.renderOnce();
    await multimodalSetup.flush();
  });
  assert.equal(multimodalComposer?.plainText, "帮我看看这个 [pasted image 1]");

  await act(async () => {
    await multimodalSetup.mockInput.typeText(" 是啥， 这个 ");
    multimodalSetup.mockInput.pressKey("v", { ctrl: true });
    await Promise.resolve();
  });
  await act(async () => {
    await multimodalSetup.renderOnce();
    await multimodalSetup.flush();
  });
  await act(async () => {
    await multimodalSetup.mockInput.typeText(" 又是啥");
  });
  await act(async () => {
    await multimodalSetup.renderOnce();
    await multimodalSetup.flush();
  });
  // JX-TUI-035 JX-AC-052: Composer keeps ordered, editable placeholders.
  assert.equal(
    multimodalComposer?.plainText,
    "帮我看看这个 [pasted image 1] 是啥， 这个 [pasted image 2] 又是啥",
  );

  await act(async () => {
    multimodalSetup.mockInput.pressEnter();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        multimodalEffects.length === 1 &&
        multimodalController?.getSnapshot().busy === false
      ) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  await act(async () => {
    await Promise.resolve();
    await multimodalSetup.renderOnce();
    await multimodalSetup.flush();
  });
  assert.equal(multimodalComposer?.plainText, "");
  assert.equal(multimodalEffects.length, 1);
  const submitted = multimodalEffects[0]?.input.messages.at(-1);
  assert.equal(submitted?.role, "user");
  assert.equal(
    submitted?.content,
    "帮我看看这个 [pasted image 1] 是啥， 这个 [pasted image 2] 又是啥",
  );
  assert.deepEqual(
    submitted?.role === "user"
      ? submitted.parts?.map((part) => part.type)
      : undefined,
    ["text", "image", "text", "image", "text"],
  );
  for (const part of submitted?.role === "user" ? submitted.parts ?? [] : []) {
    if (part.type === "image") {
      const artifact = await multimodalStore.readArtifact(part.artifact);
      assert.equal(artifact.byteLength, part.artifact.byteLength);
      assert.equal(part.artifact.mediaType, "image/png");
      assert.equal(imageInfo(artifact).format, "png");
    }
  }

  await act(async () => {
    await multimodalSetup.mockInput.pasteBracketedText("ordinary text paste");
  });
  await act(async () => {
    await multimodalSetup.renderOnce();
    await multimodalSetup.flush();
  });
  assert.equal(multimodalComposer?.plainText, "ordinary text paste");
} finally {
  act(() => {
    multimodalSetup.renderer.destroy();
  });
}
