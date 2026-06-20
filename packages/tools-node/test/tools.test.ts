import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ToolExecutionContext } from "@jixu/core";

import { createNodeTools } from "../src/index.ts";

function context(cancellation = new AbortController().signal): ToolExecutionContext {
  return {
    cancellation,
    effectId: "effect-1",
    idempotencyKey: "effect-1",
    threadId: "run-1",
    signals: { emit() {} },
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

test("JX-TOOL-007 file Tools reject lexical and symlink escapes", async (t) => {
  const fixture = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "jixu-outside-"));
  try {
    const tools = createNodeTools({ root: fixture.root });
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await assert.rejects(
      tools.read.execute(tools.read.parseInput({ path: "../secret.txt" }), context()),
      /escapes the workspace root/,
    );

    if (process.platform === "win32") {
      t.diagnostic("Symlink boundary assertion is skipped on Windows");
      return;
    }
    await symlink(join(outside, "secret.txt"), join(fixture.root, "linked.txt"));
    await assert.rejects(
      tools.read.execute(tools.read.parseInput({ path: "linked.txt" }), context()),
      /escapes the workspace root/,
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

test("JX-SEC-007 bash is bounded but remains an explicitly unsandboxed local shell", async () => {
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
    const output = tools.bash.parseOutput(
      await tools.bash.execute(input, context()),
    );

    assert.equal(output.exitCode, 3);
    assert.equal(output.stdout, "1234");
    assert.equal(output.stderr, "");
    assert.equal(output.truncated, true);
    assert.equal(output.timedOut, false);
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
