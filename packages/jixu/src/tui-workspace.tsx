import type { InputRenderable, SubmitEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { formatSlashCommandHelp, JIXU_SLASH_COMMANDS } from "./commands.ts";
import type { JixuConnectionConfig } from "./config.ts";
import type { ThreadController } from "./thread-controller.ts";
import { SlashCommandMenu, ThreadPicker } from "./slash-command-menu.tsx";
import { jixuTheme } from "./theme.ts";
import { ActivityRail, Transcript } from "./tui-transcript.tsx";
import type { ThreadControllerSnapshot } from "./tui-model.ts";

export interface JixuActiveConnection {
  readonly config: JixuConnectionConfig;
  readonly controller: ThreadController;
}

interface AgentWorkspaceProps {
  readonly active: JixuActiveConnection | null;
  readonly connectionError: string | null;
  readonly onConfigure: () => void;
  readonly onQuit: () => void;
}

const inactiveSnapshot: ThreadControllerSnapshot = Object.freeze({
  activity: Object.freeze([]),
  busy: false,
  currentThreadId: null,
  inspection: null,
  streamingText: "",
  threadPickerOpen: false,
  threads: Object.freeze([]),
  threadStatus: "none",
  transcript: Object.freeze([]),
});

const getInactiveSnapshot = (): ThreadControllerSnapshot => inactiveSnapshot;
const subscribeInactive = (): (() => void) => () => undefined;

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return "…";
  return `${value.slice(0, maximum - 1)}…`;
}

function endpointName(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function AgentWorkspace({
  active,
  connectionError,
  onConfigure,
  onQuit,
}: AgentWorkspaceProps) {
  const controllerSnapshot = useSyncExternalStore(
    active?.controller.subscribe ?? subscribeInactive,
    active?.controller.getSnapshot ?? getInactiveSnapshot,
    active?.controller.getSnapshot ?? getInactiveSnapshot,
  );
  const { height, width } = useTerminalDimensions();
  const outerPadding = 1;
  const availableWidth = Math.max(32, width - outerPadding * 2);
  const showActivityRail = availableWidth >= 106;
  const workspaceWidth = availableWidth;
  const columnGap = showActivityRail ? 1 : 0;
  const activityWidth = showActivityRail
    ? Math.max(20, Math.floor((workspaceWidth - columnGap) / 5))
    : 0;
  const chatWidth = workspaceWidth - columnGap - activityWidth;
  const headerHeight = 1;
  const footerHeight = 2;
  const sectionGapRows = 2;
  const workHeight = Math.max(
    12,
    height - headerHeight - footerHeight - sectionGapRows,
  );
  const compact = chatWidth < 84;
  const input = useRef<InputRenderable>(null);
  const [draft, setDraft] = useState("");
  const [localInspection, setLocalInspection] = useState<
    ThreadControllerSnapshot["inspection"]
  >(
    connectionError === null
      ? null
      : Object.freeze({ content: connectionError, title: "Connection failed" }),
  );
  const configured = active !== null;
  const snapshot = configured
    ? controllerSnapshot
    : { ...inactiveSnapshot, inspection: localInspection };

  useEffect(() => {
    if (active !== null || connectionError === null) return;
    setLocalInspection(
      Object.freeze({ content: connectionError, title: "Connection failed" }),
    );
  }, [active, connectionError]);

  const submitValue = useCallback(
    (value: string) => {
      const cleanValue = value.trim();
      if (cleanValue.length === 0) return;

      if (active !== null) {
        void active.controller.submit(cleanValue);
        return;
      }

      const [commandName] = cleanValue.split(/\s+/, 1);
      if (commandName === "/config") {
        setLocalInspection(null);
        onConfigure();
        return;
      }
      if (commandName === "/quit") {
        onQuit();
        return;
      }
      if (commandName === "/help") {
        setLocalInspection(
          Object.freeze({
            content: formatSlashCommandHelp(),
            title: "Commands",
          }),
        );
        return;
      }
      if (cleanValue.startsWith("/")) {
        const supported = JIXU_SLASH_COMMANDS.some(
          (command) => command.name === commandName,
        );
        setLocalInspection(
          Object.freeze({
            content: supported
              ? `Configure a model with /config before using ${commandName}.`
              : `Unknown command ${commandName}. Use /help.`,
            title: supported ? "Configuration required" : "Unknown command",
          }),
        );
        return;
      }

      setLocalInspection(
        Object.freeze({
          content: "Use /config to connect a model, then submit this prompt again.",
          title: "No model configured",
        }),
      );
    },
    [active, onConfigure, onQuit],
  );

  const setComposerValue = useCallback((value: string) => {
    if (input.current !== null) input.current.value = value;
    setDraft(value);
    input.current?.focus();
  }, []);

  const clearComposer = useCallback(() => setComposerValue(""), [setComposerValue]);

  const submit = (submitted: string | SubmitEvent) => {
    const value =
      typeof submitted === "string"
        ? submitted
        : (input.current?.value ?? draft);
    if (value.trim().length === 0) return;
    clearComposer();
    submitValue(value);
  };

  const invokeCommand = useCallback(
    (command: string) => {
      clearComposer();
      submitValue(command);
    },
    [clearComposer, submitValue],
  );

  const statusTone = !configured
    ? jixuTheme.warning
    : snapshot.busy
      ? jixuTheme.warning
      : snapshot.threadStatus === "waiting" || snapshot.threadStatus === "paused"
        ? jixuTheme.warning
        : jixuTheme.success;
  const status = !configured
    ? "not configured"
    : snapshot.busy
      ? "working"
      : snapshot.threadStatus === "none"
        ? "ready"
        : snapshot.threadStatus;
  const endpointContext = configured
    ? truncate(
        compact
          ? active.config.model
          : `${endpointName(active.config.baseUrl)} · ${active.config.model}`,
        compact
          ? Math.max(16, workspaceWidth - 30)
          : Math.max(24, Math.floor(workspaceWidth / 2)),
      )
    : null;
  const formatContext = !configured
    ? null
    : active.config.apiFormat === "responses"
      ? "Responses"
      : "Chat Completions";

  return (
    <box
      style={{
        alignItems: "center",
        backgroundColor: jixuTheme.background,
        flexDirection: "column",
        gap: 1,
        height: "100%",
        paddingLeft: outerPadding,
        paddingRight: outerPadding,
        width: "100%",
      }}
    >
      <box style={{ flexDirection: "row", height: 1, width: workspaceWidth }}>
        <text fg={jixuTheme.brand}>
          <strong>JIXU</strong>
        </text>
        {compact ? null : (
          <text fg={jixuTheme.secondary}> · Agents that continue.</text>
        )}
        <box style={{ flexGrow: 1 }} />
        <text fg={statusTone}>● {status}</text>
      </box>

      <box
        style={{
          columnGap,
          flexDirection: "row",
          height: workHeight,
          width: workspaceWidth,
        }}
      >
        <box
          style={{
            flexDirection: "column",
            gap: 1,
            height: workHeight,
            width: chatWidth,
          }}
        >
          <box
            style={{
              flexBasis: 0,
              flexGrow: 1,
              flexShrink: 1,
              minHeight: 2,
              overflow: "hidden",
              width: chatWidth,
            }}
          >
            <Transcript
              configured={configured}
              emptyTop={Math.max(0, Math.floor((workHeight - 15) / 2))}
              includeActivity={!showActivityRail}
              snapshot={snapshot}
            />
          </box>

          <SlashCommandMenu
            draft={draft}
            input={input}
            onInsert={setComposerValue}
            onInvoke={invokeCommand}
          />

          <ThreadPicker
            input={input}
            onClose={() => active?.controller.closeThreadPicker()}
            onSelect={(threadId) => {
              void active?.controller.selectThread(threadId);
            }}
            open={snapshot.threadPickerOpen}
            threads={snapshot.threads}
          />

          <box
            backgroundColor={jixuTheme.surface}
            border={["left"]}
            borderColor={jixuTheme.brand}
            style={{
              flexDirection: "column",
              flexShrink: 0,
              height: 3,
              paddingLeft: 1,
              paddingRight: 1,
              paddingTop: 1,
              width: chatWidth,
            }}
          >
            <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
              <text fg={jixuTheme.brand}>
                <strong>›</strong>
              </text>
              <text> </text>
              <input
                ref={input}
                backgroundColor={jixuTheme.surface}
                cursorColor={jixuTheme.brand}
                focused
                focusedBackgroundColor={jixuTheme.surface}
                focusedTextColor={jixuTheme.text}
                onInput={setDraft}
                onSubmit={submit}
                placeholder={
                  !configured
                    ? "Use /config to connect a model…"
                    : snapshot.busy
                      ? "Queue a follow-up…"
                      : "Ask Jixu anything…"
                }
                placeholderColor={jixuTheme.secondary}
                style={{ flexGrow: 1 }}
                textColor={jixuTheme.text}
                value={draft}
              />
            </box>
          </box>
        </box>

        {showActivityRail ? (
          <ActivityRail
            height={workHeight}
            snapshot={snapshot}
            width={activityWidth}
          />
        ) : null}
      </box>

      <box
        style={{
          flexDirection: "column",
          height: footerHeight,
          width: workspaceWidth,
        }}
      >
        <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
          {configured ? (
            <text fg={jixuTheme.brand}>{endpointContext}</text>
          ) : (
            <text fg={jixuTheme.secondary}>
              Model not configured · <span fg={jixuTheme.brand}>use /config</span>
            </text>
          )}
          {compact || formatContext === null ? null : (
            <text fg={jixuTheme.secondary}> · {formatContext}</text>
          )}
        </box>
        <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
          <text fg={jixuTheme.secondary}>
            Local shell · <span fg={jixuTheme.warning}>unsandboxed</span>
          </text>
          <box style={{ flexGrow: 1 }} />
          {compact ? null : <text fg={jixuTheme.secondary}>ctrl+c quit</text>}
        </box>
      </box>
    </box>
  );
}
