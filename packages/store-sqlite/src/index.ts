import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS checkpoints (
        run_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      ) STRICT;
    `);
  }

  close(): void {
    this.#database.close();
  }

  #hasRun(runId: string): boolean {
    return this.#database
      .prepare("SELECT 1 AS present FROM runs WHERE run_id = ?")
      .get(runId) !== undefined;
  }

  #revision(runId: string): number {
    const row = record(
      this.#database
        .prepare("SELECT COUNT(*) AS revision FROM events WHERE run_id = ?")
        .get(runId),
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

  async createRun(runId: string): Promise<void> {
    this.#transaction(() => {
      if (this.#hasRun(runId)) {
        throw new RunAlreadyExistsError(runId);
      }
      this.#database.prepare("INSERT INTO runs(run_id) VALUES (?)").run(runId);
    });
  }

  async createFork(
    runId: string,
    events: readonly AnyRunEvent[],
  ): Promise<void> {
    this.#transaction(() => {
      if (this.#hasRun(runId)) {
        throw new RunAlreadyExistsError(runId);
      }
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
        if (localIds.has(decoded.id)) {
          throw new InvalidTransitionError(`Event ID ${decoded.id} is duplicated`);
        }
        localIds.add(decoded.id);
        return decoded;
      });
      replayEvents(runId, validated);
      this.#database.prepare("INSERT INTO runs(run_id) VALUES (?)").run(runId);
      const insert = this.#database.prepare(
        "INSERT INTO events(run_id, sequence, event_id, event_json) VALUES (?, ?, ?, ?)",
      );
      for (const event of validated) {
        insert.run(runId, event.sequence, event.id, JSON.stringify(event));
      }
    });
  }

  async append(
    runId: string,
    expectedRevision: number,
    event: AnyRunEvent,
  ): Promise<void> {
    this.#transaction(() => {
      if (!this.#hasRun(runId)) {
        throw new RunNotFoundError(runId);
      }
      const actualRevision = this.#revision(runId);
      if (actualRevision !== expectedRevision) {
        throw new RevisionConflictError(
          runId,
          expectedRevision,
          actualRevision,
        );
      }
      const decoded = decodeRunEvent(event);
      if (decoded.runId !== runId || decoded.sequence !== expectedRevision + 1) {
        throw new InvalidTransitionError(
          `Event ${decoded.id} does not continue Run ${runId}`,
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
          "INSERT INTO events(run_id, sequence, event_id, event_json) VALUES (?, ?, ?, ?)",
        )
        .run(runId, decoded.sequence, decoded.id, JSON.stringify(decoded));
    });
  }

  async read(
    runId: string,
    fromSequence = 1,
  ): Promise<readonly AnyRunEvent[]> {
    if (!this.#hasRun(runId)) {
      throw new RunNotFoundError(runId);
    }
    return this.#database
      .prepare(
        "SELECT event_json FROM events WHERE run_id = ? AND sequence >= ? ORDER BY sequence",
      )
      .all(runId, fromSequence)
      .map((value) => {
        const row = record(value, "Event row");
        return decodeRunEvent(JSON.parse(string(row.event_json, "event_json")) as unknown);
      });
  }

  async listNonTerminalRuns(): Promise<readonly string[]> {
    const rows = this.#database
      .prepare("SELECT run_id FROM runs ORDER BY run_id")
      .all();
    const result: string[] = [];
    for (const value of rows) {
      const row = record(value, "Run row");
      const runId = string(row.run_id, "run_id");
      const events = await this.read(runId);
      if (events.length === 0) {
        continue;
      }
      const status = replayEvents(runId, events).status;
      if (status !== "cancelled" && status !== "completed" && status !== "failed") {
        result.push(runId);
      }
    }
    return result;
  }

  async readCheckpoint(runId: string): Promise<Checkpoint | null> {
    if (!this.#hasRun(runId)) {
      throw new RunNotFoundError(runId);
    }
    const value = this.#database
      .prepare("SELECT checkpoint_json FROM checkpoints WHERE run_id = ?")
      .get(runId);
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
      if (!this.#hasRun(checkpoint.runId)) {
        throw new RunNotFoundError(checkpoint.runId);
      }
      const decoded = decodeCheckpoint(checkpoint);
      this.#database
        .prepare(`
          INSERT INTO checkpoints(run_id, checkpoint_json) VALUES (?, ?)
          ON CONFLICT(run_id) DO UPDATE SET checkpoint_json = excluded.checkpoint_json
        `)
        .run(decoded.runId, JSON.stringify(decoded));
    });
  }
}
