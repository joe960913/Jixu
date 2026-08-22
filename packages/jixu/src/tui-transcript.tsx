import {
  MouseButton,
  type MouseEvent as OpenTUIMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useMemo, useRef } from "react";
import type {
  JixuTone,
  ThreadControllerSnapshot,
  TranscriptMessageEntry,
  ToolLiveOutput,
  ToolOperation,
  WorkStatus,
} from "./tui-model.ts";
import { isThinkingLabel } from "./tui-model.ts";
import { jixuTheme } from "./theme.ts";
import {
  JixuCreationMark,
  type JixuCreationMarkVariant,
} from "./tui-creation-mark.tsx";
import { iconForTool, JixuIcon } from "./tui-icons.tsx";
import { createJixuMarkdownNodeRenderer } from "./tui-markdown.ts";
import { JixuWordmark, ThinkingMotionText } from "./tui-motion.tsx";
import { jixuMarkdownSyntaxStyle } from "./tui-syntax-theme.ts";

function toneColor(tone: JixuTone): string {
  return jixuTheme[tone];
}

const markdownTableOptions = {
  columnFitter: "balanced",
  cellPaddingX: 1,
  style: "columns",
  widthMode: "content",
  wrapMode: "word",
} as const;

const MESSAGE_ROLE_WIDTH = 6;
export const TOOL_DETAIL_MAX_HEIGHT = 8;

function AssistantMarkdown({
  content,
  streaming = false,
}: {
  readonly content: string;
  readonly streaming?: boolean;
}) {
  const renderer = useRenderer();
  const renderNode = useMemo(
    () => createJixuMarkdownNodeRenderer(renderer, streaming),
    [renderer, streaming],
  );
  return (
    <markdown
      conceal
      content={content}
      fg={jixuTheme.text}
      internalBlockMode="top-level"
      renderNode={renderNode}
      style={{ width: "100%" }}
      streaming={streaming}
      syntaxStyle={jixuMarkdownSyntaxStyle}
      tableOptions={markdownTableOptions}
    />
  );
}

function onPrimaryMouseDown(action: () => void) {
  return (event: OpenTUIMouseEvent) => {
    if (event.button !== MouseButton.LEFT) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };
}

function TranscriptItem({
  entry,
  showAgentRole,
}: {
  readonly entry: TranscriptMessageEntry;
  readonly showAgentRole: boolean;
}) {
  if (entry.role === "user") {
    return (
      <box
        style={{
          flexDirection: "row",
          marginBottom: 1,
          paddingLeft: 1,
          paddingRight: 1,
          width: "100%",
        }}
      >
        <text fg={jixuTheme.secondary} style={{ width: MESSAGE_ROLE_WIDTH }}>
          <strong>YOU</strong>
        </text>
        <text fg={jixuTheme.text} wrapMode="word">{entry.content}</text>
      </box>
    );
  }

  if (entry.role === "assistant") {
    return (
      <box
        style={{ flexDirection: "row", marginBottom: 1, paddingLeft: 1, paddingRight: 1, width: "100%" }}
      >
        <text fg={jixuTheme.brand} style={{ width: MESSAGE_ROLE_WIDTH }}>
          {showAgentRole ? <strong>JIXU</strong> : ""}
        </text>
        <box style={{ flexGrow: 1, minWidth: 0 }}>
          <AssistantMarkdown content={entry.content} />
        </box>
      </box>
    );
  }

  return (
    <box
      style={{
        flexDirection: "row",
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <box style={{ flexDirection: "row", flexShrink: 0, width: 10 }}>
        <text fg={toneColor(entry.tone)}>
          {entry.label.slice(0, 7)}
        </text>
      </box>
      <text fg={toneColor(entry.tone)} wrapMode="word">
        {entry.content}
      </text>
    </box>
  );
}

function toolTone(operation: ToolOperation): JixuTone {
  if (operation.status === "failed") return "danger";
  if (
    operation.status === "cancelled" ||
    operation.status === "indeterminate" ||
    operation.status === "running"
  ) {
    return "warning";
  }
  return operation.outcomeTone ?? "success";
}

function toolResult(operation: ToolOperation): string {
  if (operation.status === "running") return "In progress";
  if (operation.status === "cancelled") return "Cancelled before start";
  if (operation.status === "failed") {
    return operation.outcome === undefined
      ? "Failed"
      : `Failed · ${operation.outcome}`;
  }
  if (operation.status === "indeterminate") {
    return operation.outcome === undefined
      ? "Outcome unknown"
      : `Outcome unknown · ${operation.outcome}`;
  }
  return operation.outcome ?? "Completed";
}

function toolSummary(operations: readonly ToolOperation[]): string {
  const succeeded = operations.filter(
    (operation) => operation.status === "succeeded",
  ).length;
  const cancelled = operations.filter(
    (operation) => operation.status === "cancelled",
  ).length;
  const failed = operations.filter(
    (operation) => operation.status === "failed",
  ).length;
  const indeterminate = operations.filter(
    (operation) => operation.status === "indeterminate",
  ).length;
  return [
    succeeded > 0 ? `${succeeded} done` : null,
    cancelled > 0 ? `${cancelled} cancelled` : null,
    failed > 0 ? `${failed} failed` : null,
    indeterminate > 0 ? `${indeterminate} unknown` : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

function DetailLines({
  content,
  prefix = "",
  tone = "secondary",
}: {
  readonly content: string;
  readonly prefix?: string;
  readonly tone?: JixuTone;
}) {
  const lines = content.length === 0 ? ["(empty)"] : content.split("\n");
  return lines.map((line, index) => (
    <text
      fg={toneColor(tone)}
      key={`${prefix}-${index}`}
      wrapMode="word"
    >
      {`${prefix}${line.length === 0 ? " " : line}`}
    </text>
  ));
}

function contentLineCount(content: string): number {
  return Math.max(1, content.split("\n").length);
}

function stopNestedVerticalScroll(
  event: OpenTUIMouseEvent,
  scrollbox: ScrollBoxRenderable | null,
): void {
  if (scrollbox === null) return;
  let direction = event.scroll?.direction;
  if (event.modifiers.shift) {
    direction = direction === "up"
      ? "left"
      : direction === "down"
        ? "right"
        : direction === "left"
          ? "up"
          : "down";
  }
  const maxScrollTop = Math.max(
    0,
    scrollbox.scrollHeight - scrollbox.viewport.height,
  );
  if (
    (direction === "up" && scrollbox.scrollTop > 0) ||
    (direction === "down" && scrollbox.scrollTop < maxScrollTop)
  ) {
    event.stopPropagation();
  }
}

function requestDetailLineCount(operation: ToolOperation): number {
  const detail = operation.requestDetail;
  return detail.kind === "replacement-diff"
    ? 1 + contentLineCount(detail.before) + contentLineCount(detail.after)
    : 1 + contentLineCount(detail.content);
}

function RequestDetail({ operation }: { readonly operation: ToolOperation }) {
  const detail = operation.requestDetail;
  if (detail.kind === "replacement-diff") {
    return (
      <box style={{ flexDirection: "column", width: "100%" }}>
        <text fg={jixuTheme.secondary}>
          <strong>REPLACEMENT DIFF</strong>
          {detail.replaceAll ? "  REPLACE ALL" : ""}
        </text>
        <DetailLines content={detail.before} prefix="- " tone="danger" />
        <DetailLines content={detail.after} prefix="+ " tone="success" />
      </box>
    );
  }
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <text fg={jixuTheme.secondary}><strong>{detail.label}</strong></text>
      <DetailLines content={detail.content} />
    </box>
  );
}

function ToolDetail({
  expanded,
  operation,
  transient,
}: {
  readonly expanded: boolean;
  readonly operation: ToolOperation;
  readonly transient: ToolLiveOutput | undefined;
}) {
  const scrollbox = useRef<ScrollBoxRenderable>(null);
  const preview = transient?.text ?? (expanded ? operation.preview : undefined);
  const previewText = preview?.replace(/\n+$/gu, "");
  if (!expanded && (previewText === undefined || previewText.length === 0)) {
    return null;
  }
  const hasPreview = previewText !== undefined && previewText.length > 0;
  const detailHeight =
    (expanded ? requestDetailLineCount(operation) : 0) +
    (hasPreview
      ? (expanded ? 1 : 0) +
        1 +
        (transient?.truncated === true ? 1 : 0) +
        contentLineCount(previewText)
      : 0);
  const content = (
    <>
      {expanded ? <RequestDetail operation={operation} /> : null}
      {!hasPreview ? null : (
        <box
          style={{
            flexDirection: "column",
            marginTop: expanded ? 1 : 0,
            width: "100%",
          }}
        >
          <text fg={jixuTheme.secondary}>
            <strong>
              {transient === undefined
                ? operation.status === "failed" || operation.status === "indeterminate"
                  ? "ERROR"
                  : "OUTPUT"
                : "LIVE OUTPUT"}
            </strong>
          </text>
          {transient?.truncated === true ? (
            <text fg={jixuTheme.secondary}>…</text>
          ) : null}
          <DetailLines content={previewText} />
        </box>
      )}
    </>
  );
  if (detailHeight <= TOOL_DETAIL_MAX_HEIGHT) {
    return (
      <box
        backgroundColor={jixuTheme.background}
        border={["left"]}
        borderColor={jixuTheme.divider}
        id={`tool-detail-${operation.effectId}`}
        style={{
          flexDirection: "column",
          marginLeft: 1,
          paddingLeft: 1,
          width: "100%",
        }}
      >
        {content}
      </box>
    );
  }
  return (
    <scrollbox
      ref={scrollbox}
      id={`tool-detail-${operation.effectId}`}
      onMouseScroll={(event) => {
        stopNestedVerticalScroll(event, scrollbox.current);
      }}
      scrollY
      style={{
        flexDirection: "column",
        height: TOOL_DETAIL_MAX_HEIGHT,
        marginLeft: 1,
        rootOptions: {
          backgroundColor: jixuTheme.background,
          border: ["left"],
          borderColor: jixuTheme.divider,
        },
        viewportOptions: { backgroundColor: jixuTheme.background },
        contentOptions: {
          backgroundColor: jixuTheme.background,
          flexDirection: "column",
          paddingLeft: 1,
        },
        scrollbarOptions: {
          showArrows: false,
          trackOptions: {
            backgroundColor: jixuTheme.background,
            foregroundColor: jixuTheme.secondary,
          },
        },
        width: "100%",
      }}
    >
      {content}
    </scrollbox>
  );
}

function ToolLedger({
  expandedEffectIds,
  liveOutput,
  onToggleDetail,
  operations,
  showAgentRole,
  showAllOperations,
}: {
  readonly expandedEffectIds: ReadonlySet<string>;
  readonly liveOutput: Readonly<Record<string, ToolLiveOutput>>;
  readonly onToggleDetail: (effectId: string) => void;
  readonly operations: readonly ToolOperation[];
  readonly showAgentRole: boolean;
  readonly showAllOperations: boolean;
}) {
  const live = operations.some((operation) => operation.status === "running");
  const collapsible = !live && operations.length > 4;
  const collapsed = collapsible && !showAllOperations;
  const visible = collapsed
    ? operations.filter(
        (operation) =>
          operation.status === "cancelled" ||
          operation.status === "failed" ||
          operation.status === "indeterminate",
      )
    : operations;
  const affordance = collapsed
    ? toolSummary(operations)
    : operations.length > 1
      ? `${operations.length} calls`
      : null;
  return (
    <box
      style={{
        flexDirection: "row",
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <text fg={jixuTheme.brand} style={{ width: MESSAGE_ROLE_WIDTH }}>
        {showAgentRole ? <strong>JIXU</strong> : ""}
      </text>
      <box
        border={["left"]}
        borderColor={jixuTheme.divider}
        style={{
          flexDirection: "column",
          flexGrow: 1,
          minWidth: 0,
          paddingLeft: 1,
        }}
      >
        <box style={{ flexDirection: "row", height: 1 }}>
          <text fg={jixuTheme.info}><strong>TOOLS</strong></text>
          {affordance === null ? null : (
            <text fg={jixuTheme.secondary}>  {affordance}</text>
          )}
        </box>
        {visible.map((operation) => {
          const tone = toolTone(operation);
          const transient = operation.status === "running"
            ? liveOutput[operation.effectId]
            : undefined;
          const expanded = expandedEffectIds.has(operation.effectId);
          return (
            <box
              key={operation.effectId}
              style={{ flexDirection: "column", width: "100%" }}
            >
              <box
                id={`tool-operation-${operation.effectId}`}
                onMouseDown={onPrimaryMouseDown(() => {
                  onToggleDetail(operation.effectId);
                })}
                style={{
                  flexDirection: "row",
                  height: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  width: "100%",
                }}
              >
                <text fg={jixuTheme.secondary} selectable={false}>
                  {expanded ? "▾ " : "▸ "}
                </text>
                <JixuIcon name={iconForTool(operation.name)} tone={tone} />
                <text
                  fg={toneColor(tone)}
                  selectable={false}
                  style={{ flexShrink: 0 }}
                >
                  {operation.name}
                </text>
                {operation.detail === undefined ? null : (
                  <text
                    fg={jixuTheme.secondary}
                    selectable={false}
                    style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
                    wrapMode="none"
                  >
                    {`  ${operation.detail}`}
                  </text>
                )}
                <text
                  fg={toneColor(tone)}
                  selectable={false}
                  style={{ flexShrink: 0 }}
                  wrapMode="none"
                >
                  {` · ${toolResult(operation)}`}
                </text>
              </box>
              <ToolDetail
                expanded={expanded}
                operation={operation}
                transient={transient}
              />
            </box>
          );
        })}
      </box>
    </box>
  );
}

function pendingAgentStatus(
  snapshot: ThreadControllerSnapshot,
): WorkStatus | null {
  const status = snapshot.workStatus;
  if (
    !snapshot.busy ||
    snapshot.streamingText.length > 0 ||
    status === null ||
    (status.phase !== "thinking" && status.phase !== "planning")
  ) {
    return null;
  }
  return status;
}

function EphemeralAgentStatus({
  motion,
  showAgentRole,
  status,
}: {
  readonly motion: boolean;
  readonly showAgentRole: boolean;
  readonly status: WorkStatus;
}) {
  return (
    <box
      id="ephemeral-agent-status"
      style={{
        flexDirection: "row",
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <box
        style={{
          flexDirection: "row",
          flexShrink: 0,
          width: MESSAGE_ROLE_WIDTH,
        }}
      >
        {showAgentRole ? <JixuWordmark /> : null}
      </box>
      {status.phase === "thinking" && isThinkingLabel(status.label) ? (
        <ThinkingMotionText
          enabled={motion}
          id="thinking-motion-label"
          label={status.label}
          tone={status.tone}
        />
      ) : (
        <text fg={toneColor(status.tone)}>
          <strong>{status.label}</strong>
        </text>
      )}
      {status.detail === undefined ? null : (
        <text fg={jixuTheme.secondary}> · {status.detail}</text>
      )}
    </box>
  );
}

function EmptyState({
  configured,
  creationMarkVariant,
  motion,
  top,
}: {
  configured: boolean;
  creationMarkVariant: JixuCreationMarkVariant | null;
  motion: boolean;
  top: number;
}) {
  return (
    <box
      style={{
        alignItems: "center",
        flexDirection: "column",
        marginTop: top,
      }}
    >
      {creationMarkVariant === null ? null : (
        <JixuCreationMark motion={motion} variant={creationMarkVariant} />
      )}
      <text fg={jixuTheme.brand}><strong>JIXU</strong></text>
      <text fg={jixuTheme.text}>Pick up where you left off.</text>
      <text fg={jixuTheme.secondary}>
        {configured
          ? "Ask Jixu to work in this directory."
          : "No model configured yet."}
      </text>
      {configured ? null : (
        <text fg={jixuTheme.warning}>Use /config to connect a model.</text>
      )}
      <text fg={jixuTheme.secondary}>Type / to view commands.</text>
    </box>
  );
}

export function Transcript({
  configured,
  creationMarkVariant,
  emptyTop,
  motion,
  snapshot,
  expandedToolEffectIds,
  onToggleToolDetail,
  revealLatestRequest,
  showAllToolOperations,
}: {
  readonly configured: boolean;
  readonly creationMarkVariant: JixuCreationMarkVariant | null;
  readonly emptyTop: number;
  readonly motion: boolean;
  readonly snapshot: ThreadControllerSnapshot;
  readonly expandedToolEffectIds: ReadonlySet<string>;
  readonly onToggleToolDetail: (effectId: string) => void;
  readonly revealLatestRequest: number;
  readonly showAllToolOperations: boolean;
}) {
  const scrollbox = useRef<ScrollBoxRenderable>(null);
  const pendingStatus = pendingAgentStatus(snapshot);
  const empty =
    snapshot.transcript.length === 0 &&
    snapshot.inspection === null &&
    snapshot.streamingText.length === 0 &&
    pendingStatus === null;
  let agentBlockOpen = false;
  const transcriptRows = snapshot.transcript.map((entry) => {
    if (entry.kind === "message" && entry.role !== "assistant") {
      agentBlockOpen = false;
      return (
        <TranscriptItem
          entry={entry}
          key={`transcript-${entry.id}`}
          showAgentRole={false}
        />
      );
    }
    const showAgentRole = !agentBlockOpen;
    agentBlockOpen = true;
    return entry.kind === "tool-receipts" ? (
      <ToolLedger
        expandedEffectIds={expandedToolEffectIds}
        key={`transcript-${entry.id}`}
        liveOutput={snapshot.toolLiveOutput}
        onToggleDetail={onToggleToolDetail}
        operations={entry.operations}
        showAgentRole={showAgentRole}
        showAllOperations={showAllToolOperations}
      />
    ) : (
      <TranscriptItem
        entry={entry}
        key={`transcript-${entry.id}`}
        showAgentRole={showAgentRole}
      />
    );
  });
  const showLiveAgentRole = !agentBlockOpen;

  useEffect(() => {
    if (revealLatestRequest === 0) return;
    const transcript = scrollbox.current;
    if (transcript === null) return;
    transcript.scrollTo(
      Math.max(0, transcript.scrollHeight - transcript.viewport.height),
    );
  }, [revealLatestRequest]);

  return (
    <scrollbox
      ref={scrollbox}
      id="transcript-scrollbox"
      stickyScroll
      stickyStart="bottom"
      style={{
        flexGrow: 1,
        rootOptions: { backgroundColor: jixuTheme.background },
        viewportOptions: { backgroundColor: jixuTheme.background },
        contentOptions: { backgroundColor: jixuTheme.background },
        scrollbarOptions: {
          trackOptions: {
            backgroundColor: jixuTheme.background,
            foregroundColor: jixuTheme.secondary,
          },
        },
      }}
    >
      {empty ? (
        <EmptyState
          configured={configured}
          creationMarkVariant={creationMarkVariant}
          motion={motion}
          top={emptyTop}
        />
      ) : null}
      {transcriptRows}
      {pendingStatus === null ? null : (
        <EphemeralAgentStatus
          motion={motion}
          showAgentRole={showLiveAgentRole}
          status={pendingStatus}
        />
      )}
      {snapshot.streamingText.length > 0 ? (
        <box
          style={{ flexDirection: "row", marginBottom: 1, paddingLeft: 1, paddingRight: 1, width: "100%" }}
        >
          <text fg={jixuTheme.brand} style={{ width: MESSAGE_ROLE_WIDTH }}>
            {showLiveAgentRole ? <strong>JIXU</strong> : ""}
          </text>
          <box style={{ flexGrow: 1, minWidth: 0 }}>
            <AssistantMarkdown content={snapshot.streamingText} streaming />
          </box>
        </box>
      ) : null}
      {snapshot.inspection === null ? null : (
        <box
          backgroundColor={jixuTheme.surface}
          border={["left"]}
          borderColor={jixuTheme.info}
          style={{
            flexDirection: "column",
            marginBottom: 1,
            paddingLeft: 2,
            paddingRight: 1,
            width: "100%",
          }}
        >
          <text fg={jixuTheme.info}>
            <strong>{snapshot.inspection.title}</strong>
          </text>
          <text fg={jixuTheme.text} wrapMode="word">
            {snapshot.inspection.content}
          </text>
        </box>
      )}
    </scrollbox>
  );
}
