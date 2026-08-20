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
  decodeThreadEvent,
  InvalidTransitionError,
  replayEvents,
  RevisionConflictError,
  ThreadAlreadyExistsError,
  ThreadNotFoundError,
} from "jixu-core";
import type {
  AnyThreadEvent,
  Checkpoint,
  EventStore,
} from "jixu-core";

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function threadFileName(threadId: string): string {
  return `${encodeURIComponent(threadId)}.jsonl`;
}

function threadIdFromFileName(fileName: string): string {
  return decodeURIComponent(fileName.slice(0, -".jsonl".length));
}

export class JsonlEventStore implements EventStore {
  readonly #checkpointDirectory: string;
  readonly #eventIds = new Set<string>();
  readonly #initialization: Promise<void>;
  readonly #threadDirectory: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.#threadDirectory = join(directory, "threads");
    this.#checkpointDirectory = join(directory, "checkpoints");
    this.#initialization = this.#initialize();
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#threadDirectory, { recursive: true });
    await mkdir(this.#checkpointDirectory, { recursive: true });
    const entries = await readdir(this.#threadDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const threadId = threadIdFromFileName(entry.name);
      for (const event of await this.#readEvents(threadId)) {
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

  #threadPath(threadId: string): string {
    return join(this.#threadDirectory, threadFileName(threadId));
  }

  #checkpointPath(threadId: string): string {
    return join(this.#checkpointDirectory, `${encodeURIComponent(threadId)}.json`);
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

  async #readEvents(threadId: string): Promise<readonly AnyThreadEvent[]> {
    let source: string;
    try {
      source = await readFile(this.#threadPath(threadId), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ThreadNotFoundError(threadId);
      }
      throw error;
    }
    if (source.trim().length === 0) {
      return [];
    }
    return source
      .trimEnd()
      .split("\n")
      .map((line) => decodeThreadEvent(JSON.parse(line) as unknown));
  }

  async createThread(threadId: string): Promise<void> {
    await this.#initialization;
    await this.#withWriteLock(async () => {
      try {
        await this.#writeNew(this.#threadPath(threadId), "");
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new ThreadAlreadyExistsError(threadId);
        }
        throw error;
      }
    });
  }

  async createFork(
    threadId: string,
    events: readonly AnyThreadEvent[],
  ): Promise<void> {
    await this.#initialization;
    await this.#withWriteLock(async () => {
      if (events.length === 0) {
        throw new InvalidTransitionError(`Fork ${threadId} must contain Events`);
      }
      const localIds = new Set<string>();
      const validated = events.map((event, index) => {
        const decoded = decodeThreadEvent(event);
        if (decoded.threadId !== threadId || decoded.sequence !== index + 1) {
          throw new InvalidTransitionError(
            `Fork Event ${decoded.id} is not contiguous for Thread ${threadId}`,
          );
        }
        if (this.#eventIds.has(decoded.id) || localIds.has(decoded.id)) {
          throw new InvalidTransitionError(`Event ID ${decoded.id} is duplicated`);
        }
        localIds.add(decoded.id);
        return decoded;
      });
      replayEvents(threadId, validated);
      const contents = `${validated.map((event) => JSON.stringify(event)).join("\n")}\n`;
      try {
        await this.#writeNew(this.#threadPath(threadId), contents);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new ThreadAlreadyExistsError(threadId);
        }
        throw error;
      }
      for (const id of localIds) {
        this.#eventIds.add(id);
      }
    });
  }

  async append(
    threadId: string,
    expectedRevision: number,
    event: AnyThreadEvent,
  ): Promise<void> {
    await this.#initialization;
    await this.#withWriteLock(async () => {
      const events = await this.#readEvents(threadId);
      if (events.length !== expectedRevision) {
        throw new RevisionConflictError(threadId, expectedRevision, events.length);
      }
      const decoded = decodeThreadEvent(event);
      if (decoded.threadId !== threadId || decoded.sequence !== expectedRevision + 1) {
        throw new InvalidTransitionError(
          `Event ${decoded.id} does not continue Thread ${threadId}`,
        );
      }
      if (this.#eventIds.has(decoded.id)) {
        throw new InvalidTransitionError(`Event ID ${decoded.id} is already stored`);
      }
      const contents = `${events.map((item) => JSON.stringify(item)).join("\n")}${
        events.length === 0 ? "" : "\n"
      }${JSON.stringify(decoded)}\n`;
      await this.#replace(this.#threadPath(threadId), contents);
      this.#eventIds.add(decoded.id);
    });
  }

  async read(
    threadId: string,
    fromSequence = 1,
  ): Promise<readonly AnyThreadEvent[]> {
    await this.#initialization;
    return (await this.#readEvents(threadId)).filter(
      (event) => event.sequence >= fromSequence,
    );
  }

  async listThreads(): Promise<readonly string[]> {
    await this.#initialization;
    const entries = await readdir(this.#threadDirectory, { withFileTypes: true });
    const threadIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const threadId = threadIdFromFileName(entry.name);
      const events = await this.#readEvents(threadId);
      if (events.length === 0) {
        continue;
      }
      threadIds.push(threadId);
    }
    return threadIds.sort();
  }

  async readCheckpoint(threadId: string): Promise<Checkpoint | null> {
    await this.#initialization;
    try {
      await access(this.#threadPath(threadId));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ThreadNotFoundError(threadId);
      }
      throw error;
    }
    try {
      return decodeCheckpoint(
        JSON.parse(await readFile(this.#checkpointPath(threadId), "utf8")) as unknown,
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
        await access(this.#threadPath(checkpoint.threadId));
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw new ThreadNotFoundError(checkpoint.threadId);
        }
        throw error;
      }
      const decoded = decodeCheckpoint(checkpoint);
      await this.#replace(
        this.#checkpointPath(decoded.threadId),
        `${JSON.stringify(decoded)}\n`,
      );
    });
  }
}
