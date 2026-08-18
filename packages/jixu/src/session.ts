import { isJsonObject } from "@jixu/core";
import type {
  AgentDefinition,
  AnyRunEvent,
  RunHandle,
  RunState,
  RunStatus,
  Runtime,
  RunStreamItem,
} from "@jixu/core";

export type SessionTone =
  | "brand"
  | "danger"
  | "info"
  | "secondary"
  | "success"
  | "text"
  | "warning";

export type TranscriptRole = "assistant" | "notice" | "user";
export type ActivityKind = "control" | "model" | "runtime" | "tool";

export interface TranscriptEntry {
  readonly content: string;
  readonly id: number;
  readonly label: string;
  readonly role: TranscriptRole;
  readonly tone: SessionTone;
}

export interface ActivityEntry {
  readonly detail?: string;
  readonly eventId?: string;
  readonly id: number;
  readonly kind: ActivityKind;
  readonly label: string;
  readonly tone: SessionTone;
}

export interface SessionInspection {
  readonly content: string;
  readonly title: string;
}

export interface JixuSessionSnapshot {
  readonly activity: readonly ActivityEntry[];
  readonly busy: boolean;
  readonly currentRunId: string | null;
  readonly inspection: SessionInspection | null;
  readonly runStatus: RunStatus | "idle" | "starting";
  readonly streamingText: string;
  readonly transcript: readonly TranscriptEntry[];
}

export interface JixuSessionConfig {
  readonly agent: AgentDefinition;
  readonly onConfigure?: () => void;
  readonly onQuit?: () => void;
  readonly runtime: Runtime;
}

const HELP = [
  "/help                         Show these commands",
  "/events                       Inspect durable Events for the current Run",
  "/state                        Inspect the authoritative current state",
  "/pause                        Pause after the current dispatch boundary",
  "/resume                       Resume a paused Run",
  "/replay                       Rebuild state from durable Events only",
  "/fork <event-id> <input>      Continue from an earlier Event as a new Run",
  "/config                       Change API format, Base URL, Key, or model ID",
  "/quit                         Exit Jixu",
].join("\n");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Jixu error";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function terminal(status: RunStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}

function eventActivity(event: AnyRunEvent): Omit<ActivityEntry, "id"> {
  const base = { eventId: event.id };
  switch (event.type) {
    case "run.created":
      return { ...base, kind: "runtime", label: "Run started", tone: "brand" };
    case "run.forked":
      return {
        ...base,
        detail: `from ${event.payload.parentRunId}`,
        kind: "control",
        label: "Run forked",
        tone: "brand",
      };
    case "input.received":
      return { ...base, kind: "runtime", label: "Input committed", tone: "info" };
    case "model.requested":
      return {
        ...base,
        detail: event.payload.effect.input.model.model,
        kind: "model",
        label: "Thinking",
        tone: "warning",
      };
    case "model.completed":
      return {
        ...base,
        kind: "runtime",
        label: "Model response committed",
        tone: "success",
      };
    case "model.failed":
      return {
        ...base,
        detail: event.payload.error.code,
        kind: "model",
        label: "Model failed",
        tone: "danger",
      };
    case "tool.requested":
      return {
        ...base,
        detail: event.payload.effect.input.name,
        kind: "tool",
        label: "Calling tool",
        tone: "warning",
      };
    case "tool.completed":
      return {
        ...base,
        detail: event.payload.name,
        kind: "tool",
        label: "Tool completed",
        tone: "success",
      };
    case "tool.failed":
      return {
        ...base,
        detail: `${event.payload.name} · ${event.payload.error.code}`,
        kind: "tool",
        label: "Tool failed",
        tone: "danger",
      };
    case "run.pause_requested":
      return {
        ...base,
        kind: "control",
        label: "Pause requested",
        tone: "warning",
      };
    case "run.paused":
      return { ...base, kind: "control", label: "Run paused", tone: "warning" };
    case "run.resumed":
      return { ...base, kind: "control", label: "Run resumed", tone: "info" };
    case "run.waiting":
      return {
        ...base,
        detail: event.payload.reasonCode,
        kind: "control",
        label: "Human decision required",
        tone: "warning",
      };
  }
}

function signalDelta(item: RunStreamItem): string | null {
  if (
    item.kind !== "signal" ||
    item.type !== "model.output_text.delta" ||
    !isJsonObject(item.data)
  ) {
    return null;
  }
  return typeof item.data.delta === "string" ? item.data.delta : null;
}

export class JixuSession {
  readonly #agent: AgentDefinition;
  readonly #listeners = new Set<() => void>();
  readonly #onConfigure: () => void;
  readonly #onQuit: () => void;
  readonly #runtime: Runtime;
  readonly #sequences = new Map<string, number>();
  #current: RunHandle | null = null;
  #nextId = 1;
  #snapshot: JixuSessionSnapshot = Object.freeze({
    activity: Object.freeze([]),
    busy: false,
    currentRunId: null,
    inspection: null,
    runStatus: "idle",
    streamingText: "",
    transcript: Object.freeze([]),
  });

  constructor(config: JixuSessionConfig) {
    this.#agent = config.agent;
    this.#onConfigure = config.onConfigure ?? (() => undefined);
    this.#onQuit = config.onQuit ?? (() => undefined);
    this.#runtime = config.runtime;
  }

  readonly getSnapshot = (): JixuSessionSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async submit(rawInput: string): Promise<void> {
    const input = rawInput.trim();
    if (input.length === 0) return;
    if (input.startsWith("/")) {
      await this.#command(input);
      return;
    }
    if (this.#snapshot.busy) {
      this.#appendTranscript(
        "Wait for this Run or use /pause.",
        "JIXU",
        "notice",
        "warning",
      );
      return;
    }

    this.#patch({
      busy: true,
      currentRunId: null,
      inspection: null,
      runStatus: "starting",
      streamingText: "",
    });
    this.#appendTranscript(input, "YOU", "user", "brand");
    try {
      const run = await this.#runtime.run(this.#agent, input);
      this.#current = run;
      this.#patch({ currentRunId: run.id, runStatus: "running" });
      await this.#follow(run);
    } catch (error) {
      this.#fail(error);
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
          this.#appendTranscript(
            "Pause or finish the current Run before changing endpoint configuration.",
            "JIXU",
            "notice",
            "warning",
          );
          return;
        }
        this.#onConfigure();
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
      case "/resume":
        await this.#resume();
        return;
      case "/fork":
        await this.#fork(input);
        return;
      default:
        this.#appendTranscript(
          `Unknown command ${command}. Use /help.`,
          "JIXU",
          "notice",
          "warning",
        );
    }
  }

  async #inspectEvents(): Promise<void> {
    const run = this.#requireRun();
    if (run === null) return;
    try {
      const events = await run.events();
      const content = events
        .map((event) => `#${event.sequence}  ${event.type}\n    ${event.id}`)
        .join("\n");
      this.#inspect("Durable Events", content || "No Events");
    } catch (error) {
      this.#failCommand(error);
    }
  }

  async #inspectState(replay: boolean): Promise<void> {
    const run = this.#requireRun();
    if (run === null) return;
    try {
      const state = replay ? await run.replay() : await run.state();
      this.#inspect(replay ? "Replay result" : "Authoritative state", json(state));
    } catch (error) {
      this.#failCommand(error);
    }
  }

  async #pause(): Promise<void> {
    const run = this.#requireRun();
    if (run === null) return;
    try {
      const state = await run.pause();
      this.#patch({ runStatus: state.status });
      this.#appendActivity({
        kind: "control",
        label: `Run is ${state.status}`,
        tone: "warning",
      });
    } catch (error) {
      this.#failCommand(error);
    }
  }

  async #resume(): Promise<void> {
    const run = this.#requireRun();
    if (run === null) return;
    if (this.#snapshot.busy) {
      this.#appendTranscript(
        "The current Run is already active.",
        "JIXU",
        "notice",
        "warning",
      );
      return;
    }
    try {
      this.#patch({ busy: true, inspection: null, runStatus: "running" });
      const observer = this.#observe(run, new AbortController());
      await run.resume();
      await this.#finishFollow(run, observer);
    } catch (error) {
      this.#fail(error);
    }
  }

  async #fork(input: string): Promise<void> {
    const run = this.#requireRun();
    if (run === null) return;
    if (this.#snapshot.busy) {
      this.#appendTranscript(
        "Pause or finish the current Run before forking.",
        "JIXU",
        "notice",
        "warning",
      );
      return;
    }
    const match = /^\/fork\s+(\S+)\s+([\s\S]+)$/.exec(input);
    if (match === null) {
      this.#appendTranscript(
        "Usage: /fork <event-id> <input>",
        "JIXU",
        "notice",
        "warning",
      );
      return;
    }
    const eventId = match[1];
    const forkInput = match[2]?.trim();
    if (eventId === undefined || forkInput === undefined || forkInput.length === 0) {
      this.#appendTranscript(
        "Usage: /fork <event-id> <input>",
        "JIXU",
        "notice",
        "warning",
      );
      return;
    }
    try {
      this.#patch({ busy: true, inspection: null, streamingText: "" });
      this.#appendTranscript(forkInput, "YOU · FORK", "user", "brand");
      const fork = await run.fork({ at: eventId, input: forkInput });
      this.#current = fork;
      this.#patch({ currentRunId: fork.id, runStatus: "running" });
      await this.#follow(fork);
    } catch (error) {
      this.#fail(error);
    }
  }

  async #follow(run: RunHandle): Promise<void> {
    const controller = new AbortController();
    const observer = this.#observe(run, controller);
    await this.#finishFollow(run, observer);
  }

  async #finishFollow(
    run: RunHandle,
    observer: { readonly controller: AbortController; readonly done: Promise<void> },
  ): Promise<void> {
    let state: RunState;
    try {
      state = await run.wait();
    } finally {
      observer.controller.abort();
      await observer.done;
    }
    this.#complete(run, state);
  }

  #observe(
    run: RunHandle,
    controller: AbortController,
  ): { readonly controller: AbortController; readonly done: Promise<void> } {
    const fromSequence = (this.#sequences.get(run.id) ?? 0) + 1;
    const done = (async () => {
      for await (const item of run.stream({ fromSequence, signal: controller.signal })) {
        if (item.kind === "event") {
          this.#sequences.set(run.id, item.event.sequence);
          this.#appendActivity(eventActivity(item.event));
          continue;
        }
        const delta = signalDelta(item);
        if (delta !== null) {
          this.#patch({ streamingText: `${this.#snapshot.streamingText}${delta}` });
        }
      }
    })();
    return { controller, done };
  }

  #complete(run: RunHandle, state: RunState): void {
    if (this.#current?.id !== run.id) return;
    this.#patch({ busy: false, runStatus: state.status, streamingText: "" });
    if (state.status === "completed") {
      this.#appendTranscript(
        state.result ?? "(completed without text)",
        "JIXU",
        "assistant",
        "text",
      );
      return;
    }
    if (state.status === "paused") {
      this.#appendTranscript(
        "Run paused. Use /resume when ready.",
        "JIXU",
        "notice",
        "warning",
      );
      return;
    }
    if (state.status === "waiting") {
      this.#appendTranscript(
        "Run is waiting because a non-idempotent effect has an unknown outcome.",
        "JIXU",
        "notice",
        "warning",
      );
      return;
    }
    if (terminal(state.status)) {
      this.#appendTranscript(
        state.error?.message ?? `Run ended as ${state.status}.`,
        "ERROR",
        "notice",
        "danger",
      );
    }
  }

  #requireRun(): RunHandle | null {
    if (this.#current !== null) return this.#current;
    this.#appendTranscript("Start a Run first.", "JIXU", "notice", "warning");
    return null;
  }

  #inspect(title: string, content: string): void {
    this.#patch({ inspection: Object.freeze({ content, title }) });
  }

  #appendTranscript(
    content: string,
    label: string,
    role: TranscriptRole,
    tone: SessionTone,
  ): void {
    const entry = Object.freeze({ content, id: this.#nextId++, label, role, tone });
    this.#patch({ transcript: [...this.#snapshot.transcript, entry].slice(-200) });
  }

  #appendActivity(entry: Omit<ActivityEntry, "id">): void {
    const activity = Object.freeze({ ...entry, id: this.#nextId++ });
    this.#patch({ activity: [...this.#snapshot.activity, activity].slice(-200) });
  }

  #fail(error: unknown): void {
    this.#patch({ busy: false, runStatus: "failed", streamingText: "" });
    this.#appendTranscript(errorMessage(error), "ERROR", "notice", "danger");
  }

  #failCommand(error: unknown): void {
    this.#appendTranscript(errorMessage(error), "JIXU", "notice", "warning");
  }

  #patch(updates: Partial<JixuSessionSnapshot>): void {
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...updates,
      activity: Object.freeze([...(updates.activity ?? this.#snapshot.activity)]),
      transcript: Object.freeze([...(updates.transcript ?? this.#snapshot.transcript)]),
    });
    for (const listener of this.#listeners) listener();
  }
}

export function createJixuSession(config: JixuSessionConfig): JixuSession {
  return new JixuSession(config);
}
