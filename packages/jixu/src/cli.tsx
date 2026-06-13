import { resolve } from "node:path";

import { createRuntime, defineAgent } from "@jixu/core";
import {
  createLLMAdapter,
  createOpenAICompatibleModelDriver,
} from "@jixu/llm";
import { JsonlEventStore } from "@jixu/store-jsonl";
import { createNodeTools } from "@jixu/tools-node";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { JixuConfigStore } from "./config.ts";
import type {
  JixuApiFormat,
  JixuConnectionConfig,
} from "./config.ts";
import { createJixuSession } from "./session.ts";
import { jixuTheme } from "./theme.ts";
import { JixuApp } from "./tui.tsx";

interface CliOptions {
  readonly apiFormat?: JixuApiFormat;
  readonly baseUrl?: string;
  readonly help: boolean;
  readonly model?: string;
  readonly root: string;
}

const MODEL_DRIVER_ID = "openai-compatible";

const HELP = `Jixu — Agents that continue.

Usage:
  jixu [--api-format responses|chat-completions] [--base-url URL] [--model MODEL] [--root PATH]

Environment:
  JIXU_API_FORMAT        Prefill responses or chat-completions
  JIXU_BASE_URL          Prefill the compatible API root
  JIXU_MODEL             Prefill the model ID
  JIXU_API_KEY           Prefill credentials when auth.json has none
  JIXU_HOME              Override the global config directory

Examples:
  pnpm dev
  pnpm dev -- --api-format responses --base-url https://api.example.com/v1
`;

function apiFormat(value: string | undefined): JixuApiFormat | undefined {
  if (value === undefined) return undefined;
  if (value === "responses" || value === "chat-completions") return value;
  throw new TypeError(
    `Unsupported API format ${value}; use responses or chat-completions`,
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
  let selectedApiFormat = apiFormat(environment.JIXU_API_FORMAT);
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
    if (argument === "--api-format") {
      selectedApiFormat = apiFormat(valueAfter(args, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith("--api-format=")) {
      selectedApiFormat = apiFormat(argument.slice("--api-format=".length));
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
    ...(selectedApiFormat === undefined
      ? {}
      : { apiFormat: selectedApiFormat }),
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
  const apiFormat = options.apiFormat ?? stored.apiFormat ?? "responses";
  const apiKey = stored.apiKey ?? process.env.JIXU_API_KEY;
  const baseUrl = options.baseUrl ?? stored.baseUrl;
  const model = options.model ?? stored.model;
  const autoConnect =
    stored.apiFormat !== undefined &&
    stored.apiKey !== undefined &&
    stored.baseUrl !== undefined &&
    stored.model !== undefined &&
    options.apiFormat === undefined &&
    options.baseUrl === undefined &&
    options.model === undefined;
  const tools = createNodeTools({ root: options.root });

  let quit!: () => void;
  const done = new Promise<void>((resolveDone) => {
    quit = resolveDone;
  });
  const connect = async (
    config: JixuConnectionConfig,
    controls: { readonly onConfigure: () => void; readonly onQuit: () => void },
  ) => {
    await configStore.saveConnection(config);
    const driver = createOpenAICompatibleModelDriver({
      apiFormat: config.apiFormat,
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      provider: MODEL_DRIVER_ID,
    });
    const runtime = createRuntime({
      modelDrivers: createLLMAdapter({ [MODEL_DRIVER_ID]: driver }),
      store: new JsonlEventStore(resolve(options.root, ".jixu")),
    });
    const agent = defineAgent({
      instructions: [
        "You are Jixu, a general-purpose agent working with the user in a local workspace.",
        "Use read, write, edit, and bash when they materially help complete the request.",
        "File tools are restricted to the workspace root.",
        "bash is an unsandboxed local shell with the Jixu process permissions.",
        "Do not perform destructive or irreversible actions unless the user explicitly asks.",
        "Be concise about progress and concrete about the completed outcome.",
      ].join("\n"),
      model: { model: config.model, provider: MODEL_DRIVER_ID },
      tools: tools.all,
    });
    return createJixuSession({ agent, ...controls, runtime });
  };
  const renderer = await createCliRenderer({
    backgroundColor: jixuTheme.background,
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
          apiFormat,
          autoConnect,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(model === undefined ? {} : { model }),
        }}
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
