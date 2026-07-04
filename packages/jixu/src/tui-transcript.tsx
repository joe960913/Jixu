import { RGBA, SyntaxStyle } from "@opentui/core";
import type {
  JixuTone,
  ThreadControllerSnapshot,
  TranscriptMessageEntry,
  ToolOperation,
  WorkStatus,
} from "./tui-model.ts";
import { jixuTheme } from "./theme.ts";
import { JixuCreationMark } from "./tui-creation-mark.tsx";
import { iconForTool, JixuIcon } from "./tui-icons.tsx";
import { JixuMotionText, JixuWordmark } from "./tui-motion.tsx";

function toneColor(tone: JixuTone): string {
  return jixuTheme[tone];
}

const markdownSyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromHex(jixuTheme.text) },
  "markup.heading": { bold: true, fg: RGBA.fromHex(jixuTheme.brand) },
  "markup.heading.1": { bold: true, fg: RGBA.fromHex(jixuTheme.brand) },
  "markup.link": { fg: RGBA.fromHex(jixuTheme.info), underline: true },
  "markup.list": { fg: RGBA.fromHex(jixuTheme.brand) },
  "markup.raw": { fg: RGBA.fromHex(jixuTheme.info) },
  "markup.strong": { bold: true, fg: RGBA.fromHex(jixuTheme.text) },
});

const markdownTableOptions = {
  columnFitter: "balanced",
  widthMode: "full",
  wrapMode: "word",
} as const;

const MESSAGE_ROLE_WIDTH = 6;

function TranscriptItem({ entry }: { readonly entry: TranscriptMessageEntry }) {
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
          <strong>JIXU</strong>
        </text>
        <box style={{ flexGrow: 1, minWidth: 0 }}>
          <markdown
            conceal
            content={entry.content}
            fg={jixuTheme.text}
            style={{ width: "100%" }}
            syntaxStyle={markdownSyntaxStyle}
            tableOptions={markdownTableOptions}
          />
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

function ToolLedger({ operations }: { readonly operations: readonly ToolOperation[] }) {
  const visible = operations.slice(-4);
  const hidden = operations.length - visible.length;
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
        <strong>JIXU</strong>
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
          {hidden > 0 ? <text fg={jixuTheme.secondary}>  +{hidden} earlier</text> : null}
        </box>
        {visible.map((operation) => {
          const tone: JixuTone =
            operation.status === "failed"
              ? "danger"
              : operation.status === "running"
                ? "warning"
                : "success";
          const status =
            operation.status === "failed"
              ? "Failed"
              : operation.status === "running"
                ? "In progress"
                : "Completed";
          return (
            <box
              key={operation.effectId}
              style={{ flexDirection: "column", height: 2, width: "100%" }}
            >
              <box style={{ flexDirection: "row", height: 1, minWidth: 0 }}>
                <JixuIcon name={iconForTool(operation.name)} tone={tone} />
                <text fg={toneColor(tone)}>{operation.name}</text>
              </box>
              <text fg={jixuTheme.secondary} style={{ paddingLeft: 2 }}>
                {operation.detail === undefined ? status : `${operation.detail} · ${status}`}
              </text>
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
  status,
}: {
  readonly motion: boolean;
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
        <JixuWordmark
          enabled={motion}
          phase={status.phase}
          tone={status.tone}
        />
      </box>
      {status.phase === "thinking" && status.label === "Thinking" ? (
        <JixuMotionText
          enabled={motion}
          id="thinking-motion-label"
          label="Thinking ..."
          phase={status.phase}
          staticTone={status.tone}
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
  showCreationMark,
  top,
}: {
  configured: boolean;
  showCreationMark: boolean;
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
      {showCreationMark ? <JixuCreationMark /> : null}
      <text fg={jixuTheme.brand}><strong>JIXU</strong></text>
      <text fg={jixuTheme.text}>Agents that continue.</text>
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
  emptyTop,
  motion,
  showCreationMark,
  snapshot,
}: {
  readonly configured: boolean;
  readonly emptyTop: number;
  readonly motion: boolean;
  readonly showCreationMark: boolean;
  readonly snapshot: ThreadControllerSnapshot;
}) {
  const pendingStatus = pendingAgentStatus(snapshot);
  const empty =
    snapshot.transcript.length === 0 &&
    snapshot.inspection === null &&
    snapshot.streamingText.length === 0 &&
    pendingStatus === null;
  return (
    <scrollbox
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
          showCreationMark={showCreationMark}
          top={emptyTop}
        />
      ) : null}
      {snapshot.transcript.map((entry) =>
        entry.kind === "tool-receipts" ? (
          <ToolLedger key={`transcript-${entry.id}`} operations={entry.operations} />
        ) : (
          <TranscriptItem key={`transcript-${entry.id}`} entry={entry} />
        ),
      )}
      {pendingStatus === null ? null : (
        <EphemeralAgentStatus motion={motion} status={pendingStatus} />
      )}
      {snapshot.streamingText.length > 0 ? (
        <box
          style={{ flexDirection: "row", marginBottom: 1, paddingLeft: 1, paddingRight: 1, width: "100%" }}
        >
          <text fg={jixuTheme.brand} style={{ width: MESSAGE_ROLE_WIDTH }}>
            <strong>JIXU</strong>
          </text>
          <box style={{ flexGrow: 1, minWidth: 0 }}>
            <markdown
              conceal
              content={snapshot.streamingText}
              fg={jixuTheme.text}
              style={{ width: "100%" }}
              streaming
              syntaxStyle={markdownSyntaxStyle}
              tableOptions={markdownTableOptions}
            />
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
