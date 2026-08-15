import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  decodeCheckpoint,
  decodeThreadEvent,
  ArtifactError,
  assertArtifactBytes,
  assertArtifactReference,
  InvalidTransitionError,
  replayEvents,
  RevisionConflictError,
  ThreadAlreadyExistsError,
  ThreadNotFoundError,
} from "jixu-core";
import type {
  AnyThreadEvent,
  ArtifactReference,
  Checkpoint,
  EventStore,
} from "jixu-core";

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`${label} must be a number`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

export class SqliteEventStore implements EventStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#database = new DatabaseSync(path, { timeout: 5_000 });
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        thread_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        PRIMARY KEY (thread_id, sequence),
        FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_digest TEXT PRIMARY KEY,
        artifact_bytes BLOB NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.#database.close();
  }

  #hasThread(threadId: string): boolean {
    return this.#database
      .prepare("SELECT 1 AS present FROM threads WHERE thread_id = ?")
      .get(threadId) !== undefined;
  }

  #revision(threadId: string): number {
    const row = record(
      this.#database
        .prepare("SELECT COUNT(*) AS revision FROM events WHERE thread_id = ?")
        .get(threadId),
      "revision row",
    );
    return number(row.revision, "revision");
  }

  #transaction<TValue>(operation: () => TValue): TValue {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async putArtifact(
    reference: ArtifactReference,
    bytes: Uint8Array,
  ): Promise<void> {
    await assertArtifactBytes(reference, bytes);
    this.#database
      .prepare(
        "INSERT OR IGNORE INTO artifacts(artifact_digest, artifact_bytes) VALUES (?, ?)",
      )
      .run(reference.digest, bytes);
    await this.readArtifact(reference);
  }

  async readArtifact(reference: ArtifactReference): Promise<Uint8Array> {
    assertArtifactReference(reference);
    const value = this.#database
      .prepare(
        "SELECT artifact_bytes FROM artifacts WHERE artifact_digest = ?",
      )
      .get(reference.digest);
    if (value === undefined) {
      throw new ArtifactError(
        "artifact_missing",
        `Image Artifact ${reference.digest} does not exist`,
      );
    }
    const bytes = record(value, "Artifact row").artifact_bytes;
    if (!(bytes instanceof Uint8Array)) {
      throw new ArtifactError(
        "artifact_corrupt",
        `Image Artifact ${reference.digest} is not binary data`,
      );
    }
    const owned = Uint8Array.from(bytes);
    await assertArtifactBytes(reference, owned);
    return owned;
  }

  async createThread(threadId: string): Promise<void> {
    this.#transaction(() => {
      if (this.#hasThread(threadId)) {
        throw new ThreadAlreadyExistsError(threadId);
      }
      this.#database
        .prepare("INSERT INTO threads(thread_id) VALUES (?)")
        .run(threadId);
    });
  }

  async createFork(
    threadId: string,
    events: readonly AnyThreadEvent[],
  ): Promise<void> {
    this.#transaction(() => {
      if (this.#hasThread(threadId)) {
        throw new ThreadAlreadyExistsError(threadId);
      }
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
        if (localIds.has(decoded.id)) {
          throw new InvalidTransitionError(`Event ID ${decoded.id} is duplicated`);
        }
        localIds.add(decoded.id);
        return decoded;
      });
      replayEvents(threadId, validated);
      this.#database
        .prepare("INSERT INTO threads(thread_id) VALUES (?)")
        .run(threadId);
      const insert = this.#database.prepare(
        "INSERT INTO events(thread_id, sequence, event_id, event_json) VALUES (?, ?, ?, ?)",
      );
      for (const event of validated) {
        insert.run(threadId, event.sequence, event.id, JSON.stringify(event));
      }
    });
  }

  async append(
    threadId: string,
    expectedRevision: number,
    event: AnyThreadEvent,
  ): Promise<void> {
    this.#transaction(() => {
      if (!this.#hasThread(threadId)) {
        throw new ThreadNotFoundError(threadId);
      }
      const actualRevision = this.#revision(threadId);
      if (actualRevision !== expectedRevision) {
        throw new RevisionConflictError(
          threadId,
          expectedRevision,
          actualRevision,
        );
      }
      const decoded = decodeThreadEvent(event);
      if (decoded.threadId !== threadId || decoded.sequence !== expectedRevision + 1) {
        throw new InvalidTransitionError(
          `Event ${decoded.id} does not continue Thread ${threadId}`,
        );
      }
      if (
        this.#database
          .prepare("SELECT 1 AS present FROM events WHERE event_id = ?")
          .get(decoded.id) !== undefined
      ) {
        throw new InvalidTransitionError(`Event ID ${decoded.id} is already stored`);
      }
      this.#database
        .prepare(
          "INSERT INTO events(thread_id, sequence, event_id, event_json) VALUES (?, ?, ?, ?)",
        )
        .run(threadId, decoded.sequence, decoded.id, JSON.stringify(decoded));
    });
  }

  async read(
    threadId: string,
    fromSequence = 1,
  ): Promise<readonly AnyThreadEvent[]> {
    if (!this.#hasThread(threadId)) {
      throw new ThreadNotFoundError(threadId);
    }
    return this.#database
      .prepare(
        "SELECT event_json FROM events WHERE thread_id = ? AND sequence >= ? ORDER BY sequence",
      )
      .all(threadId, fromSequence)
      .map((value) => {
        const row = record(value, "Event row");
        return decodeThreadEvent(JSON.parse(string(row.event_json, "event_json")) as unknown);
      });
  }

  async listThreads(): Promise<readonly string[]> {
    const rows = this.#database
      .prepare("SELECT thread_id FROM threads ORDER BY thread_id")
      .all();
    const result: string[] = [];
    for (const value of rows) {
      const row = record(value, "Thread row");
      const threadId = string(row.thread_id, "thread_id");
      const events = await this.read(threadId);
      if (events.length === 0) {
        continue;
      }
      result.push(threadId);
    }
    return result;
  }

  async readCheckpoint(threadId: string): Promise<Checkpoint | null> {
    if (!this.#hasThread(threadId)) {
      throw new ThreadNotFoundError(threadId);
    }
    const value = this.#database
      .prepare("SELECT checkpoint_json FROM checkpoints WHERE thread_id = ?")
      .get(threadId);
    if (value === undefined) {
      return null;
    }
    const row = record(value, "Checkpoint row");
    return decodeCheckpoint(
      JSON.parse(string(row.checkpoint_json, "checkpoint_json")) as unknown,
    );
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    this.#transaction(() => {
      if (!this.#hasThread(checkpoint.threadId)) {
        throw new ThreadNotFoundError(checkpoint.threadId);
      }
      const decoded = decodeCheckpoint(checkpoint);
      this.#database
        .prepare(`
          INSERT INTO checkpoints(thread_id, checkpoint_json) VALUES (?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET checkpoint_json = excluded.checkpoint_json
        `)
        .run(decoded.threadId, JSON.stringify(decoded));
    });
  }
}
