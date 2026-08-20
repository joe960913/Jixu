import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ExecutableTool } from "@jixu/core";

import {
  DEFAULT_JIXU_TOOL_SETTINGS,
  type JixuConnectionConfig,
} from "./config.ts";
import type { ThreadController } from "./thread-controller.ts";
import {
  Booting,
  Setup,
  type JixuInitialConfiguration,
} from "./tui-setup.tsx";
import {
  AgentWorkspace,
  type JixuActiveConnection,
} from "./tui-workspace.tsx";

export type { JixuInitialConfiguration } from "./tui-setup.tsx";

export interface JixuAppControls {
  readonly onConfigure: () => void;
  readonly onQuit: () => void;
}

export interface JixuAppProps {
  readonly connect: (
    config: JixuConnectionConfig,
    controls: JixuAppControls,
  ) => ThreadController | Promise<ThreadController>;
  readonly initial?: JixuInitialConfiguration;
  readonly motion?: boolean;
  readonly onQuit: () => void;
  readonly toolCatalogue?: readonly ExecutableTool[];
  readonly workspace: string;
}

function completeInitial(
  initial: JixuInitialConfiguration | undefined,
): JixuConnectionConfig | null {
  const api = initial?.api;
  const apiKey = initial?.apiKey;
  const baseUrl = initial?.baseUrl;
  const model = initial?.model;
  const tools = initial?.tools ?? DEFAULT_JIXU_TOOL_SETTINGS;

  return api === undefined ||
    apiKey === undefined ||
    baseUrl === undefined ||
    model === undefined
    ? null
    : { api, apiKey, baseUrl, model, tools };
}

export function JixuApp({
  connect,
  initial,
  motion = true,
  onQuit,
  toolCatalogue = [],
  workspace,
}: JixuAppProps) {
  const [active, setActive] = useState<JixuActiveConnection | null>(null);
  const [configuration, setConfiguration] =
    useState<JixuInitialConfiguration | undefined>(initial);
  const [booting, setBooting] = useState(initial?.autoConnect === true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [view, setView] = useState<"config" | "workspace">("workspace");
  const attempted = useRef(false);

  const activate = useCallback(
    async (config: JixuConnectionConfig) => {
      const controller = await connect(config, {
        onConfigure: () => {
          setBooting(false);
          setView("config");
        },
        onQuit,
      });

      setConfiguration({
        api: config.api,
        apiKey: config.apiKey,
        autoConnect: true,
        baseUrl: config.baseUrl,
        model: config.model,
        tools: config.tools,
      });
      setActive({ config, controller });
      setBooting(false);
      setConnectionError(null);
      setView("workspace");
    },
    [connect, onQuit],
  );

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const saved = completeInitial(initial);
    if (initial?.autoConnect !== true || saved === null) {
      setBooting(false);
      return;
    }

    void activate(saved).catch((error) => {
      setBooting(false);
      setConnectionError(
        error instanceof Error
          ? error.message
          : "Could not load saved configuration.",
      );
    });
  }, [activate, initial]);

  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "c") return;
    key.preventDefault();
    onQuit();
  });

  if (booting) return <Booting workspace={workspace} />;

  if (view === "config") {
    return (
      <Setup
        initial={configuration}
        initialError={connectionError}
        onBack={() => setView("workspace")}
        onConnect={activate}
        toolCatalogue={toolCatalogue}
        workspace={workspace}
      />
    );
  }

  return (
    <AgentWorkspace
      active={active}
      connectionError={connectionError}
      motion={motion}
      onConfigure={() => {
        setView("config");
      }}
      onQuit={onQuit}
      workspace={workspace}
    />
  );
}
