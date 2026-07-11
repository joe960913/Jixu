import {
  isJsonObject,
  MODEL_PROGRESS_SIGNAL_TYPE,
  parseToolOutputDelta,
  TOOL_OUTPUT_SIGNAL_TYPE,
} from "@jixu/core";
import type {
  AnyThreadEvent,
  Harness,
  Thread,
  ThreadState,
  ThreadStreamItem,
  ToolApproval,
  ToolApprovalDecision,
  ToolOutputDelta,
} from "@jixu/core";

import { formatSlashCommandHelp } from "./commands.ts";
import { projectThread } from "./thread-projection.ts";
import { workStatusForEvent } from "./work-status.ts";
import type {
  JixuTone,
  ThreadControllerSnapshot,
  ThreadSummary,
  ToolLiveOutput,
  TranscriptRole,
} from "./tui-model.ts";

type SnapshotUpdates = {
  -readonly [TKey in keyof ThreadControllerSnapshot]?: ThreadControllerSnapshot[TKey];
};

export interface ThreadControllerConfig {
  readonly harness: Harness;
  readonly onConfigure?: () => void;
  readonly onQuit?: () => void;
}

const HELP = formatSlashCommandHelp();
const STREAM_FRAME_MS = 32;
const TOOL_LIVE_OUTPUT_LINES = 3;
const TOOL_LIVE_OUTPUT_LENGTH = 1_200;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Jixu error";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function signalDelta(item: ThreadStreamItem): string | null {
  if (
    item.kind !== "signal" ||
    item.type !== "model.output_text.delta" ||
    !isJsonObject(item.data)
  ) {
    return null;
  }
  return typeof item.data.delta === "string" ? item.data.delta : null;
}

function signalProgress(item: ThreadStreamItem): string | null {
  if (
    item.kind !== "signal" ||
    item.type !== MODEL_PROGRESS_SIGNAL_TYPE ||
    !isJsonObject(item.data)
  ) {
    return null;
  }
  return typeof item.data.message === "string" ? item.data.message : null;
}

function signalToolOutput(item: ThreadStreamItem): ToolOutputDelta | null {
  if (item.kind !== "signal" || item.type !== TOOL_OUTPUT_SIGNAL_TYPE) {
    return null;
  }
  try {
    return parseToolOutputDelta(item.data);
  } catch {
    return null;
  }
}

function removeToolLiveOutput(
  outputs: Readonly<Record<string, ToolLiveOutput>>,
  effectId: string,
): Readonly<Record<string, ToolLiveOutput>> {
  return Object.fromEntries(
    Object.entries(outputs).filter(([candidate]) => candidate !== effectId),
  );
}

function appendToolLiveOutput(
  current: ToolLiveOutput | undefined,
  delta: string,
): ToolLiveOutput {
  const combined = `${current?.text ?? ""}${delta}`.replace(/\r\n?/gu, "\n");
  const lineTail = combined.split("\n").slice(-TOOL_LIVE_OUTPUT_LINES).join("\n");
  const text = lineTail.slice(-TOOL_LIVE_OUTPUT_LENGTH);
  return Object.freeze({
    text,
    truncated:
      current?.truncated === true ||
      lineTail.length !== combined.length ||
      text.length !== lineTail.length,
  });
}

function titleFrom(events: readonly AnyThreadEvent[]): string {
  const firstInput = events.find((event) => event.type === "input.received");
  if (firstInput?.type !== "input.received") return "Empty Thread";
  const title = firstInput.payload.content.replace(/\s+/g, " ").trim();
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

function sameEventLog(
  left: readonly AnyThreadEvent[],
  right: readonly AnyThreadEvent[],
): boolean {
  return (
    left.length === right.length && left.at(-1)?.id === right.at(-1)?.id
  );
}

export class ThreadController {
  readonly #harness: Harness;
  readonly #listeners = new Set<() => void>();
  readonly #onConfigure: () => void;
  readonly #onQuit: () => void;
  #creating: Promise<Thread> | null = null;
  #current: Thread | null = null;
  #events: readonly AnyThreadEvent[] = [];
  #inFlight = 0;
  #nextId = 1;
  #observer: AbortController | null = null;
  #progressMessage: string | null = null;
  #streamBuffer = "";
  #streamFlush: ReturnType<typeof setTimeout> | null = null;
  #toolOutputBuffer = new Map<string, string>();
  #toolOutputFlush: ReturnType<typeof setTimeout> | null = null;
  #snapshot: ThreadControllerSnapshot = Object.freeze({
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

  constructor(config: ThreadControllerConfig) {
    this.#harness = config.harness;
    this.#onConfigure = config.onConfigure ?? (() => undefined);
    this.#onQuit = config.onQuit ?? (() => undefined);
  }

  readonly getSnapshot = (): ThreadControllerSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  closeThreadPicker(): void {
    this.#patch({ threadPickerOpen: false });
  }

  async selectThread(threadId: string): Promise<void> {
    if (this.#snapshot.busy) {
      this.#notice("Pause the active Thread before switching.");
      return;
    }
    try {
      const thread = await this.#harness.openThread(threadId);
      const state = await this.#select(thread);
      this.#patch({ threadPickerOpen: false });
      if (state.status === "running") {
        this.#beginWork();
        try {
          const stable = await thread.wait();
          await this.#sync(thread, stable);
          this.#showStableOutcome(stable);
        } finally {
          this.#endWork();
        }
      }
    } catch (error) {
      this.#notice(errorMessage(error), "ERROR", "danger");
    }
  }

  async submit(rawInput: string): Promise<void> {
    const input = rawInput.trim();
    if (input.length === 0) return;
    if (input.startsWith("/")) {
      await this.#command(input);
      return;
    }

    try {
      const thread = await this.#ensureCurrent();
      this.#beginWork();
      const state = await thread.send(input);
      await this.#sync(thread, state);
      this.#showStableOutcome(state);
    } catch (error) {
      this.#notice(errorMessage(error), "ERROR", "danger");
    } finally {
      this.#endWork();
    }
  }

  async decideToolApproval(decision: ToolApprovalDecision): Promise<void> {
    const thread = this.#requireThread();
    if (thread === null) return;
    const approval = this.#snapshot.toolApproval;
    if (approval === null) {
      this.#notice("No Tool approval is waiting.");
      return;
    }
    try {
      this.#beginWork();
      const state = await thread.decideApproval(approval.effectId, decision);
      await this.#sync(thread, state);
      this.#showStableOutcome(state);
    } catch (error) {
      this.#notice(errorMessage(error), "ERROR", "danger");
    } finally {
      this.#endWork();
    }
  }

  async #command(input: string): Promise<void> {
    const [command] = input.split(/\s+/, 1);
    switch (command) {
      case "/help":
        this.#inspect("Commands", HELP);
        return;
      case "/quit":
        this.#onQuit();
        return;
      case "/config":
        if (this.#snapshot.busy) {
          this.#notice("Pause the active Thread before changing model configuration.");
        } else {
          this.#onConfigure();
        }
        return;
      case "/new":
        await this.#newThread();
        return;
      case "/clear":
        await this.#clear();
        return;
      case "/resume":
        await this.#showThreads();
        return;
      case "/continue":
        await this.#continue();
        return;
      case "/approve":
        await this.decideToolApproval("allow_once");
        return;
      case "/deny":
        await this.decideToolApproval("deny");
        return;
      case "/events":
        await this.#inspectEvents();
        return;
      case "/state":
        await this.#inspectState(false);
        return;
      case "/replay":
        await this.#inspectState(true);
        return;
      case "/pause":
        await this.#pause();
        return;
      case "/fork":
        await this.#fork(input);
        return;
      default:
        this.#notice(`Unknown command ${command}. Use /help.`);
    }
  }

  async #newThread(): Promise<void> {
    if (this.#snapshot.busy) {
      this.#notice("Pause the active Thread before creating another Thread.");
      return;
    }
    try {
      await this.#select(await this.#harness.createThread());
    } catch (error) {
      this.#notice(errorMessage(error), "ERROR", "danger");
    }
  }

  async #clear(): Promise<void> {
    const thread = this.#requireThread();
    if (thread === null) return;
    try {
      const state = await thread.clear();
      await this.#sync(thread, state);
    } catch (error) {
      this.#notice(errorMessage(error));
    }
  }

  async #showThreads(): Promise<void> {
    if (this.#snapshot.busy) {
      this.#notice("Pause the active Thread before switching.");
      return;
    }
    try {
      const threads = await this.#harness.listThreads();
      const summaries = await Promise.all(
        threads.map(async (thread) => {
          const [events, state] = await Promise.all([
            thread.events(),
            thread.state(),
          ]);
          return {
            current: thread.id === this.#current?.id,
            id: thread.id,
            status: state.status,
            title: titleFrom(events),
            updatedAt: events.at(-1)?.timestamp ?? "",
          } satisfies ThreadSummary;
        }),
      );
      if (summaries.length === 0) {
        this.#notice("No previous Threads yet. Use /new or send a message.");
        return;
      }
      this.#patch({
        threadPickerOpen: true,
        threads: summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      });
    } catch (error) {
      this.#notice(errorMessage(error), "ERROR", "danger");
    }
  }

  async #continue(): Promise<void> {
    const thread = this.#requireThread();
    if (thread === null) return;
    try {
      this.#beginWork();
      const state = await thread.continue();
      await this.#sync(thread, state);
      this.#showStableOutcome(state);
    } catch (error) {
      this.#notice(errorMessage(error));
    } finally {
      this.#endWork();
    }
  }

  async #inspectEvents(): Promise<void> {
    const thread = this.#requireThread();
    if (thread === null) return;
    try {
      const events = await thread.events();
      this.#inspect(
        "Durable Events",
        events
          .map((event) => `#${event.sequence}  ${event.type}\n    ${event.id}`)
          .join("\n") || "No Events",
      );
    } catch (error) {
      this.#notice(errorMessage(error));
    }
  }

  async #inspectState(replay: boolean): Promise<void> {
    const thread = this.#requireThread();
    if (thread === null) return;
    try {
      const state = replay ? await thread.replay() : await thread.state();
      this.#inspect(replay ? "Replay result" : "Authoritative state", json(state));
    } catch (error) {
      this.#notice(errorMessage(error));
    }
  }

  async #pause(): Promise<void> {
    const thread = this.#requireThread();
    if (thread === null) return;
    try {
      const state = await thread.pause();
      await this.#sync(thread, state);
      this.#showStableOutcome(state);
    } catch (error) {
      this.#notice(errorMessage(error));
    }
  }

  async #fork(input: string): Promise<void> {
    const thread = this.#requireThread();
    if (thread === null) return;
    if (this.#snapshot.busy) {
      this.#notice("Pause the active Thread before forking.");
      return;
    }
    const match = /^\/fork\s+(\S+)\s+([\s\S]+)$/.exec(input);
    const eventId = match?.[1];
    const forkInput = match?.[2]?.trim();
    if (eventId === undefined || forkInput === undefined || forkInput.length === 0) {
      this.#notice("Usage: /fork <event-id> <input>");
      return;
    }
    try {
      this.#beginWork();
      const child = await thread.fork({ at: eventId, input: forkInput });
      await this.#select(child);
      const state = await child.wait();
      await this.#sync(child, state);
      this.#showStableOutcome(state);
    } catch (error) {
      this.#notice(errorMessage(error), "ERROR", "danger");
    } finally {
      this.#endWork();
    }
  }

  async #ensureCurrent(): Promise<Thread> {
    if (this.#current !== null) return this.#current;
    if (this.#creating === null) {
      this.#creating = this.#harness.createThread().then(async (thread) => {
        await this.#select(thread);
        return thread;
      });
    }
    try {
      return await this.#creating;
    } finally {
      this.#creating = null;
    }
  }

  async #select(thread: Thread): Promise<ThreadState> {
    this.#observer?.abort();
    this.#observer = null;
    this.#resetStreaming();
    this.#resetToolOutput();
    this.#current = thread;
    const [events, state] = await Promise.all([thread.events(), thread.state()]);
    this.#events = events;
    this.#progressMessage = null;
    const projection = this.#projection();
    this.#patch({
      ...projection,
      currentThreadId: thread.id,
      inspection: null,
      metrics: state.metrics,
      streamingText: "",
      threadPickerOpen: false,
      threads: this.#snapshot.threads.map((summary) => ({
        ...summary,
        current: summary.id === thread.id,
      })),
      threadStatus: state.status,
      toolApproval: this.#currentApproval(state),
      toolLiveOutput: Object.freeze({}),
      toolOperations: state.status === "running" ? projection.toolOperations : [],
      workStatus: null,
    });
    this.#observe(thread);
    return state;
  }

  #observe(thread: Thread): void {
    const controller = new AbortController();
    this.#observer = controller;
    const fromSequence = (this.#events.at(-1)?.sequence ?? 0) + 1;
    void (async () => {
      try {
        for await (const item of thread.stream({
          fromSequence,
          signal: controller.signal,
        })) {
          if (this.#current?.id !== thread.id) return;
          if (item.kind === "event") {
            const updates: SnapshotUpdates = {};
            if (!this.#events.some((event) => event.id === item.event.id)) {
              this.#events = [...this.#events, item.event];
              Object.assign(updates, this.#projection());
            }
            if (item.event.type === "model.requested") {
              this.#progressMessage = null;
              this.#resetStreaming();
              updates.streamingText = "";
            } else if (item.event.type === "model.completed") {
              this.#resetStreaming();
              updates.streamingText = "";
            }
            if (
              item.event.type === "tool.completed" ||
              item.event.type === "tool.failed"
            ) {
              this.#discardToolOutput(item.event.payload.effectId);
              updates.toolLiveOutput = removeToolLiveOutput(
                this.#snapshot.toolLiveOutput,
                item.event.payload.effectId,
              );
            } else if (item.event.type === "context.cleared") {
              updates.toolLiveOutput = Object.freeze({});
            }
            const workStatus = workStatusForEvent(
              item.event,
              this.#progressMessage,
            );
            if (this.#snapshot.busy && workStatus !== null) {
              updates.workStatus = workStatus;
            }
            this.#patch(updates);
            continue;
          }
          const progress = signalProgress(item);
          if (progress !== null) {
            this.#progressMessage = progress;
            if (this.#snapshot.busy) {
              this.#patch({
                workStatus: {
                  label: progress,
                  phase: "thinking",
                  tone: "warning",
                },
              });
            }
            continue;
          }
          const toolOutput = signalToolOutput(item);
          if (toolOutput !== null) {
            const operation = this.#snapshot.toolOperations.find(
              (candidate) =>
                candidate.effectId === toolOutput.effectId &&
                candidate.name === toolOutput.name &&
                candidate.status === "running",
            );
            if (operation === undefined) continue;
            this.#queueToolOutput(toolOutput.effectId, toolOutput.delta);
            continue;
          }
          const delta = signalDelta(item);
          if (delta !== null) {
            this.#queueStreamDelta(delta);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.#notice(errorMessage(error), "ERROR", "danger");
        }
      }
    })();
  }

  async #sync(thread: Thread, state?: ThreadState): Promise<void> {
    if (this.#current?.id !== thread.id) return;
    const [events, currentState] = await Promise.all([
      thread.events(),
      state === undefined ? thread.state() : Promise.resolve(state),
    ]);
    this.#resetStreaming();
    const projection = sameEventLog(this.#events, events)
      ? {}
      : (() => {
          this.#events = events;
          return this.#projection();
        })();
    this.#patch({
      ...projection,
      metrics: currentState.metrics,
      streamingText: "",
      threadStatus: currentState.status,
      toolApproval: this.#currentApproval(currentState),
    });
  }

  #currentApproval(state: ThreadState): ToolApproval | null {
    return (
      Object.values(state.toolApprovals).find(
        (approval) => approval.decision === null,
      ) ?? null
    );
  }

  #showStableOutcome(state: ThreadState): void {
    if (state.status === "paused") {
      this.#notice("Thread paused. Use /continue when ready.");
    } else if (state.status === "waiting") {
      if (this.#currentApproval(state) === null) {
        this.#notice("Thread is waiting on an indeterminate external outcome.");
      }
    } else if (state.error !== null) {
      this.#notice(state.error.message, "ERROR", "danger");
    }
  }

  #requireThread(): Thread | null {
    if (this.#current !== null) return this.#current;
    this.#notice("Send a message or use /new to create a Thread.");
    return null;
  }

  #beginWork(): void {
    this.#inFlight += 1;
    this.#progressMessage = null;
    this.#resetStreaming();
    this.#patch({
      busy: true,
      inspection: null,
      streamingText: "",
      toolOperations:
        this.#snapshot.threadStatus === "running"
          ? this.#snapshot.toolOperations
          : [],
      workStatus: {
        label: "Thinking",
        phase: "thinking",
        tone: "warning",
      },
    });
  }

  #endWork(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (this.#inFlight === 0) this.#progressMessage = null;
    this.#resetStreaming();
    if (this.#inFlight === 0) this.#resetToolOutput();
    this.#patch({
      busy: this.#inFlight > 0,
      streamingText: "",
      toolOperations:
        this.#inFlight > 0 ? this.#snapshot.toolOperations : [],
      toolLiveOutput:
        this.#inFlight > 0 ? this.#snapshot.toolLiveOutput : Object.freeze({}),
      workStatus: this.#inFlight > 0 ? this.#snapshot.workStatus : null,
    });
  }

  #queueStreamDelta(delta: string): void {
    this.#streamBuffer += delta;
    if (this.#streamFlush !== null) return;
    this.#streamFlush = setTimeout(() => this.#flushStreaming(), STREAM_FRAME_MS);
  }

  #flushStreaming(): void {
    this.#streamFlush = null;
    if (this.#streamBuffer.length === 0) return;
    const delta = this.#streamBuffer;
    this.#streamBuffer = "";
    this.#patch({
      streamingText: `${this.#snapshot.streamingText}${delta}`,
      workStatus: {
        label: "Responding",
        phase: "responding",
        tone: "brand",
      },
    });
  }

  #resetStreaming(): void {
    if (this.#streamFlush !== null) clearTimeout(this.#streamFlush);
    this.#streamFlush = null;
    this.#streamBuffer = "";
  }

  #queueToolOutput(effectId: string, delta: string): void {
    this.#toolOutputBuffer.set(
      effectId,
      `${this.#toolOutputBuffer.get(effectId) ?? ""}${delta}`,
    );
    if (this.#toolOutputFlush !== null) return;
    this.#toolOutputFlush = setTimeout(
      () => this.#flushToolOutput(),
      STREAM_FRAME_MS,
    );
  }

  #flushToolOutput(): void {
    this.#toolOutputFlush = null;
    if (this.#toolOutputBuffer.size === 0) return;
    const toolLiveOutput = { ...this.#snapshot.toolLiveOutput };
    for (const [effectId, delta] of this.#toolOutputBuffer) {
      const operation = this.#snapshot.toolOperations.find(
        (candidate) =>
          candidate.effectId === effectId && candidate.status === "running",
      );
      if (operation === undefined) continue;
      toolLiveOutput[effectId] = appendToolLiveOutput(
        toolLiveOutput[effectId],
        delta,
      );
    }
    this.#toolOutputBuffer.clear();
    this.#patch({ toolLiveOutput });
  }

  #discardToolOutput(effectId: string): void {
    this.#toolOutputBuffer.delete(effectId);
    if (this.#toolOutputBuffer.size > 0 || this.#toolOutputFlush === null) return;
    clearTimeout(this.#toolOutputFlush);
    this.#toolOutputFlush = null;
  }

  #resetToolOutput(): void {
    if (this.#toolOutputFlush !== null) clearTimeout(this.#toolOutputFlush);
    this.#toolOutputFlush = null;
    this.#toolOutputBuffer.clear();
  }

  #projection(): Pick<
    ThreadControllerSnapshot,
    "activePlan" | "activity" | "toolOperations" | "transcript"
  > {
    const projected = projectThread(this.#events);
    this.#nextId = projected.nextId;
    return {
      activePlan: projected.activePlan,
      activity: projected.activity.slice(-200),
      toolOperations: projected.toolOperations,
      transcript: projected.transcript.slice(-200),
    };
  }

  #inspect(title: string, content: string): void {
    this.#patch({ inspection: Object.freeze({ content, title }) });
  }

  #notice(
    content: string,
    label = "JIXU",
    tone: JixuTone = "warning",
    role: TranscriptRole = "notice",
  ): void {
    const entry = Object.freeze({
      content,
      id: this.#nextId++,
      kind: "message" as const,
      label,
      role,
      tone,
    });
    this.#patch({ transcript: [...this.#snapshot.transcript, entry].slice(-200) });
  }

  #patch(updates: SnapshotUpdates): void {
    const activity =
      updates.activity === undefined
        ? this.#snapshot.activity
        : Object.freeze([...updates.activity]);
    const threads =
      updates.threads === undefined
        ? this.#snapshot.threads
        : Object.freeze([...updates.threads]);
    const toolOperations =
      updates.toolOperations === undefined
        ? this.#snapshot.toolOperations
        : Object.freeze([...updates.toolOperations]);
    const toolLiveOutput =
      updates.toolLiveOutput === undefined
        ? this.#snapshot.toolLiveOutput
        : Object.freeze({ ...updates.toolLiveOutput });
    const transcript =
      updates.transcript === undefined
        ? this.#snapshot.transcript
        : Object.freeze([...updates.transcript]);
    const next = Object.freeze({
      ...this.#snapshot,
      ...updates,
      activity,
      threads,
      toolLiveOutput,
      toolOperations,
      transcript,
    });
    const keys = Object.keys(next) as readonly (keyof ThreadControllerSnapshot)[];
    if (keys.every((key) => Object.is(next[key], this.#snapshot[key]))) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

export function createThreadController(
  config: ThreadControllerConfig,
): ThreadController {
  return new ThreadController(config);
}
