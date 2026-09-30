import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// JX-AC-016 JX-AC-061: the optional paid acceptance must not accidentally run
// when invoked by a maintainer or automation without both reviewed ceilings.
test("JX-AC-016 JX-AC-061 JX-AC-065 live reliability probe rejects missing or incorrect paid acknowledgement", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  for (const args of [
    [],
    ["--scope=skills", "--acknowledge-paid-requests=7", "--acknowledge-jina-requests=0"],
    ["--acknowledge-paid-requests=24"],
    ["--acknowledge-paid-requests=23", "--acknowledge-jina-requests=3"],
    ["--acknowledge-paid-requests=24", "--acknowledge-jina-requests=4"],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/probe-reliability.ts", ...args], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Review evals\/reliability\/README\.md/);
  }
});
