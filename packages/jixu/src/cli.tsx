import { resolve } from "node:path";

import { createHarness, defineAgent } from "@jixu/core";
import {
  createLLMAdapter,
  createLLMModelDriver,
} from "@jixu/llm";
import { JsonlEventStore } from "@jixu/store-jsonl";
import { createNodeTools } from "@jixu/tools-node";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { JIXU_REFERENCE_AGENT_INSTRUCTIONS } from "./agent-instructions.ts";
import { JixuConfigStore } from "./config.ts";
import type {
  JixuApi,
  JixuConnectionConfig,
} from "./config.ts";
import { createThreadController } from "./thread-controller.ts";
import { jixuTheme } from "./theme.ts";
import { JixuApp } from "./tui.tsx";

interface CliOptions {
  readonly api?: JixuApi;
  readonly baseUrl?: string;
  readonly help: boolean;
  readonly model?: string;
  readonly root: string;
}

const MODEL_DRIVER_ID = "configured-model";

const HELP = `Jixu — Agents that continue.

Usage:
  jixu [--api openai-chat-completions|anthropic-messages] [--base-url URL] [--model MODEL] [--root PATH]

Environment:
  JIXU_API               Prefill openai-chat-completions or anthropic-messages
  JIXU_BASE_URL          Prefill the selected protocol API root
  JIXU_MODEL             Prefill the model ID
  JIXU_API_KEY           Prefill credentials when auth.json has none
  JIXU_HOME              Override the global config directory
  JIXU_MOTION            Set to off for a static execution indicator

Examples:
  pnpm dev
  pnpm dev -- --api anthropic-messages --base-url https://api.anthropic.com
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

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
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

  const configStore = process.env.JIXU_HOME === undefined
    ? new JixuConfigStore()
    : new JixuConfigStore(resolve(process.env.JIXU_HOME));
  const stored = await configStore.load();
  const selectedApi = options.api ?? stored.api ?? "openai-chat-completions";
  const apiKey = stored.apiKey ?? process.env.JIXU_API_KEY;
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
  const tools = createNodeTools({
    filesystemScope: "process",
    root: options.root,
  });

  let quit!: () => void;
  const done = new Promise<void>((resolveDone) => {
    quit = resolveDone;
  });
  const connect = async (
    config: JixuConnectionConfig,
    controls: { readonly onConfigure: () => void; readonly onQuit: () => void },
  ) => {
    await configStore.saveConnection(config);
    const driver = createLLMModelDriver({
      api: config.api,
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      provider: MODEL_DRIVER_ID,
    });
    const agent = defineAgent({
      instructions: JIXU_REFERENCE_AGENT_INSTRUCTIONS,
      model: { model: config.model, provider: MODEL_DRIVER_ID },
      tools: tools.all,
    });
    const harness = createHarness({
      agent,
      modelDrivers: createLLMAdapter({ [MODEL_DRIVER_ID]: driver }),
      store: new JsonlEventStore(resolve(options.root, ".jixu")),
    });
    return createThreadController({ harness, ...controls });
  };
  const renderer = await createCliRenderer({
    backgroundColor: jixuTheme.canvas,
    clearOnShutdown: true,
    consoleMode: "disabled",
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const root = createRoot(renderer);
  const stop = () => quit();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    root.render(
      <JixuApp
        connect={connect}
        initial={{
          api: selectedApi,
          autoConnect,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(model === undefined ? {} : { model }),
        }}
        motion={process.env.JIXU_MOTION !== "off"}
        onQuit={quit}
        workspace={options.root}
      />,
    );
    await done;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    root.unmount();
    renderer.destroy();
  }
}

await runCli();
