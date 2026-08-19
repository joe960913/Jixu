import { spawn } from "node:child_process";
import {
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  assertJsonValue,
  cloneJson,
  defineSchema,
  defineTool,
  ToolExecutionError,
} from "@jixu/core";
import type {
  ExecutableTool,
  JsonObject,
  JsonValue,
  Tool,
} from "@jixu/core";

type ReadInput = { readonly path: string };
type ReadOutput = {
  readonly content: string;
  readonly path: string;
  readonly truncated: boolean;
};
type WriteInput = { readonly content: string; readonly path: string };
type WriteOutput = { readonly bytes: number; readonly path: string };
type EditInput = {
  readonly newText: string;
  readonly oldText: string;
  readonly path: string;
  readonly replaceAll?: boolean;
};
type EditOutput = {
  readonly path: string;
  readonly replacements: number;
};
type BashInput = { readonly command: string; readonly timeoutMs?: number };
type BashOutput = {
  readonly cancelled: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
};

export interface NodeToolsConfig {
  readonly bashTimeoutMs?: number;
  readonly filesystemScope?: "process" | "workspace";
  readonly maxBashTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxReadBytes?: number;
  readonly root: string;
  readonly shell?: boolean | string;
}

export interface NodeTools {
  readonly all: readonly ExecutableTool[];
  readonly bash: Tool<BashInput, BashOutput>;
  readonly edit: Tool<EditInput, EditOutput>;
  readonly read: Tool<ReadInput, ReadOutput>;
  readonly write: Tool<WriteInput, WriteOutput>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`${label}.${unknown} is unknown`);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string") throw new TypeError(`${label}.${key} must be a string`);
  return field;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function outputSchema<TValue extends JsonValue>(
  jsonSchema: JsonObject,
  parse: (value: Record<string, unknown>) => TValue,
) {
  return defineSchema<TValue>({
    jsonSchema,
    parse(value) {
      return parse(object(value, "Tool output"));
    },
  });
}

const readInput = defineSchema<ReadInput>({
  jsonSchema: {
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"],
    type: "object",
  },
  parse(value) {
    const input = object(value, "read input");
    onlyKeys(input, ["path"], "read input");
    return { path: requiredString(input, "path", "read input") };
  },
});

const readOutput = outputSchema<ReadOutput>(
  {
    additionalProperties: false,
    properties: {
      content: { type: "string" },
      path: { type: "string" },
      truncated: { type: "boolean" },
    },
    required: ["path", "content", "truncated"],
    type: "object",
  },
  (value) => {
    if (typeof value.truncated !== "boolean") {
      throw new TypeError("Tool output.truncated must be a boolean");
    }
    return {
      content: requiredString(value, "content", "Tool output"),
      path: requiredString(value, "path", "Tool output"),
      truncated: value.truncated,
    };
  },
);

const writeInput = defineSchema<WriteInput>({
  jsonSchema: {
    additionalProperties: false,
    properties: { content: { type: "string" }, path: { type: "string" } },
    required: ["path", "content"],
    type: "object",
  },
  parse(value) {
    const input = object(value, "write input");
    onlyKeys(input, ["content", "path"], "write input");
    return {
      content: requiredString(input, "content", "write input"),
      path: requiredString(input, "path", "write input"),
    };
  },
});

const writeOutput = outputSchema<WriteOutput>(
  {
    additionalProperties: false,
    properties: { bytes: { type: "integer" }, path: { type: "string" } },
    required: ["path", "bytes"],
    type: "object",
  },
  (value) => ({
    bytes: nonnegativeInteger(value.bytes, "Tool output.bytes"),
    path: requiredString(value, "path", "Tool output"),
  }),
);

const editInput = defineSchema<EditInput>({
  jsonSchema: {
    additionalProperties: false,
    properties: {
      newText: { type: "string" },
      oldText: { minLength: 1, type: "string" },
      path: { type: "string" },
      replaceAll: { type: "boolean" },
    },
    required: ["path", "oldText", "newText"],
    type: "object",
  },
  parse(value) {
    const input = object(value, "edit input");
    onlyKeys(input, ["newText", "oldText", "path", "replaceAll"], "edit input");
    const oldText = requiredString(input, "oldText", "edit input");
    if (oldText.length === 0) throw new TypeError("edit input.oldText must not be empty");
    if (input.replaceAll !== undefined && typeof input.replaceAll !== "boolean") {
      throw new TypeError("edit input.replaceAll must be a boolean");
    }
    return {
      newText: requiredString(input, "newText", "edit input"),
      oldText,
      path: requiredString(input, "path", "edit input"),
      ...(input.replaceAll === undefined ? {} : { replaceAll: input.replaceAll }),
    };
  },
});

const editOutput = outputSchema<EditOutput>(
  {
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      replacements: { minimum: 1, type: "integer" },
    },
    required: ["path", "replacements"],
    type: "object",
  },
  (value) => ({
    path: requiredString(value, "path", "Tool output"),
    replacements: positiveInteger(value.replacements, "Tool output.replacements"),
  }),
);

const bashInput = defineSchema<BashInput>({
  jsonSchema: {
    additionalProperties: false,
    properties: {
      command: { minLength: 1, type: "string" },
      timeoutMs: { minimum: 1, type: "integer" },
    },
    required: ["command"],
    type: "object",
  },
  parse(value) {
    const input = object(value, "bash input");
    onlyKeys(input, ["command", "timeoutMs"], "bash input");
    const command = requiredString(input, "command", "bash input");
    if (command.trim().length === 0) throw new TypeError("bash input.command must not be empty");
    return {
      command,
      ...(input.timeoutMs === undefined
        ? {}
        : { timeoutMs: positiveInteger(input.timeoutMs, "bash input.timeoutMs") }),
    };
  },
});

const bashOutput = outputSchema<BashOutput>(
  {
    additionalProperties: false,
    properties: {
      cancelled: { type: "boolean" },
      exitCode: { type: ["integer", "null"] },
      signal: { type: ["string", "null"] },
      stderr: { type: "string" },
      stdout: { type: "string" },
      timedOut: { type: "boolean" },
      truncated: { type: "boolean" },
    },
    required: [
      "stdout",
      "stderr",
      "exitCode",
      "signal",
      "timedOut",
      "cancelled",
      "truncated",
    ],
    type: "object",
  },
  (value) => {
    for (const key of ["cancelled", "timedOut", "truncated"] as const) {
      if (typeof value[key] !== "boolean") {
        throw new TypeError(`Tool output.${key} must be a boolean`);
      }
    }
    if (value.exitCode !== null && !Number.isInteger(value.exitCode)) {
      throw new TypeError("Tool output.exitCode must be an integer or null");
    }
    if (value.signal !== null && typeof value.signal !== "string") {
      throw new TypeError("Tool output.signal must be a string or null");
    }
    return {
      cancelled: value.cancelled as boolean,
      exitCode: value.exitCode as number | null,
      signal: value.signal as string | null,
      stderr: requiredString(value, "stderr", "Tool output"),
      stdout: requiredString(value, "stdout", "Tool output"),
      timedOut: value.timedOut as boolean,
      truncated: value.truncated as boolean,
    };
  },
);

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function displayPath(root: string, absolute: string): string {
  if (!within(root, absolute)) return absolute;
  return (relative(root, absolute) || ".").split(sep).join("/");
}

class WorkspacePaths {
  readonly root: string;
  readonly #scope: "process" | "workspace";

  constructor(root: string, scope: "process" | "workspace") {
    this.root = realpathSync(resolve(root));
    this.#scope = scope;
    if (!statSync(this.root).isDirectory()) {
      throw new TypeError(`Node Tools root is not a directory: ${this.root}`);
    }
  }

  async existing(path: string): Promise<{ absolute: string; path: string }> {
    const candidate = this.#lexical(path);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      if (recordErrorCode(error) === "ENOENT") {
        throw new ToolExecutionError(
          "tool_path_not_found",
          `Path does not exist: ${path}`,
        );
      }
      throw new ToolExecutionError(
        "tool_path_unavailable",
        `Path is not accessible: ${path}`,
      );
    }
    this.#assertWithin(resolved, path);
    return { absolute: candidate, path: displayPath(this.root, candidate) };
  }

  async writable(path: string): Promise<{ absolute: string; path: string }> {
    const candidate = this.#lexical(path);
    try {
      const resolved = await realpath(candidate);
      this.#assertWithin(resolved, path);
      return { absolute: candidate, path: displayPath(this.root, candidate) };
    } catch (error) {
      if (recordErrorCode(error) !== "ENOENT") throw error;
    }

    try {
      await lstat(candidate);
      throw new ToolExecutionError(
        "tool_path_unresolved_link",
        `Refusing to write through an unresolved link: ${path}`,
      );
    } catch (error) {
      if (recordErrorCode(error) !== "ENOENT") throw error;
    }

    const parent = dirname(candidate);
    await this.#assertExistingAncestor(parent, path);
    await mkdir(parent, { recursive: true });
    this.#assertWithin(await realpath(parent), path);
    return { absolute: candidate, path: displayPath(this.root, candidate) };
  }

  #lexical(path: string): string {
    if (path.length === 0) {
      throw new ToolExecutionError(
        "tool_path_invalid",
        "Tool path must not be empty",
      );
    }
    const candidate = resolve(this.root, path);
    this.#assertWithin(candidate, path);
    return candidate;
  }

  #assertWithin(candidate: string, input: string): void {
    if (this.#scope === "process") return;
    if (!within(this.root, candidate)) {
      throw new ToolExecutionError(
        "tool_path_outside_scope",
        `Path escapes the workspace scope: ${input}`,
      );
    }
  }

  async #assertExistingAncestor(start: string, input: string): Promise<void> {
    let candidate = start;
    while (true) {
      try {
        this.#assertWithin(await realpath(candidate), input);
        return;
      } catch (error) {
        if (recordErrorCode(error) !== "ENOENT") throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new ToolExecutionError(
          "tool_path_unavailable",
          `No writable ancestor for ${input}`,
        );
      }
      candidate = parent;
    }
  }
}

function recordErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = content.indexOf(search, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + search.length;
  }
}

async function readBounded(path: string, limit: number): Promise<{ content: string; truncated: boolean }> {
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError("read only supports regular files");
  const length = Math.min(info.size, limit + 1);
  const buffer = Buffer.alloc(length);
  const file = await open(path, "r");
  try {
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return {
      content: buffer.subarray(0, Math.min(bytesRead, limit)).toString("utf8"),
      truncated: bytesRead > limit || info.size > limit,
    };
  } finally {
    await file.close();
  }
}

function runShell(
  input: BashInput,
  options: {
    readonly cancellation: AbortSignal;
    readonly cwd: string;
    readonly maxOutputBytes: number;
    readonly shell: boolean | string;
    readonly timeoutMs: number;
  },
): Promise<BashOutput> {
  if (options.cancellation.aborted) {
    return Promise.resolve({
      cancelled: true,
      exitCode: null,
      signal: null,
      stderr: "",
      stdout: "",
      timedOut: false,
      truncated: false,
    });
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, {
      cwd: options.cwd,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let total = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const capture = (target: Buffer[], chunk: Buffer) => {
      total += chunk.length;
      const remaining = options.maxOutputBytes - captured;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        target.push(kept);
        captured += kept.length;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const stop = () => child.kill("SIGTERM");
    const abort = () => {
      cancelled = true;
      stop();
    };
    options.cancellation.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      options.cancellation.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        cancelled,
        exitCode,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        timedOut,
        truncated: total > captured,
      });
    });
  });
}

export function createNodeTools(config: NodeToolsConfig): NodeTools {
  const filesystemScope = config.filesystemScope ?? "workspace";
  if (filesystemScope !== "workspace" && filesystemScope !== "process") {
    throw new TypeError(`Unknown Node Tools filesystem scope: ${filesystemScope}`);
  }
  const paths = new WorkspacePaths(config.root, filesystemScope);
  const maxReadBytes = config.maxReadBytes ?? 1_000_000;
  const maxOutputBytes = config.maxOutputBytes ?? 1_000_000;
  const bashTimeoutMs = config.bashTimeoutMs ?? 30_000;
  const maxBashTimeoutMs = config.maxBashTimeoutMs ?? 300_000;
  for (const [label, value] of Object.entries({
    bashTimeoutMs,
    maxBashTimeoutMs,
    maxOutputBytes,
    maxReadBytes,
  })) {
    positiveInteger(value, label);
  }
  if (bashTimeoutMs > maxBashTimeoutMs) {
    throw new TypeError("bashTimeoutMs must not exceed maxBashTimeoutMs");
  }

  const read = defineTool({
    description:
      filesystemScope === "workspace"
        ? "Read a bounded UTF-8 file inside the workspace root."
        : "Read a bounded UTF-8 file with the Jixu process permissions.",
    execute: async (input) => {
      const target = await paths.existing(input.path);
      return { ...target, ...(await readBounded(target.absolute, maxReadBytes)) };
    },
    idempotency: "idempotent",
    input: readInput,
    name: "read",
    output: readOutput,
  });

  const write = defineTool({
    description:
      filesystemScope === "workspace"
        ? "Write UTF-8 content to a file inside the workspace root."
        : "Write UTF-8 content to a file with the Jixu process permissions.",
    execute: async (input) => {
      const target = await paths.writable(input.path);
      await writeFile(target.absolute, input.content, "utf8");
      return { bytes: Buffer.byteLength(input.content), path: target.path };
    },
    idempotency: "idempotent",
    input: writeInput,
    name: "write",
    output: writeOutput,
  });

  const edit = defineTool({
    description:
      filesystemScope === "workspace"
        ? "Replace one exact text occurrence in a UTF-8 workspace file."
        : "Replace one exact text occurrence in a UTF-8 file with the Jixu process permissions.",
    execute: async (input) => {
      const target = await paths.existing(input.path);
      const content = await readFile(target.absolute, "utf8");
      const replacements = countOccurrences(content, input.oldText);
      if (replacements === 0) {
        throw new ToolExecutionError(
          "tool_edit_no_match",
          "edit oldText was not found",
        );
      }
      if (replacements > 1 && input.replaceAll !== true) {
        throw new ToolExecutionError(
          "tool_edit_ambiguous",
          "edit oldText is ambiguous; set replaceAll to true",
        );
      }
      const updated =
        input.replaceAll === true
          ? content.split(input.oldText).join(input.newText)
          : content.replace(input.oldText, input.newText);
      await writeFile(target.absolute, updated, "utf8");
      return {
        path: target.path,
        replacements: input.replaceAll === true ? replacements : 1,
      };
    },
    idempotency: "non-idempotent",
    input: editInput,
    name: "edit",
    output: editOutput,
  });

  const bash = defineTool({
    description: "Run a command in the local shell. Unsandboxed: it has the Jixu process permissions.",
    execute: async (input, context) => {
      const timeoutMs = input.timeoutMs ?? bashTimeoutMs;
      if (timeoutMs > maxBashTimeoutMs) {
        throw new ToolExecutionError(
          "tool_timeout_invalid",
          `bash timeoutMs exceeds ${maxBashTimeoutMs}`,
        );
      }
      return runShell(input, {
        cancellation: context.cancellation,
        cwd: paths.root,
        maxOutputBytes,
        shell: config.shell ?? true,
        timeoutMs,
      });
    },
    idempotency: "non-idempotent",
    input: bashInput,
    name: "bash",
    output: bashOutput,
  });

  const all = Object.freeze([read, write, edit, bash] as ExecutableTool[]);
  assertJsonValue(all.map((tool) => cloneJson(tool.descriptor)), "Node Tool descriptors");
  return Object.freeze({ all, bash, edit, read, write });
}
