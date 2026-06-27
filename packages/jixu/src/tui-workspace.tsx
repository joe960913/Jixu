import type { TextareaOptions, TextareaRenderable } from "@opentui/core";
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
import {
  ExecutionDock,
  ToolOperationTrail,
  WorkStatusLine,
} from "./tui-dock.tsx";
import { ActivityRail, Transcript } from "./tui-transcript.tsx";
import type { ThreadControllerSnapshot } from "./tui-model.ts";

export interface JixuActiveConnection {
  readonly config: JixuConnectionConfig;
  readonly controller: ThreadController;
}

interface AgentWorkspaceProps {
  readonly active: JixuActiveConnection | null;
  readonly connectionError: string | null;
  readonly motion: boolean;
  readonly onConfigure: () => void;
  readonly onQuit: () => void;
}

const inactiveSnapshot: ThreadControllerSnapshot = Object.freeze({
  activePlan: null,
  activity: Object.freeze([]),
  busy: false,
  currentThreadId: null,
  inspection: null,
  metrics: null,
  streamingText: "",
  threadPickerOpen: false,
  threads: Object.freeze([]),
  threadStatus: "none",
  toolOperations: Object.freeze([]),
  transcript: Object.freeze([]),
  workStatus: null,
});

const getInactiveSnapshot = (): ThreadControllerSnapshot => inactiveSnapshot;
const subscribeInactive = (): (() => void) => () => undefined;
const COMPOSER_MIN_HEIGHT = 3;
const COMPOSER_MAX_HEIGHT = 8;
const COMPOSER_EDITOR_MAX_HEIGHT = COMPOSER_MAX_HEIGHT - 2;
const COMPOSER_KEY_BINDINGS: NonNullable<TextareaOptions["keyBindings"]> = [
  { action: "submit", name: "return" },
  { action: "newline", name: "return", shift: true },
  { action: "submit", name: "kpenter" },
  { action: "newline", name: "kpenter", shift: true },
  { action: "submit", name: "linefeed" },
  { action: "newline", name: "linefeed", shift: true },
];

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return "…";
  return `${value.slice(0, maximum - 1)}…`;
}

function formatUsd(usdNanos: number): string {
  const [whole = "0", fraction = ""] = (usdNanos / 1_000_000_000)
    .toFixed(9)
    .split(".");
  return `${whole}.${fraction.replace(/0+$/u, "").padEnd(4, "0")}`;
}

function costContext(snapshot: ThreadControllerSnapshot): {
  readonly label: string;
  readonly partial: boolean;
} {
  const cost = snapshot.metrics?.cost;
  if (cost === undefined || (cost.pricedOutcomes === 0 && cost.unpricedOutcomes > 0)) {
    return { label: "USD —", partial: true };
  }
  return {
    label: `USD $${formatUsd(cost.usdNanos)}${cost.unpricedOutcomes > 0 ? "+" : ""}`,
    partial: cost.unpricedOutcomes > 0,
  };
}

function ComposerStatus({
  compact,
  configured,
  modelContext,
  motion,
  snapshot,
  threadCost,
  width,
}: {
  readonly compact: boolean;
  readonly configured: boolean;
  readonly modelContext: string | null;
  readonly motion: boolean;
  readonly snapshot: ThreadControllerSnapshot;
  readonly threadCost: ReturnType<typeof costContext>;
  readonly width: number;
}) {
  const working = snapshot.busy && snapshot.workStatus !== null;
  const showToolTrail = working && snapshot.toolOperations.length > 0;
  return (
    <box style={{ flexDirection: "column", height: 2, width: "100%" }}>
      <box
        style={{
          flexDirection: "row",
          height: 1,
          overflow: "hidden",
          width: "100%",
        }}
      >
        {working ? (
          <WorkStatusLine motion={motion} status={snapshot.workStatus} />
        ) : configured ? (
          <text fg={jixuTheme.brand}>{modelContext}</text>
        ) : (
          <text fg={jixuTheme.secondary}>
            Model not configured · <span fg={jixuTheme.brand}>use /config</span>
          </text>
        )}
        {working ? <box style={{ flexGrow: 1 }} /> : null}
        {working && !compact && modelContext !== null ? (
          <text fg={jixuTheme.secondary}>{modelContext}</text>
        ) : null}
      </box>
      <box
        style={{
          flexDirection: "row",
          height: 1,
          overflow: "hidden",
          width: "100%",
        }}
      >
        {showToolTrail ? (
          <ToolOperationTrail
            toolOperations={snapshot.toolOperations}
            width={Math.max(20, width - 24)}
          />
        ) : (
          <text fg={jixuTheme.secondary}>
            Local shell · <span fg={jixuTheme.warning}>unsandboxed</span>
          </text>
        )}
        <box style={{ flexGrow: 1 }} />
        <text fg={threadCost.partial ? jixuTheme.warning : jixuTheme.success}>
          {threadCost.label}
        </text>
        {compact ? null : (
          <text fg={jixuTheme.secondary}> · ctrl+c quit</text>
        )}
      </box>
    </box>
  );
}

export function AgentWorkspace({
  active,
  connectionError,
  motion,
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
  const sectionGapRows = 1;
  const workspaceHeight = Math.max(15, height - headerHeight - sectionGapRows);
  const chatHeight = workspaceHeight - footerHeight - 1;
  const compact = chatWidth < 84;
  const composer = useRef<TextareaRenderable>(null);
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
    composer.current?.setText(value);
    composer.current?.gotoBufferEnd();
    setDraft(value);
    composer.current?.focus();
  }, []);

  const clearComposer = useCallback(() => setComposerValue(""), [setComposerValue]);

  const submit = () => {
    const value = composer.current?.plainText ?? draft;
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
  const modelContext = configured
    ? truncate(
        active.config.model,
        compact
          ? Math.max(16, chatWidth - 30)
          : Math.max(24, Math.floor(chatWidth / 2)),
      )
    : null;
  const threadCost = costContext(snapshot);

  return (
    <box
      style={{
        alignItems: "center",
        backgroundColor: jixuTheme.canvas,
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
          height: workspaceHeight,
          width: workspaceWidth,
        }}
      >
        <box
          style={{
            flexDirection: "column",
            gap: 1,
            height: workspaceHeight,
            width: chatWidth,
          }}
        >
          <box
            style={{
              flexDirection: "column",
              gap: 1,
              height: chatHeight,
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
                emptyTop={Math.max(0, Math.floor((chatHeight - 15) / 2))}
                includeActivity={!showActivityRail}
                snapshot={snapshot}
              />
            </box>

            <ExecutionDock snapshot={snapshot} width={chatWidth} />

            <SlashCommandMenu
              draft={draft}
              input={composer}
              onInsert={setComposerValue}
              onInvoke={invokeCommand}
            />

            <ThreadPicker
              input={composer}
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
              id="composer"
              style={{
                alignItems: "flex-start",
                flexDirection: "row",
                flexShrink: 0,
                maxHeight: COMPOSER_MAX_HEIGHT,
                minHeight: COMPOSER_MIN_HEIGHT,
                paddingBottom: 1,
                paddingLeft: 1,
                paddingRight: 1,
                paddingTop: 1,
                width: chatWidth,
              }}
            >
              <text fg={jixuTheme.brand}>
                <strong>›</strong>
              </text>
              <text> </text>
              <textarea
                ref={composer}
                backgroundColor={jixuTheme.surface}
                cursorColor={jixuTheme.brand}
                focused
                focusedBackgroundColor={jixuTheme.surface}
                focusedTextColor={jixuTheme.text}
                id="composer-editor"
                keyBindings={COMPOSER_KEY_BINDINGS}
                onContentChange={() => {
                  setDraft(composer.current?.plainText ?? "");
                }}
                onSubmit={submit}
                placeholder={
                  !configured
                    ? "Use /config to connect a model…"
                    : snapshot.busy
                      ? "Queue a follow-up…"
                      : "Ask Jixu anything…"
                }
                placeholderColor={jixuTheme.secondary}
                style={{
                  flexGrow: 1,
                  height: "auto",
                  maxHeight: COMPOSER_EDITOR_MAX_HEIGHT,
                  minHeight: 1,
                }}
                textColor={jixuTheme.text}
                wrapMode="word"
              />
            </box>
          </box>

          <ComposerStatus
            compact={compact}
            configured={configured}
            modelContext={modelContext}
            motion={motion}
            snapshot={snapshot}
            threadCost={threadCost}
            width={chatWidth}
          />
        </box>

        {showActivityRail ? (
          <ActivityRail
            height={workspaceHeight}
            snapshot={snapshot}
            width={activityWidth}
          />
        ) : null}
      </box>
    </box>
  );
}
