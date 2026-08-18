import {
  access,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  decodeCheckpoint,
  decodeRunEvent,
  InvalidTransitionError,
  replayEvents,
  RevisionConflictError,
  RunAlreadyExistsError,
  RunNotFoundError,
} from "../../core/src/index.ts";
import type {
  AnyRunEvent,
  Checkpoint,
  EventStore,
} from "../../core/src/index.ts";

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function runFileName(runId: string): string {
  return `${encodeURIComponent(runId)}.jsonl`;
}

function runIdFromFileName(fileName: string): string {
  return decodeURIComponent(fileName.slice(0, -".jsonl".length));
}

export class JsonlEventStore implements EventStore {
  readonly #checkpointDirectory: string;
  readonly #eventIds = new Set<string>();
  readonly #initialization: Promise<void>;
  readonly #runDirectory: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.#runDirectory = join(directory, "runs");
    this.#checkpointDirectory = join(directory, "checkpoints");
    this.#initialization = this.#initialize();
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#runDirectory, { recursive: true });
    await mkdir(this.#checkpointDirectory, { recursive: true });
    const entries = await readdir(this.#runDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const runId = runIdFromFileName(entry.name);
      for (const event of await this.#readEvents(runId)) {
        if (this.#eventIds.has(event.id)) {
          throw new InvalidTransitionError(`Event ID ${event.id} is duplicated`);
        }
        this.#eventIds.add(event.id);
      }
    }
  }

  async #withWriteLock<TValue>(
    operation: () => Promise<TValue>,
  ): Promise<TValue> {
    const current = this.#writeTail.then(operation);
    this.#writeTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  #runPath(runId: string): string {
    return join(this.#runDirectory, runFileName(runId));
  }

  #checkpointPath(runId: string): string {
    return join(this.#checkpointDirectory, `${encodeURIComponent(runId)}.json`);
  }

  async #writeNew(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #replace(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #readEvents(runId: string): Promise<readonly AnyRunEvent[]> {
    let source: string;
    try {
      source = await readFile(this.#runPath(runId), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new RunNotFoundError(runId);
      }
      throw error;
    }
    if (source.trim().length === 0) {
      return [];
    }
    return source
      .trimEnd()
      .split("\n")
      .map((line) => decodeRunEvent(JSON.parse(line) as unknown));
  }

  async createRun(runId: string): Promise<void> {
    await this.#initialization;
    await this.#withWriteLock(async () => {
      try {
        await this.#writeNew(this.#runPath(runId), "");
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new RunAlreadyExistsError(runId);
        }
        throw error;
      }
    });
  }

  async createFork(
    runId: string,
    events: readonly AnyRunEvent[],
  ): Promise<void> {
    await this.#initialization;
    await this.#withWriteLock(async () => {
      if (events.length === 0) {
        throw new InvalidTransitionError(`Fork ${runId} must contain Events`);
      }
      const localIds = new Set<string>();
      const validated = events.map((event, index) => {
        const decoded = decodeRunEvent(event);
        if (decoded.runId !== runId || decoded.sequence !== index + 1) {
          throw new InvalidTransitionError(
            `Fork Event ${decoded.id} is not contiguous for Run ${runId}`,
          );
        }
        if (this.#eventIds.has(decoded.id) || localIds.has(decoded.id)) {
          throw new InvalidTransitionError(`Event ID ${decoded.id} is duplicated`);
        }
        localIds.add(decoded.id);
        return decoded;
      });
      replayEvents(runId, validated);
      const contents = `${validated.map((event) => JSON.stringify(event)).join("\n")}\n`;
      try {
        await this.#writeNew(this.#runPath(runId), contents);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new RunAlreadyExistsError(runId);
        }
        throw error;
      }
      for (const id of localIds) {
        this.#eventIds.add(id);
      }
    });
  }

  async append(
    runId: string,
    expectedRevision: number,
    event: AnyRunEvent,
  ): Promise<void> {
    await this.#initialization;
    await this.#withWriteLock(async () => {
      const events = await this.#readEvents(runId);
      if (events.length !== expectedRevision) {
        throw new RevisionConflictError(runId, expectedRevision, events.length);
      }
      const decoded = decodeRunEvent(event);
      if (decoded.runId !== runId || decoded.sequence !== expectedRevision + 1) {
        throw new InvalidTransitionError(
          `Event ${decoded.id} does not continue Run ${runId}`,
        );
      }
      if (this.#eventIds.has(decoded.id)) {
        throw new InvalidTransitionError(`Event ID ${decoded.id} is already stored`);
      }
      const contents = `${events.map((item) => JSON.stringify(item)).join("\n")}${
        events.length === 0 ? "" : "\n"
      }${JSON.stringify(decoded)}\n`;
      await this.#replace(this.#runPath(runId), contents);
      this.#eventIds.add(decoded.id);
    });
  }

  async read(
    runId: string,
    fromSequence = 1,
  ): Promise<readonly AnyRunEvent[]> {
    await this.#initialization;
    return (await this.#readEvents(runId)).filter(
      (event) => event.sequence >= fromSequence,
    );
  }

  async listNonTerminalRuns(): Promise<readonly string[]> {
    await this.#initialization;
    const entries = await readdir(this.#runDirectory, { withFileTypes: true });
    const runIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const runId = runIdFromFileName(entry.name);
      const events = await this.#readEvents(runId);
      if (events.length === 0) {
        continue;
      }
      const status = replayEvents(runId, events).status;
      if (status !== "cancelled" && status !== "completed" && status !== "failed") {
        runIds.push(runId);
      }
    }
    return runIds.sort();
  }

  async readCheckpoint(runId: string): Promise<Checkpoint | null> {
    await this.#initialization;
    try {
      await access(this.#runPath(runId));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new RunNotFoundError(runId);
      }
      throw error;
    }
    try {
      return decodeCheckpoint(
        JSON.parse(await readFile(this.#checkpointPath(runId), "utf8")) as unknown,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.#initialization;
    await this.#withWriteLock(async () => {
      try {
        await access(this.#runPath(checkpoint.runId));
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw new RunNotFoundError(checkpoint.runId);
        }
        throw error;
      }
      const decoded = decodeCheckpoint(checkpoint);
      await this.#replace(
        this.#checkpointPath(decoded.runId),
        `${JSON.stringify(decoded)}\n`,
      );
    });
  }
}
