import { RGBA, SyntaxStyle } from "@opentui/core";
import type { PlanSnapshot, PlanStepStatus } from "@jixu/core";

import type {
  ActivityEntry,
  JixuTone,
  ThreadControllerSnapshot,
  TranscriptEntry,
} from "./tui-model.ts";
import { jixuTheme } from "./theme.ts";

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

type FeedItem =
  | { readonly entry: ActivityEntry; readonly kind: "activity" }
  | { readonly entry: TranscriptEntry; readonly kind: "transcript" };

function visibleFeed(
  snapshot: ThreadControllerSnapshot,
  includeActivity: boolean,
): readonly FeedItem[] {
  return [
    ...snapshot.transcript.map(
      (entry): FeedItem => ({ entry, kind: "transcript" }),
    ),
    ...(includeActivity
      ? snapshot.activity
          .filter((entry) => entry.kind !== "runtime")
          .map((entry): FeedItem => ({ entry, kind: "activity" }))
      : []),
  ].sort((left, right) => left.entry.id - right.entry.id);
}

function activitySymbol(entry: ActivityEntry): string {
  if (entry.tone === "danger") return "×";
  if (entry.tone === "success") return "✓";
  if (entry.kind === "control") return "↳";
  return "+";
}

function TranscriptItem({ entry }: { readonly entry: TranscriptEntry }) {
  if (entry.role === "user") {
    return (
      <box
        backgroundColor={jixuTheme.surface}
        border={["left"]}
        borderColor={jixuTheme.brand}
        style={{ marginBottom: 1, paddingLeft: 1, paddingRight: 1 }}
      >
        <text fg={jixuTheme.text} wrapMode="word">
          {entry.content}
        </text>
      </box>
    );
  }

  if (entry.role === "assistant") {
    return (
      <box
        style={{
          flexDirection: "column",
          marginBottom: 1,
          paddingLeft: 1,
          width: "100%",
        }}
      >
        <text fg={jixuTheme.brand}>
          <strong>JIXU</strong>
        </text>
        <markdown
          conceal
          content={entry.content}
          fg={jixuTheme.text}
          style={{ width: "100%" }}
          syntaxStyle={markdownSyntaxStyle}
        />
      </box>
    );
  }

  return (
    <box
      style={{
        flexDirection: "row",
        marginBottom: 1,
        paddingLeft: 1,
        width: "100%",
      }}
    >
      <text fg={toneColor(entry.tone)} wrapMode="word">
        {entry.tone === "danger" ? "×" : "!"} {entry.content}
      </text>
    </box>
  );
}

function ActivityItem({ entry }: { readonly entry: ActivityEntry }) {
  return (
    <box
      style={{
        flexDirection: "row",
        marginBottom: 1,
        paddingLeft: 1,
        width: "100%",
      }}
    >
      <text fg={toneColor(entry.tone)}>
        {activitySymbol(entry)} {entry.label}
      </text>
      {entry.detail === undefined ? null : (
        <text fg={jixuTheme.secondary}> · {entry.detail}</text>
      )}
    </box>
  );
}

function planStepPresentation(status: PlanStepStatus): {
  readonly color: string;
  readonly symbol: string;
} {
  switch (status) {
    case "completed":
      return { color: jixuTheme.success, symbol: "✓" };
    case "in_progress":
      return { color: jixuTheme.warning, symbol: "→" };
    case "blocked":
      return { color: jixuTheme.danger, symbol: "×" };
    case "skipped":
      return { color: jixuTheme.secondary, symbol: "–" };
    case "pending":
      return { color: jixuTheme.info, symbol: "·" };
  }
}

function ActivePlan({ plan }: { readonly plan: PlanSnapshot }) {
  return (
    <box
      backgroundColor={jixuTheme.surface}
      border={["left"]}
      borderColor={jixuTheme.warning}
      style={{
        flexDirection: "column",
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <text fg={jixuTheme.brand}>
        <strong>PLAN</strong>
        <span fg={jixuTheme.secondary}> · r{plan.revision}</span>
      </text>
      <text fg={jixuTheme.text} wrapMode="word">
        {plan.objective}
      </text>
      <box style={{ flexDirection: "column", marginTop: 1, width: "100%" }}>
        {plan.steps.map((step) => {
          const presentation = planStepPresentation(step.status);
          return (
            <box key={step.id} style={{ flexDirection: "row", width: "100%" }}>
              <text fg={presentation.color}>{presentation.symbol} </text>
              <text fg={jixuTheme.text} wrapMode="word">
                {step.description}
              </text>
            </box>
          );
        })}
      </box>
      <text fg={jixuTheme.secondary} wrapMode="word">
        Next · <span fg={jixuTheme.info}>{plan.nextAction}</span>
      </text>
    </box>
  );
}

function EmptyState({ configured, top }: { configured: boolean; top: number }) {
  return (
    <box
      style={{
        alignItems: "center",
        flexDirection: "column",
        marginTop: top,
      }}
    >
      <ascii-font
        color={jixuTheme.brand}
        font="block"
        selectable={false}
        text="JIXU"
      />
      <text fg={jixuTheme.text}>Agents that continue.</text>
      <text fg={jixuTheme.secondary}>
        {configured
          ? "Ask Jixu to work in this directory."
          : "No model configured yet."}
      </text>
      {configured ? null : (
        <text fg={jixuTheme.warning}>Use /config to connect a model.</text>
      )}
      <text fg={jixuTheme.secondary}>
        /help · /new · /clear · /resume · /continue
      </text>
      <text fg={jixuTheme.secondary}>/events · /state · /replay · /fork · /config</text>
    </box>
  );
}

export function Transcript({
  configured,
  emptyTop,
  includeActivity,
  snapshot,
}: {
  readonly configured: boolean;
  readonly emptyTop: number;
  readonly includeActivity: boolean;
  readonly snapshot: ThreadControllerSnapshot;
}) {
  const items = visibleFeed(snapshot, includeActivity);
  const empty =
    items.length === 0 &&
    snapshot.inspection === null &&
    snapshot.streamingText.length === 0;

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
      {empty ? <EmptyState configured={configured} top={emptyTop} /> : null}
      {items.map((item) =>
        item.kind === "transcript" ? (
          <TranscriptItem entry={item.entry} key={`transcript-${item.entry.id}`} />
        ) : (
          <ActivityItem entry={item.entry} key={`activity-${item.entry.id}`} />
        ),
      )}
      {snapshot.activePlan === null ? null : <ActivePlan plan={snapshot.activePlan} />}
      {snapshot.streamingText.length > 0 ? (
        <box
          style={{
            flexDirection: "column",
            marginBottom: 1,
            paddingLeft: 1,
            width: "100%",
          }}
        >
          <text fg={jixuTheme.brand}>
            <strong>JIXU</strong>
          </text>
          <markdown
            conceal
            content={snapshot.streamingText}
            fg={jixuTheme.text}
            style={{ width: "100%" }}
            streaming
            syntaxStyle={markdownSyntaxStyle}
          />
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
            paddingLeft: 1,
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

function compactEventId(eventId: string): string {
  return eventId.length <= 14 ? eventId : `…${eventId.slice(-12)}`;
}

function DeveloperActivityItem({ entry }: { readonly entry: ActivityEntry }) {
  return (
    <box
      style={{
        flexDirection: "column",
        marginBottom: 1,
        width: "100%",
      }}
    >
      <text fg={toneColor(entry.tone)} wrapMode="word">
        {activitySymbol(entry)} {entry.label}
      </text>
      {entry.detail === undefined ? null : (
        <text fg={jixuTheme.secondary} wrapMode="word">
          {entry.detail}
        </text>
      )}
      {entry.eventId === undefined ? null : (
        <text fg={jixuTheme.secondary}>{compactEventId(entry.eventId)}</text>
      )}
    </box>
  );
}

export function ActivityRail({
  height,
  snapshot,
  width,
}: {
  readonly height: number;
  readonly snapshot: ThreadControllerSnapshot;
  readonly width: number;
}) {
  return (
    <box
      border={["left"]}
      borderColor={jixuTheme.secondary}
      style={{
        flexDirection: "column",
        height,
        paddingLeft: 1,
        width,
      }}
    >
      <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
        <text fg={jixuTheme.brand}>
          <strong>ACTIVITY</strong>
        </text>
        <box style={{ flexGrow: 1 }} />
        <text fg={jixuTheme.secondary}>{snapshot.activity.length}</text>
      </box>
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
        {snapshot.activity.length === 0 ? (
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <text fg={jixuTheme.secondary}>No activity yet.</text>
            <text fg={jixuTheme.secondary} wrapMode="word">
              Thread, model, and Tool events appear here.
            </text>
          </box>
        ) : null}
        {snapshot.activity.map((entry) => (
          <DeveloperActivityItem entry={entry} key={entry.id} />
        ))}
      </scrollbox>
      <text fg={jixuTheme.secondary}>
        {snapshot.currentThreadId === null
          ? "No Thread selected"
          : `Thread · ${compactEventId(snapshot.currentThreadId)}`}
      </text>
    </box>
  );
}
