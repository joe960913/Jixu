import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  parseToolOutputDelta,
  TOOL_OUTPUT_SIGNAL_TYPE,
  ToolExecutionError,
} from "jixu-core";
import type { Signal, ToolExecutionContext } from "jixu-core";

import { createNodeTools } from "../src/index.ts";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

function shellArgument(value: string): string {
  if (process.platform === "win32") return JSON.stringify(value);
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("fixture descendant did not publish its PID");
}

async function assertProcessExited(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(processExists(pid), false, `process ${pid} remained alive`);
}

async function stubbornProcessTree(root: string, name: string, escaped = false): Promise<{
  readonly command: string;
  readonly pidPath: string;
}> {
  const childPath = join(root, `${name}-child.mjs`);
  const parentPath = join(root, `${name}-parent.mjs`);
  const pidPath = join(root, `${name}.pid`);
  await writeFile(
    childPath,
    [
      'import { writeFile } from "node:fs/promises";',
      'process.on("SIGTERM", () => {});',
      'await writeFile(process.argv[2], String(process.pid), "utf8");',
      'process.stdout.write("grandchild-ready\\n");',
      'setInterval(() => {}, 1_000);',
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    parentPath,
    [
      'import { spawn } from "node:child_process";',
      'const child = spawn(process.execPath, [process.argv[2], process.argv[3]], {',
      '  detached: process.argv[4] === "escaped",',
      '  stdio: ["ignore", "inherit", "inherit"],',
      '});',
      'if (process.argv[4] === "escaped") child.unref();',
      'setInterval(() => {}, 1_000);',
    ].join("\n"),
    "utf8",
  );
  return {
    command: [process.execPath, parentPath, childPath, pidPath, escaped ? "escaped" : "grouped"]
      .map(shellArgument)
      .join(" "),
    pidPath,
  };
}

function context(
  cancellation = new AbortController().signal,
  signals: ToolExecutionContext["signals"] = { emit() {} },
): ToolExecutionContext {
  return {
    cancellation,
    effectId: "effect-1",
    idempotencyKey: "effect-1",
    threadId: "run-1",
    signals,
  };
}

async function workspace(): Promise<{ cleanup: () => Promise<void>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "jixu-tools-"));
  return { cleanup: () => rm(root, { force: true, recursive: true }), root };
}

test("JX-TOOL-006 read, write, and edit use canonical Tools inside one workspace root", async () => {
  const fixture = await workspace();
  try {
    const tools = createNodeTools({ root: fixture.root });
    assert.deepEqual(
      tools.all.map((tool) => tool.descriptor.name),
      ["read", "write", "edit", "bash"],
    );
    assert.deepEqual(
      tools.all.map((tool) => tool.metadata.origin),
      ["builtin", "builtin", "builtin", "builtin"],
    );
    assert.deepEqual(
      tools.read.authorize(
        tools.read.parseInput({ path: "notes/../notes/example.txt" }),
      ),
      { action: "read", resources: ["notes/example.txt"] },
    );
    assert.deepEqual(
      tools.bash.authorize(tools.bash.parseInput({ command: "printf test" })),
      { action: "bash", resources: ["process"] },
    );

    const writeInput = tools.write.parseInput({
      content: "alpha beta",
      path: "notes/example.txt",
    });
    const written = tools.write.parseOutput(
      await tools.write.execute(writeInput, context()),
    );
    assert.deepEqual(written, { bytes: 10, path: "notes/example.txt" });

    const readInput = tools.read.parseInput({ path: "notes/example.txt" });
    assert.deepEqual(
      tools.read.parseOutput(await tools.read.execute(readInput, context())),
      { content: "alpha beta", path: "notes/example.txt", truncated: false },
    );

    const editInput = tools.edit.parseInput({
      newText: "gamma",
      oldText: "beta",
      path: "notes/example.txt",
    });
    assert.deepEqual(
      tools.edit.parseOutput(await tools.edit.execute(editInput, context())),
      { path: "notes/example.txt", replacements: 1 },
    );
    assert.equal(
      await readFile(join(fixture.root, "notes/example.txt"), "utf8"),
      "alpha gamma",
    );

    const empty = tools.write.parseInput({ content: "", path: "empty.txt" });
    assert.deepEqual(
      tools.write.parseOutput(await tools.write.execute(empty, context())),
      { bytes: 0, path: "empty.txt" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("JX-AC-039 JX-TOOL-007 file Tools reject lexical and symlink escapes", async () => {
  const fixture = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "jixu-outside-"));
  try {
    const tools = createNodeTools({ root: fixture.root });
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await assert.rejects(
      tools.read.execute(tools.read.parseInput({ path: "../secret.txt" }), context()),
      (error) =>
        error instanceof ToolExecutionError &&
        error.code === "tool_path_outside_scope" &&
        /escapes the workspace scope/.test(error.message),
    );

    await symlink(join(outside, "secret.txt"), join(fixture.root, "linked.txt"));
    await assert.rejects(
      tools.read.execute(tools.read.parseInput({ path: "linked.txt" }), context()),
      (error) =>
        error instanceof ToolExecutionError &&
        error.code === "tool_path_outside_scope",
    );

    await symlink(join(outside, "missing.txt"), join(fixture.root, "dangling.txt"));
    await assert.rejects(
      tools.write.execute(
        tools.write.parseInput({ content: "no", path: "dangling.txt" }),
        context(),
      ),
      /unresolved link/,
    );
  } finally {
    await Promise.all([
      fixture.cleanup(),
      rm(outside, { force: true, recursive: true }),
    ]);
  }
});

test("JX-AC-039 process scope gives file Tools the disclosed shell boundary", async () => {
  const fixture = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "jixu-process-scope-"));
  const target = join(outside, "hello.txt");
  try {
    const tools = createNodeTools({
      filesystemScope: "process",
      root: fixture.root,
    });
    const written = await tools.write.execute(
      tools.write.parseInput({ content: "hello world", path: target }),
      context(),
    );
    assert.deepEqual(written, { bytes: 11, path: target });

    const edited = await tools.edit.execute(
      tools.edit.parseInput({
        newText: "hello 2nd world",
        oldText: "hello world",
        path: target,
      }),
      context(),
    );
    assert.deepEqual(edited, { path: target, replacements: 1 });
    assert.deepEqual(
      tools.read.parseOutput(
        await tools.read.execute(
          tools.read.parseInput({ path: target }),
          context(),
        ),
      ),
      { content: "hello 2nd world", path: target, truncated: false },
    );
  } finally {
    await Promise.all([
      fixture.cleanup(),
      rm(outside, { force: true, recursive: true }),
    ]);
  }
});

test("JX-AC-039 JX-AC-041 JX-AC-064 JX-SEC-005 bash output and live Signals share one bound", async () => {
  const fixture = await workspace();
  try {
    const tools = createNodeTools({
      maxOutputBytes: 4,
      root: fixture.root,
    });
    assert.match(tools.bash.descriptor.description, /Unsandboxed/);
    const input = tools.bash.parseInput({
      command: "printf '123456'; printf 'err' >&2; exit 3",
    });
    const signals: Signal[] = [];
    const output = tools.bash.parseOutput(
      await tools.bash.execute(
        input,
        context(new AbortController().signal, {
          emit(signal) {
            signals.push(signal);
          },
        }),
      ),
    );

    assert.equal(output.exitCode, 3);
    assert.equal(output.stdout, "1234");
    assert.equal(output.stderr, "");
    assert.equal(output.truncated, true);
    assert.equal(output.timedOut, false);
    assert.ok(signals.length > 0);
    assert.ok(signals.every((signal) => signal.type === TOOL_OUTPUT_SIGNAL_TYPE));
    const deltas = signals.map((signal) => parseToolOutputDelta(signal.data));
    assert.equal(deltas.map((delta) => delta.delta).join(""), "1234");
    assert.ok(
      deltas.every(
        (delta) =>
          delta.effectId === "effect-1" &&
          delta.name === "bash" &&
          delta.stream === "stdout",
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("JX-SEC-005 bash propagates cancellation to the local process", async () => {
  const fixture = await workspace();
  try {
    const tools = createNodeTools({ root: fixture.root });
    const cancellation = new AbortController();
    cancellation.abort();
    const output = tools.bash.parseOutput(
      await tools.bash.execute(
        tools.bash.parseInput({ command: "printf 'should-not-run'" }),
        context(cancellation.signal),
      ),
    );

    assert.equal(output.cancelled, true);
    assert.equal(output.exitCode, null);
    assert.equal(output.stdout, "");
  } finally {
    await fixture.cleanup();
  }
});

test("JX-AC-064 bash timeout kills descendants that inherit output pipes", async () => {
  const fixture = await workspace();
  let descendantPid: number | undefined;
  try {
    const processTree = await stubbornProcessTree(fixture.root, "timeout");
    const tools = createNodeTools({ bashTimeoutMs: 500, root: fixture.root });
    const startedAt = Date.now();
    const output = tools.bash.parseOutput(
      await tools.bash.execute(
        tools.bash.parseInput({ command: processTree.command }),
        context(),
      ),
    );
    const elapsedMs = Date.now() - startedAt;
    descendantPid = await waitForPid(processTree.pidPath);

    assert.equal(output.timedOut, true);
    assert.equal(output.cancelled, false);
    assert.match(output.stdout, /grandchild-ready/);
    assert.ok(elapsedMs < 3_500, `timeout settled after ${elapsedMs}ms`);
    await assertProcessExited(descendantPid);
    descendantPid = undefined;
  } finally {
    if (descendantPid !== undefined && processExists(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    await fixture.cleanup();
  }
});

test("JX-AC-064 bash cancellation kills the active foreground process tree", async () => {
  const fixture = await workspace();
  let descendantPid: number | undefined;
  try {
    const processTree = await stubbornProcessTree(fixture.root, "cancel");
    const tools = createNodeTools({ bashTimeoutMs: 5_000, root: fixture.root });
    const cancellation = new AbortController();
    const execution = tools.bash.execute(
      tools.bash.parseInput({ command: processTree.command }),
      context(cancellation.signal),
    );
    descendantPid = await waitForPid(processTree.pidPath);
    const cancelledAt = Date.now();
    cancellation.abort();
    const output = tools.bash.parseOutput(await execution);
    const elapsedMs = Date.now() - cancelledAt;

    assert.equal(output.cancelled, true);
    assert.equal(output.timedOut, false);
    assert.match(output.stdout, /grandchild-ready/);
    assert.ok(elapsedMs < 3_000, `cancellation settled after ${elapsedMs}ms`);
    await assertProcessExited(descendantPid);
    descendantPid = undefined;
  } finally {
    if (descendantPid !== undefined && processExists(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    await fixture.cleanup();
  }
});

test("JX-AC-064 escaped pipe holder reaches a bounded indeterminate outcome", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await workspace();
  let descendantPid: number | undefined;
  try {
    const processTree = await stubbornProcessTree(fixture.root, "escaped", true);
    const tools = createNodeTools({ bashTimeoutMs: 500, root: fixture.root });
    const signals: Signal[] = [];
    const startedAt = Date.now();
    const execution = tools.bash.execute(
      tools.bash.parseInput({ command: processTree.command }),
      context(new AbortController().signal, {
        emit(signal) {
          signals.push(signal);
        },
      }),
    );
    descendantPid = await waitForPid(processTree.pidPath);

    await assert.rejects(execution, /could not be confirmed before the output drain deadline/);
    const elapsedMs = Date.now() - startedAt;
    const output = signals
      .filter((signal) => signal.type === TOOL_OUTPUT_SIGNAL_TYPE)
      .map((signal) => parseToolOutputDelta(signal.data).delta)
      .join("");
    assert.match(output, /grandchild-ready/);
    assert.ok(elapsedMs < 4_000, `indeterminate termination settled after ${elapsedMs}ms`);
    assert.equal(processExists(descendantPid), true);
  } finally {
    if (descendantPid !== undefined && processExists(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
      await assertProcessExited(descendantPid);
    }
    await fixture.cleanup();
  }
});
