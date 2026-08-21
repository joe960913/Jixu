import { resolve } from "node:path";

import { createHarness, defineAgent } from "jixu-core";
import {
  createLLMAdapter,
  createLLMModelDriver,
  resolveLLMModelCapabilities,
} from "jixu-llm";
import { JsonlEventStore } from "jixu-store-jsonl";
import { createJinaWebSearchTool } from "jixu-tools-jina";
import { createNodeTools } from "jixu-tools-node";
import {
  createClipboard,
  createCliRenderer,
  createHostClipboard,
  createRendererClipboardAdapter,
} from "@opentui/core";
import { createRoot } from "@opentui/react";

import { createJixuReferenceAgentInstructions } from "./agent-instructions.ts";
import {
  createJixuExitOutput,
  type JixuExitReason,
} from "./cli-exit.ts";
import { JixuConfigStore } from "./config.ts";
import { jixuToolPermissionPolicy } from "./config.ts";
import type {
  JixuApi,
  JixuConnectionConfig,
} from "./config.ts";
import { createThreadController } from "./thread-controller.ts";
import { jixuTheme } from "./theme.ts";
import { JixuApp } from "./tui.tsx";
import { installJixuSelectionClipboard } from "./tui-clipboard.ts";
import { registerJixuCodeParsers } from "./tui-parsers.ts";

interface CliOptions {
  readonly api?: JixuApi;
  readonly baseUrl?: string;
  readonly help: boolean;
  readonly model?: string;
  readonly root: string;
  readonly version: boolean;
}

const MODEL_DRIVER_ID = "configured-model";
const JIXU_VERSION = process.env.JIXU_VERSION ?? "0.0.0-dev";

const HELP = `Jixu — Continue durable Agent work in your terminal.

Usage:
  jixu [--api openai-chat-completions|anthropic-messages] [--base-url URL] [--model MODEL] [--root PATH]

Options:
  -h, --help             Show help
  -v, --version          Show the installed version

Environment:
  JIXU_API               Prefill openai-chat-completions or anthropic-messages
  JIXU_BASE_URL          Prefill the selected protocol API root
  JIXU_MODEL             Prefill the model ID
  JIXU_HOME              Override the global config directory
  JIXU_MOTION            Set to off to disable optional presentation motion

`;

function api(value: string | undefined): JixuApi | undefined {
  if (value === undefined) return undefined;
  if (
    value === "openai-chat-completions" ||
    value === "anthropic-messages"
  ) return value;
  throw new TypeError(
    `Unsupported API ${value}; use openai-chat-completions or anthropic-messages`,
  );
}

function valueAfter(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

export function parseCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CliOptions {
  let selectedApi = api(environment.JIXU_API);
  let selectedBaseUrl = environment.JIXU_BASE_URL;
  let selectedModel = environment.JIXU_MODEL;
  let root = process.cwd();
  let help = false;
  let version = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      version = true;
      continue;
    }
    if (argument === "--api") {
      selectedApi = api(valueAfter(args, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith("--api=")) {
      selectedApi = api(argument.slice("--api=".length));
      continue;
    }
    if (argument === "--base-url") {
      selectedBaseUrl = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--base-url=")) {
      selectedBaseUrl = argument.slice("--base-url=".length);
      continue;
    }
    if (argument === "--model") {
      selectedModel = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--model=")) {
      selectedModel = argument.slice("--model=".length);
      continue;
    }
    if (argument === "--root") {
      root = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--root=")) {
      root = argument.slice("--root=".length);
      continue;
    }
    throw new TypeError(`Unknown argument ${argument}`);
  }

  return {
    help,
    root: resolve(root),
    version,
    ...(selectedApi === undefined
      ? {}
      : { api: selectedApi }),
    ...(selectedBaseUrl === undefined ? {} : { baseUrl: selectedBaseUrl }),
    ...(selectedModel === undefined ? {} : { model: selectedModel }),
  };
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(args);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${JIXU_VERSION}\n`);
    return;
  }

  const parserRegistration = await registerJixuCodeParsers();
  if (parserRegistration.status === "unavailable") {
    process.stderr.write(
      `Jixu syntax highlighting is using raw-code fallback: ${parserRegistration.message}\n`,
    );
  }

  const configStore = process.env.JIXU_HOME === undefined
    ? new JixuConfigStore()
    : new JixuConfigStore(resolve(process.env.JIXU_HOME));
  const stored = await configStore.load();
  const selectedApi = options.api ?? stored.api ?? "openai-chat-completions";
  const apiKey = stored.apiKey;
  const baseUrl = options.baseUrl ?? stored.baseUrl;
  const model = options.model ?? stored.model;
  const autoConnect =
    stored.api !== undefined &&
    stored.apiKey !== undefined &&
    stored.baseUrl !== undefined &&
    stored.model !== undefined &&
    options.api === undefined &&
    options.baseUrl === undefined &&
    options.model === undefined;
  const createToolCatalogue = (config: JixuConnectionConfig["tools"]) => [
    ...createNodeTools({
      filesystemScope: config.fileScope,
      root: options.root,
    }).all,
    createJinaWebSearchTool({
      ...(config.webSearch.apiKey === undefined
        ? {}
        : { apiKey: config.webSearch.apiKey }),
      settingsPath:
        process.env.JIXU_HOME === undefined
          ? "~/.jixu/settings.json"
          : configStore.settingsPath,
    }),
  ];
  const toolCatalogue = createToolCatalogue(stored.tools);

  let exitReason: JixuExitReason | null = null;
  let finish!: () => void;
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });
  const requestQuit = (reason: JixuExitReason) => {
    if (exitReason === null) exitReason = reason;
    finish();
  };
  const quitInteractively = () => requestQuit("interactive");
  const connect = async (
    config: JixuConnectionConfig,
    controls: { readonly onConfigure: () => void; readonly onQuit: () => void },
  ) => {
    const modelCapabilities = await resolveLLMModelCapabilities({
      api: config.api,
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      ...(config.modelCapabilities === undefined
        ? {}
        : { explicit: config.modelCapabilities }),
      model: config.model,
    });
    const availableTools = createToolCatalogue(config.tools);
    const toolsByName = new Map(
      availableTools.map((tool) => [tool.descriptor.name, tool] as const),
    );
    const enabledTools = config.tools.enabled.map((name) => {
      const tool = toolsByName.get(name);
      if (tool === undefined) {
        throw new TypeError(`Configured Tool ${name} is not registered`);
      }
      return tool;
    });
    const driver = createLLMModelDriver({
      api: config.api,
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxOutputTokens: modelCapabilities.maxOutputTokens,
      provider: MODEL_DRIVER_ID,
    });
    await configStore.saveConnection(config);
    const agent = defineAgent({
      instructions: createJixuReferenceAgentInstructions({
        fileScope: config.tools.fileScope,
        tools: enabledTools,
      }),
      model: { model: config.model, provider: MODEL_DRIVER_ID },
      modelCapabilities,
      tools: enabledTools,
    });
    const harness = createHarness({
      agent,
      modelDrivers: createLLMAdapter({ [MODEL_DRIVER_ID]: driver }),
      store: new JsonlEventStore(resolve(options.root, ".jixu")),
      toolPermissionPolicy: jixuToolPermissionPolicy(config.tools),
    });
    await harness.listThreads();
    return createThreadController({ harness, ...controls });
  };
  const renderer = await createCliRenderer({
    backgroundColor: jixuTheme.canvas,
    clearOnShutdown: true,
    consoleMode: "disabled",
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const clipboard = createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(renderer),
  });
  const selectionClipboard = installJixuSelectionClipboard(renderer, clipboard);
  const root = createRoot(renderer);
  const stopOnInterrupt = () => requestQuit("interrupt");
  const stopOnTerminate = () => requestQuit("terminate");
  process.once("SIGINT", stopOnInterrupt);
  process.once("SIGTERM", stopOnTerminate);
  try {
    root.render(
      <JixuApp
        clipboard={clipboard}
        connect={connect}
        initial={{
          api: selectedApi,
          autoConnect,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(model === undefined ? {} : { model }),
          ...(stored.modelCapabilities === undefined
            ? {}
            : { modelCapabilities: stored.modelCapabilities }),
          tools: stored.tools,
        }}
        motion={process.env.JIXU_MOTION !== "off"}
        onQuit={quitInteractively}
        toolCatalogue={toolCatalogue}
        workspace={options.root}
      />,
    );
    await done;
  } finally {
    process.off("SIGINT", stopOnInterrupt);
    process.off("SIGTERM", stopOnTerminate);
    try {
      await selectionClipboard.dispose();
    } finally {
      root.unmount();
      renderer.destroy();
    }
  }

  const exitOutput = createJixuExitOutput({
    color:
      process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
    reason: exitReason,
    stdoutIsTTY: process.stdout.isTTY === true,
  });
  if (exitOutput.length > 0) process.stdout.write(exitOutput);
}

try {
  await runCli();
} catch (error) {
  const message = error instanceof Error ? error.message : "Jixu failed to start.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
