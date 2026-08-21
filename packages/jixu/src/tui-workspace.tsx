import type {
  ClipboardService,
  TextareaOptions,
  TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ThreadInput } from "jixu-core";

import { formatSlashCommandHelp, JIXU_SLASH_COMMANDS } from "./commands.ts";
import type { JixuConnectionConfig } from "./config.ts";
import type { ThreadController } from "./thread-controller.ts";
import { SlashCommandMenu, ThreadPicker } from "./slash-command-menu.tsx";
import { jixuTheme } from "./theme.ts";
import {
  ATTENTION_STRIP_HEIGHT,
  AttentionRail,
  AttentionStrip,
} from "./tui-attention-rail.tsx";
import { createAttentionModel } from "./tui-attention.ts";
import {
  JIXU_CREATION_MARK_DIMENSIONS,
  type JixuCreationMarkVariant,
} from "./tui-creation-mark.tsx";
import { ExecutionDock } from "./tui-dock.tsx";
import { ToolApprovalPrompt } from "./tui-tool-approval.tsx";
import { Transcript } from "./tui-transcript.tsx";
import {
  buildThreadInputFromComposer,
  pendingNormalizedImageError,
  pendingPastedImageError,
  pastedImageToken,
  readJixuClipboard,
} from "./tui-clipboard.ts";
import type {
  PasteFallback,
  PendingPastedImage,
} from "./tui-clipboard.ts";
import {
  normalizePastedImage,
  PastedImageNormalizationError,
} from "./tui-pasted-image.ts";
import type {
  ThreadControllerSnapshot,
  TranscriptMessageEntry,
} from "./tui-model.ts";

export interface JixuActiveConnection {
  readonly config: JixuConnectionConfig;
  readonly controller: ThreadController;
}

interface AgentWorkspaceProps {
  readonly active: JixuActiveConnection | null;
  readonly clipboard: Pick<ClipboardService, "read"> | undefined;
  readonly connectionError: string | null;
  readonly motion: boolean;
  readonly onConfigure: () => void;
  readonly onQuit: () => void;
  readonly workspace: string;
}

interface ToolDisclosureState {
  readonly expandedEffectIds: ReadonlySet<string>;
  readonly showAllOperations: boolean;
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
  toolApproval: null,
  toolLiveOutput: Object.freeze({}),
  toolOperations: Object.freeze([]),
  transcript: Object.freeze([]),
  workStatus: null,
});

const getInactiveSnapshot = (): ThreadControllerSnapshot => inactiveSnapshot;
const subscribeInactive = (): (() => void) => () => undefined;
// Border, vertical padding, and one editor row make the rendered minimum five.
const COMPOSER_MIN_HEIGHT = 5;
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
const EMPTY_TOOL_DISCLOSURE: ToolDisclosureState = Object.freeze({
  expandedEffectIds: new Set<string>(),
  showAllOperations: false,
});

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
  enabledTools,
  fileScope,
  modelContext,
  threadCost,
}: {
  readonly compact: boolean;
  readonly configured: boolean;
  readonly enabledTools: readonly string[];
  readonly fileScope: "process" | "workspace";
  readonly modelContext: string | null;
  readonly threadCost: ReturnType<typeof costContext>;
}) {
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
        {configured ? (
          <text fg={jixuTheme.brand}>
            <strong>MODEL</strong>
            <span fg={jixuTheme.text}>  {modelContext}</span>
          </text>
        ) : (
          <text fg={jixuTheme.secondary}>
            Model not configured · <span fg={jixuTheme.brand}>use /config</span>
          </text>
        )}
      </box>
      <box
        style={{
          flexDirection: "row",
          height: 1,
          overflow: "hidden",
          width: "100%",
        }}
      >
        <text fg={jixuTheme.secondary}>
          <strong>TOOLS</strong>
          <span fg={jixuTheme.text}>  {enabledTools.join(" ") || "none"}</span>
          <span fg={jixuTheme.secondary}>  FILES </span>
          <span fg={fileScope === "workspace" ? jixuTheme.success : jixuTheme.warning}>
            {fileScope}
          </span>
          {enabledTools.includes("bash") ? (
            <span fg={jixuTheme.warning}>  BASH process</span>
          ) : null}
        </text>
        <box style={{ flexGrow: 1 }} />
        <text fg={threadCost.partial ? jixuTheme.warning : jixuTheme.success}>
          {threadCost.label}
        </text>
        {compact ? null : (
          <text fg={jixuTheme.secondary}>  ctrl+c quit</text>
        )}
      </box>
    </box>
  );
}

export function AgentWorkspace({
  active,
  clipboard,
  connectionError,
  motion,
  onConfigure,
  onQuit,
  workspace,
}: AgentWorkspaceProps) {
  const controllerSnapshot = useSyncExternalStore(
    active?.controller.subscribe ?? subscribeInactive,
    active?.controller.getSnapshot ?? getInactiveSnapshot,
    active?.controller.getSnapshot ?? getInactiveSnapshot,
  );
  const { height, width } = useTerminalDimensions();
  const outerPadding = 1;
  const availableWidth = Math.max(32, width - outerPadding * 2);
  const showAttentionRail = availableWidth >= 110;
  const workspaceWidth = availableWidth;
  const columnGap = showAttentionRail ? 1 : 0;
  const attentionWidth = showAttentionRail
    ? Math.min(42, Math.max(30, Math.floor(workspaceWidth * 0.24)))
    : 0;
  const chatWidth = workspaceWidth - columnGap - attentionWidth;
  const headerHeight = 2;
  const footerHeight = 2;
  const workspaceHeight = Math.max(15, height - headerHeight);
  const chatHeight = workspaceHeight - footerHeight;
  const compact = !showAttentionRail || chatWidth < 84;
  const emptyStateViewportHeight = Math.max(
    0,
    chatHeight -
      COMPOSER_MIN_HEIGHT -
      1 -
      (showAttentionRail ? 0 : ATTENTION_STRIP_HEIGHT),
  );
  const creationMarkFits = (variant: JixuCreationMarkVariant): boolean => {
    const dimensions = JIXU_CREATION_MARK_DIMENSIONS[variant];
    return (
      chatWidth >= dimensions.columns + 3 &&
      emptyStateViewportHeight >= dimensions.rows + 6
    );
  };
  const creationMarkVariant: JixuCreationMarkVariant | null = creationMarkFits(
    "compact",
  )
    ? "compact"
    : creationMarkFits("small")
      ? "small"
      : null;
  const emptyStateHeight =
    creationMarkVariant === null
      ? 5
      : JIXU_CREATION_MARK_DIMENSIONS[creationMarkVariant].rows + 6;
  const emptyStateTop = Math.max(
    0,
    Math.floor((emptyStateViewportHeight - emptyStateHeight) / 2),
  );
  const composer = useRef<TextareaRenderable>(null);
  const nextPastedImageNumber = useRef(1);
  const pastedImages = useRef<readonly PendingPastedImage[]>([]);
  const pasteTail = useRef(Promise.resolve());
  const [draft, setDraft] = useState("");
  const [composerInspection, setComposerInspection] = useState<
    ThreadControllerSnapshot["inspection"]
  >(null);
  const [transcriptRevealRequest, setTranscriptRevealRequest] = useState(0);
  const [toolDisclosureByThread, setToolDisclosureByThread] = useState<
    ReadonlyMap<string, ToolDisclosureState>
  >(() => new Map());
  const [localInspection, setLocalInspection] = useState<
    ThreadControllerSnapshot["inspection"]
  >(
    connectionError === null
      ? null
      : Object.freeze({ content: connectionError, title: "Connection failed" }),
  );
  const configured = active !== null;
  const snapshot = configured
    ? composerInspection === null
      ? controllerSnapshot
      : { ...controllerSnapshot, inspection: composerInspection }
    : { ...inactiveSnapshot, inspection: localInspection };
  const currentToolDisclosure = snapshot.currentThreadId === null
    ? EMPTY_TOOL_DISCLOSURE
    : toolDisclosureByThread.get(snapshot.currentThreadId) ?? EMPTY_TOOL_DISCLOSURE;
  const toolEffectIds = snapshot.transcript.flatMap((entry) =>
    entry.kind === "tool-receipts"
      ? entry.operations.map((operation) => operation.effectId)
      : [],
  );
  const toolEffectIdKey = toolEffectIds.join("\u0000");
  const allToolDetailsExpanded =
    toolEffectIds.length > 0 &&
    toolEffectIds.every((effectId) =>
      currentToolDisclosure.expandedEffectIds.has(effectId),
    );

  const toggleToolDetail = useCallback(
    (effectId: string) => {
      const threadId = snapshot.currentThreadId;
      if (threadId === null) return;
      setToolDisclosureByThread((current) => {
        const existing = current.get(threadId) ?? EMPTY_TOOL_DISCLOSURE;
        const expandedEffectIds = new Set(existing.expandedEffectIds);
        if (expandedEffectIds.has(effectId)) {
          expandedEffectIds.delete(effectId);
        } else {
          expandedEffectIds.add(effectId);
        }
        const next = new Map(current);
        next.set(threadId, {
          expandedEffectIds,
          showAllOperations: existing.showAllOperations,
        });
        return next;
      });
    },
    [snapshot.currentThreadId],
  );

  useKeyboard((key) => {
    if (
      !key.ctrl ||
      key.name !== "o" ||
      !snapshot.transcript.some((entry) => entry.kind === "tool-receipts")
    ) {
      return;
    }
    key.preventDefault();
    const threadId = snapshot.currentThreadId;
    if (threadId === null) return;
    setToolDisclosureByThread((current) => {
      const next = new Map(current);
      next.set(
        threadId,
        allToolDetailsExpanded
          ? {
              expandedEffectIds: new Set<string>(),
              showAllOperations: false,
            }
          : {
              expandedEffectIds: new Set(toolEffectIds),
              showAllOperations: true,
            },
      );
      return next;
    });
  });

  const handleClipboardRead = useCallback(
    async (fallback?: PasteFallback) => {
      if (clipboard === undefined) return;
      const result = await readJixuClipboard(clipboard, fallback);
      if (result.kind === "unavailable") {
        if (fallback === undefined) {
          setComposerInspection({
            content:
              "The host clipboard did not expose supported image or text content.",
            title: "Clipboard unavailable",
          });
        }
        return;
      }
      if (result.kind === "text") {
        if (result.text.length > 0) {
          composer.current?.insertText(result.text);
          setDraft(composer.current?.plainText ?? result.text);
        }
        setComposerInspection(null);
        return;
      }

      const composerText = composer.current?.plainText ?? "";
      pastedImages.current = pastedImages.current.filter((image) =>
        composerText.includes(pastedImageToken(image)),
      );
      const error = pendingPastedImageError(pastedImages.current, result.bytes);
      if (error !== null) {
        setComposerInspection({ content: error, title: "Image paste rejected" });
        return;
      }
      let normalized;
      try {
        normalized = normalizePastedImage(result.bytes, result.mediaType);
      } catch (normalizationError) {
        setComposerInspection({
          content:
            normalizationError instanceof PastedImageNormalizationError
              ? normalizationError.message
              : "The pasted image could not be normalized to PNG.",
          title: "Image paste rejected",
        });
        return;
      }
      const normalizedError = pendingNormalizedImageError(
        pastedImages.current,
        normalized.bytes,
      );
      if (normalizedError !== null) {
        setComposerInspection({
          content: normalizedError,
          title: "Image paste rejected",
        });
        return;
      }
      const image: PendingPastedImage = {
        bytes: normalized.bytes,
        mediaType: normalized.mediaType,
        placeholder: `pasted image ${nextPastedImageNumber.current}`,
        sourceByteLength: normalized.sourceByteLength,
      };
      nextPastedImageNumber.current += 1;
      pastedImages.current = [...pastedImages.current, image];
      composer.current?.insertText(pastedImageToken(image));
      setDraft(composer.current?.plainText ?? pastedImageToken(image));
      setComposerInspection(null);
    },
    [clipboard],
  );

  const enqueueClipboardRead = useCallback(
    (fallback?: PasteFallback) => {
      pasteTail.current = pasteTail.current
        .then(() => handleClipboardRead(fallback))
        .catch(() => {
          setComposerInspection({
            content: "The host clipboard could not be read.",
            title: "Clipboard unavailable",
          });
        });
    },
    [handleClipboardRead],
  );

  usePaste((event) => {
    if (clipboard === undefined || composer.current?.focused !== true) return;
    event.preventDefault();
    event.stopPropagation();
    enqueueClipboardRead({
      bytes: Uint8Array.from(event.bytes),
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
    });
  });

  useKeyboard((key) => {
    if (
      clipboard === undefined ||
      composer.current?.focused !== true ||
      key.name !== "v" ||
      (key.ctrl !== true && key.super !== true) ||
      key.repeated === true
    ) {
      return;
    }
    key.preventDefault();
    key.stopPropagation();
    enqueueClipboardRead();
  });

  useEffect(() => {
    if (active !== null || connectionError === null) return;
    setLocalInspection(
      Object.freeze({ content: connectionError, title: "Connection failed" }),
    );
  }, [active, connectionError]);

  useEffect(() => {
    const threadId = snapshot.currentThreadId;
    if (threadId === null) return;
    const visibleEffectIds = new Set(toolEffectIds);
    setToolDisclosureByThread((current) => {
      const existing = current.get(threadId);
      if (existing === undefined) return current;
      const expandedEffectIds = new Set(
        [...existing.expandedEffectIds].filter((effectId) =>
          visibleEffectIds.has(effectId),
        ),
      );
      if (
        expandedEffectIds.size === existing.expandedEffectIds.size &&
        (visibleEffectIds.size > 0 || !existing.showAllOperations)
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(threadId, {
        expandedEffectIds,
        showAllOperations:
          visibleEffectIds.size > 0 && existing.showAllOperations,
      });
      return next;
    });
  }, [snapshot.currentThreadId, toolEffectIdKey]);

  const submitValue = useCallback(
    (value: ThreadInput) => {
      const cleanValue = typeof value === "string" ? value.trim() : value;
      if (typeof cleanValue === "string" && cleanValue.length === 0) return;

      if (active !== null) {
        if (
          typeof cleanValue !== "string" ||
          !cleanValue.startsWith("/")
        ) {
          setTranscriptRevealRequest((current) => current + 1);
        }
        void active.controller.submit(cleanValue);
        return;
      }

      if (typeof cleanValue !== "string") {
        setLocalInspection(
          Object.freeze({
            content: "Use /config to connect a model, then submit this prompt again.",
            title: "No model configured",
          }),
        );
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
    void pasteTail.current.then(() => {
      const value = composer.current?.plainText ?? draft;
      const input = buildThreadInputFromComposer(value, pastedImages.current);
      if (input === null) return;
      pastedImages.current = [];
      nextPastedImageNumber.current = 1;
      setComposerInspection(null);
      clearComposer();
      submitValue(input);
    });
  };

  const invokeCommand = useCallback(
    (command: string) => {
      pastedImages.current = [];
      nextPastedImageNumber.current = 1;
      setComposerInspection(null);
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
  const attention = createAttentionModel(snapshot, configured);
  const currentThread = snapshot.threads.find((thread) => thread.current);
  const firstUser = snapshot.transcript.find(
    (entry): entry is TranscriptMessageEntry =>
      entry.kind === "message" && entry.role === "user",
  );
  const workspaceLabel = workspace.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace;
  const pageTitle = currentThread?.title ?? firstUser?.content ?? "Jixu Workspace";
  return (
    <box
      style={{
        alignItems: "center",
        backgroundColor: jixuTheme.canvas,
        flexDirection: "column",
        height: "100%",
        paddingLeft: outerPadding,
        paddingRight: outerPadding,
        width: "100%",
      }}
    >
      <box style={{ flexDirection: "column", height: headerHeight, width: workspaceWidth }}>
        <box style={{ flexDirection: "row", height: 1, width: workspaceWidth }}>
          <text fg={jixuTheme.brand}>
            <strong>JIXU</strong>
          </text>
          {compact ? null : (
            <text fg={jixuTheme.secondary}>  Pick up where you left off.</text>
          )}
          <box style={{ flexGrow: 1 }} />
          {compact ? null : (
            <text fg={jixuTheme.brand}>
              {truncate(pageTitle, 30)}
              <span fg={jixuTheme.secondary}>  ~/{truncate(workspaceLabel, 18)}</span>
            </text>
          )}
          <box style={{ flexGrow: 1 }} />
          <text fg={statusTone}>{status.toUpperCase()}</text>
        </box>
        <text fg={jixuTheme.divider} selectable={false}>
          {"─".repeat(workspaceWidth)}
        </text>
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
                emptyTop={emptyStateTop}
                motion={motion}
                creationMarkVariant={creationMarkVariant}
                snapshot={snapshot}
                expandedToolEffectIds={currentToolDisclosure.expandedEffectIds}
                onToggleToolDetail={toggleToolDetail}
                revealLatestRequest={transcriptRevealRequest}
                showAllToolOperations={currentToolDisclosure.showAllOperations}
              />
            </box>

            <box
              style={{
                flexDirection: "column",
                flexShrink: 0,
                width: chatWidth,
              }}
            >
              <ToolApprovalPrompt
                controller={active?.controller ?? null}
                snapshot={snapshot}
                width={chatWidth}
              />

              <ExecutionDock snapshot={snapshot} width={chatWidth} />

              {showAttentionRail ? null : (
                <AttentionStrip model={attention} width={chatWidth} />
              )}

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
                border={["top", "bottom", "left", "right"]}
                borderColor={jixuTheme.divider}
                id="composer"
                style={{
                  alignItems: "flex-start",
                  columnGap: 1,
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
                <box
                  backgroundColor={jixuTheme.secondary}
                  style={{ height: "100%", width: 1 }}
                />
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
                      : snapshot.toolApproval !== null
                        ? "Use /approve, /deny, or the approval buttons…"
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
          </box>

          <ComposerStatus
            compact={compact}
            configured={configured}
            enabledTools={active?.config.tools.enabled ?? []}
            fileScope={active?.config.tools.fileScope ?? "workspace"}
            modelContext={modelContext}
            threadCost={threadCost}
          />
        </box>

        {showAttentionRail ? (
          <AttentionRail
            height={workspaceHeight}
            model={attention}
            width={attentionWidth}
          />
        ) : null}
      </box>
    </box>
  );
}
