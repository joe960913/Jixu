import {
  RGBA,
  SyntaxStyle,
  type InputRenderable,
  type SubmitEvent,
} from "@opentui/core";
import {
  useKeyboard,
  useTerminalDimensions,
} from "@opentui/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { normalizeJixuBaseUrl } from "./config.ts";
import type {
  JixuApiFormat,
  JixuConnectionConfig,
} from "./config.ts";
import type {
  ActivityEntry,
  JixuSession,
  JixuSessionSnapshot,
  SessionTone,
  TranscriptEntry,
} from "./session.ts";
import { jixuTheme } from "./theme.ts";

export interface JixuInitialConfiguration {
  readonly apiFormat?: JixuApiFormat;
  readonly apiKey?: string;
  readonly autoConnect?: boolean;
  readonly baseUrl?: string;
  readonly model?: string;
}

export interface JixuAppControls {
  readonly onConfigure: () => void;
  readonly onQuit: () => void;
}

export interface JixuAppProps {
  readonly connect: (
    config: JixuConnectionConfig,
    controls: JixuAppControls,
  ) => JixuSession | Promise<JixuSession>;
  readonly initial?: JixuInitialConfiguration;
  readonly onQuit: () => void;
  readonly workspace: string;
}

interface ActiveConnection {
  readonly config: JixuConnectionConfig;
  readonly session: JixuSession;
}

function completeInitial(
  initial: JixuInitialConfiguration | undefined,
): JixuConnectionConfig | null {
  const apiFormat = initial?.apiFormat;
  const apiKey = initial?.apiKey;
  const baseUrl = initial?.baseUrl;
  const model = initial?.model;
  return apiFormat === undefined ||
    apiKey === undefined ||
    baseUrl === undefined ||
    model === undefined
    ? null
    : { apiFormat, apiKey, baseUrl, model };
}

function toneColor(tone: SessionTone): string {
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
  snapshot: JixuSessionSnapshot,
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

function EmptyState({ top }: { readonly top: number }) {
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
      <text fg={jixuTheme.secondary}>Ask Jixu to work in this directory.</text>
      <text fg={jixuTheme.secondary}>
        /help · /events · /state · /pause · /resume
      </text>
      <text fg={jixuTheme.secondary}>/replay · /fork · /config</text>
    </box>
  );
}

function Transcript({
  emptyTop,
  includeActivity,
  snapshot,
}: {
  readonly emptyTop: number;
  readonly includeActivity: boolean;
  readonly snapshot: JixuSessionSnapshot;
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
      {empty ? <EmptyState top={emptyTop} /> : null}
      {items.map((item) =>
        item.kind === "transcript" ? (
          <TranscriptItem entry={item.entry} key={`transcript-${item.entry.id}`} />
        ) : (
          <ActivityItem entry={item.entry} key={`activity-${item.entry.id}`} />
        ),
      )}
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

function ActivityRail({
  height,
  snapshot,
  width,
}: {
  readonly height: number;
  readonly snapshot: JixuSessionSnapshot;
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
              Run, model, and Tool events appear here.
            </text>
          </box>
        ) : null}
        {snapshot.activity.map((entry) => (
          <DeveloperActivityItem entry={entry} key={entry.id} />
        ))}
      </scrollbox>
      <text fg={jixuTheme.secondary}>
        {snapshot.currentRunId === null
          ? "No active Run"
          : `Run · ${compactEventId(snapshot.currentRunId)}`}
      </text>
    </box>
  );
}

interface SetupProps {
  readonly initial: JixuInitialConfiguration | undefined;
  readonly initialError: string | null;
  readonly onConnect: (config: JixuConnectionConfig) => Promise<void>;
  readonly workspace: string;
}

function Setup({ initial, initialError, onConnect, workspace }: SetupProps) {
  const [apiFormat, setApiFormat] = useState<JixuApiFormat>(
    initial?.apiFormat ?? "responses",
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [focus, setFocus] = useState<0 | 1 | 2 | 3>(0);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const baseUrlInput = useRef<InputRenderable>(null);
  const apiKeyInput = useRef<InputRenderable>(null);
  const modelInput = useRef<InputRenderable>(null);
  const { width } = useTerminalDimensions();

  useEffect(() => {
    if (focus !== 1) baseUrlInput.current?.blur();
    if (focus !== 2) apiKeyInput.current?.blur();
    if (focus !== 3) modelInput.current?.blur();
  }, [focus]);

  const selectApiFormat = (next: JixuApiFormat) => {
    setApiFormat(next);
    setError(null);
  };

  const connect = async () => {
    const cleanKey = apiKey.trim();
    const cleanModel = model.trim();
    let cleanBaseUrl: string;
    try {
      cleanBaseUrl = normalizeJixuBaseUrl(baseUrl);
    } catch (urlError) {
      setError(urlError instanceof Error ? urlError.message : "Base URL is invalid.");
      setFocus(1);
      return;
    }
    if (cleanKey.length === 0) {
      setError("API Key is required.");
      setFocus(2);
      return;
    }
    if (cleanModel.length === 0) {
      setError("Model ID is required.");
      setFocus(3);
      return;
    }
    if (connecting) return;

    setConnecting(true);
    setError(null);
    try {
      await onConnect({
        apiFormat,
        apiKey: cleanKey,
        baseUrl: cleanBaseUrl,
        model: cleanModel,
      });
    } catch (connectionError) {
      setConnecting(false);
      setError(
        connectionError instanceof Error
          ? connectionError.message
          : "Could not configure the endpoint.",
      );
    }
  };

  useKeyboard((key) => {
    if (key.name === "tab") {
      key.preventDefault();
      setFocus((current) => {
        if (key.shift) {
          return current === 0 ? 3 : ((current - 1) as 0 | 1 | 2 | 3);
        }
        return current === 3 ? 0 : ((current + 1) as 0 | 1 | 2 | 3);
      });
      return;
    }
    if (focus === 0) {
      if (
        key.name === "left" ||
        key.name === "right" ||
        key.name === "up" ||
        key.name === "down"
      ) {
        key.preventDefault();
        selectApiFormat(
          apiFormat === "responses" ? "chat-completions" : "responses",
        );
        return;
      }
      if (key.sequence === "1" || key.sequence === "2") {
        key.preventDefault();
        selectApiFormat(
          key.sequence === "1" ? "responses" : "chat-completions",
        );
        return;
      }
    }
    if (focus === 0 && key.name === "return") {
      key.preventDefault();
      setFocus(1);
      return;
    }
    if (focus === 3 && key.name === "return") {
      key.preventDefault();
      void connect();
    }
  });

  const submitModel = (_event: string | SubmitEvent) => void connect();
  return (
    <box
      style={{
        alignItems: "center",
        backgroundColor: jixuTheme.background,
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
        padding: 1,
        width: "100%",
      }}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text fg={jixuTheme.brand}>
          <strong>JIXU</strong>
        </text>
        <text fg={jixuTheme.text}>  Agents that continue.</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={jixuTheme.secondary}>Setup · saved in ~/.jixu</text>
      </box>

      <box
        border
        borderColor={jixuTheme.secondary}
        title=" Connect a model "
        titleColor={jixuTheme.text}
        style={{
          flexDirection: "column",
          gap: 0,
          padding: 1,
          width: width >= 76 ? 72 : "100%",
        }}
      >
        <text fg={jixuTheme.secondary}>1  API format</text>
        <box style={{ flexDirection: "row", gap: 1, height: 3, width: "100%" }}>
          <box
            border
            borderColor={
              apiFormat === "responses"
                ? focus === 0
                  ? jixuTheme.brand
                  : jixuTheme.info
                : jixuTheme.secondary
            }
            style={{ flexGrow: 1, paddingLeft: 1 }}
          >
            <text fg={apiFormat === "responses" ? jixuTheme.text : jixuTheme.secondary}>
              <strong>
                {apiFormat === "responses" ? "●" : "○"} 1 Responses
              </strong>
            </text>
          </box>
          <box
            border
            borderColor={
              apiFormat === "chat-completions"
                ? focus === 0
                  ? jixuTheme.brand
                  : jixuTheme.info
                : jixuTheme.secondary
            }
            style={{ flexGrow: 1, paddingLeft: 1 }}
          >
            <text
              fg={
                apiFormat === "chat-completions"
                  ? jixuTheme.text
                  : jixuTheme.secondary
              }
            >
              <strong>
                {apiFormat === "chat-completions" ? "●" : "○"} 2 Chat Completions
              </strong>
            </text>
          </box>
        </box>
        <text fg={focus === 0 ? jixuTheme.brand : jixuTheme.secondary}>
          ←/→ or 1/2 select · Enter continue
        </text>

        <text fg={jixuTheme.secondary}>2  Base URL</text>
        <box
          border
          borderColor={focus === 1 ? jixuTheme.brand : jixuTheme.secondary}
          style={{ height: 3, paddingLeft: 1, paddingRight: 1, width: "100%" }}
        >
          <input
            ref={baseUrlInput}
            backgroundColor={jixuTheme.background}
            cursorColor={jixuTheme.brand}
            focused={focus === 1}
            focusedBackgroundColor={jixuTheme.background}
            focusedTextColor={jixuTheme.text}
            onInput={setBaseUrl}
            onSubmit={() => {
              baseUrlInput.current?.blur();
              setFocus(2);
            }}
            placeholder="https://api.example.com/v1"
            placeholderColor={jixuTheme.secondary}
            textColor={jixuTheme.text}
            value={baseUrl}
          />
        </box>

        <text fg={jixuTheme.secondary}>3  API Key</text>
        <box
          border
          borderColor={focus === 2 ? jixuTheme.brand : jixuTheme.secondary}
          style={{
            height: 3,
            paddingLeft: 1,
            paddingRight: 1,
            width: "100%",
          }}
        >
          <input
            ref={apiKeyInput}
            backgroundColor={jixuTheme.background}
            cursorColor={jixuTheme.brand}
            focused={focus === 2}
            focusedBackgroundColor={jixuTheme.background}
            focusedTextColor={jixuTheme.text}
            maxLength={8192}
            onInput={setApiKey}
            onSubmit={() => {
              apiKeyInput.current?.blur();
              setFocus(3);
            }}
            placeholder="Paste or type the endpoint API key"
            placeholderColor={jixuTheme.secondary}
            textColor={jixuTheme.text}
            value={apiKey}
          />
        </box>

        <text fg={jixuTheme.secondary}>4  Model ID</text>
        <box
          border
          borderColor={focus === 3 ? jixuTheme.brand : jixuTheme.secondary}
          style={{ height: 3, paddingLeft: 1, paddingRight: 1, width: "100%" }}
        >
          <input
            ref={modelInput}
            backgroundColor={jixuTheme.background}
            cursorColor={jixuTheme.brand}
            focused={focus === 3}
            focusedBackgroundColor={jixuTheme.background}
            focusedTextColor={jixuTheme.text}
            onInput={setModel}
            onSubmit={submitModel}
            placeholder="e.g. vendor/model-name"
            placeholderColor={jixuTheme.secondary}
            textColor={jixuTheme.text}
            value={model}
          />
        </box>

        <box style={{ flexDirection: "row", width: "100%" }}>
          <text fg={error === null ? jixuTheme.secondary : jixuTheme.danger}>
            {error ?? (connecting ? "Connecting…" : "Tab move · Enter continue / connect")}
          </text>
          <box style={{ flexGrow: 1 }} />
          <text fg={jixuTheme.brand}>
            <strong>{connecting ? "CONNECTING" : "ENTER TO CONNECT"}</strong>
          </text>
        </box>
      </box>

      <box style={{ flexDirection: "row", width: "100%" }}>
        <text fg={jixuTheme.secondary}>Compatible endpoint</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={jixuTheme.secondary}>Ctrl+C quit · {workspace}</text>
      </box>
    </box>
  );
}

function Booting({ workspace }: { readonly workspace: string }) {
  return (
    <box
      style={{
        alignItems: "center",
        backgroundColor: jixuTheme.background,
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <text fg={jixuTheme.brand}>
        <strong>JIXU</strong>
      </text>
      <text fg={jixuTheme.text}>Loading saved endpoint configuration…</text>
      <text fg={jixuTheme.secondary}>{workspace}</text>
    </box>
  );
}

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

function AgentWorkspace({
  active,
}: {
  readonly active: ActiveConnection;
}) {
  const snapshot = useSyncExternalStore(
    active.session.subscribe,
    active.session.getSnapshot,
    active.session.getSnapshot,
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
  const workHeight = Math.max(12, height - 4);
  const transcriptHeight = Math.max(7, workHeight - 4);
  const compact = chatWidth < 84;
  const input = useRef<InputRenderable>(null);
  const [draft, setDraft] = useState("");

  const submit = (submitted: string | SubmitEvent) => {
    const value =
      typeof submitted === "string"
        ? submitted
        : (input.current?.value ?? draft);
    if (value.trim().length === 0) return;
    if (input.current !== null) input.current.value = "";
    setDraft("");
    void active.session.submit(value);
  };

  const statusTone = snapshot.busy
    ? jixuTheme.warning
      : snapshot.runStatus === "failed"
      ? jixuTheme.danger
      : jixuTheme.success;
  const status = snapshot.busy ? "working" : snapshot.runStatus;
  const endpointContext = truncate(
    compact
      ? active.config.model
      : `${endpointName(active.config.baseUrl)} · ${active.config.model}`,
    compact
      ? Math.max(16, workspaceWidth - 30)
      : Math.max(24, Math.floor(workspaceWidth / 2)),
  );
  const formatContext =
    active.config.apiFormat === "responses" ? "Responses" : "Chat Completions";

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
          <box style={{ height: transcriptHeight, width: chatWidth }}>
            <Transcript
              emptyTop={Math.max(0, Math.floor((transcriptHeight - 11) / 2))}
              includeActivity={!showActivityRail}
              snapshot={snapshot}
            />
          </box>

          <box
            backgroundColor={jixuTheme.surface}
            border={["left"]}
            borderColor={jixuTheme.brand}
            style={{
              flexDirection: "column",
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
                  snapshot.busy
                    ? "Jixu is working…"
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

      <box style={{ flexDirection: "row", height: 1, width: workspaceWidth }}>
        <text fg={jixuTheme.brand}>{endpointContext}</text>
        {compact ? null : (
          <text fg={jixuTheme.secondary}> · {formatContext}  </text>
        )}
        <text fg={jixuTheme.warning}>Local shell · unsandboxed</text>
        <box style={{ flexGrow: 1 }} />
        {compact ? null : <text fg={jixuTheme.secondary}>ctrl+c quit</text>}
      </box>
    </box>
  );
}

export function JixuApp({ connect, initial, onQuit, workspace }: JixuAppProps) {
  const [active, setActive] = useState<ActiveConnection | null>(null);
  const [configuration, setConfiguration] =
    useState<JixuInitialConfiguration | undefined>(initial);
  const [booting, setBooting] = useState(initial?.autoConnect === true);
  const [autoError, setAutoError] = useState<string | null>(null);
  const attempted = useRef(false);

  const activate = useCallback(
    async (config: JixuConnectionConfig) => {
      const session = await connect(config, {
        onConfigure: () => {
          setActive(null);
          setBooting(false);
        },
        onQuit,
      });
      setConfiguration({
        apiFormat: config.apiFormat,
        apiKey: config.apiKey,
        autoConnect: true,
        baseUrl: config.baseUrl,
        model: config.model,
      });
      setActive({ config, session });
      setBooting(false);
      setAutoError(null);
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
      setAutoError(
        error instanceof Error ? error.message : "Could not load saved configuration.",
      );
    });
  }, [activate, initial]);

  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "c") return;
    key.preventDefault();
    onQuit();
  });

  if (booting) return <Booting workspace={workspace} />;
  if (active !== null) {
    return <AgentWorkspace active={active} />;
  }
  return (
    <Setup
      initial={configuration}
      initialError={autoError}
      onConnect={activate}
      workspace={workspace}
    />
  );
}
