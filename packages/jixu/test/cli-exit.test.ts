import assert from "node:assert/strict";
import test from "node:test";

import { createJixuExitOutput } from "../src/cli-exit.ts";

const PLAIN_WORDMARK = `
     ██╗██╗██╗  ██╗██╗   ██╗
     ██║██║╚██╗██╔╝██║   ██║
     ██║██║ ╚███╔╝ ██║   ██║
██   ██║██║ ██╔██╗ ██║   ██║
╚█████╔╝██║██╔╝ ██╗╚██████╔╝
 ╚════╝ ╚═╝╚═╝  ╚═╝ ╚═════╝
`;

test("JX-AC-044 interactive and SIGINT exits emit one bounded JIXU wordmark", () => {
  for (const reason of ["interactive", "interrupt"] as const) {
    assert.equal(
      createJixuExitOutput({ color: false, reason, stdoutIsTTY: true }),
      PLAIN_WORDMARK,
    );
  }

  const colored = createJixuExitOutput({
    color: true,
    reason: "interactive",
    stdoutIsTTY: true,
  });
  assert.match(colored, /^\n\u001B\[38;2;214;98;118m/);
  assert.match(colored, /\u001B\[0m\n$/);
  assert.equal(colored.replace(/\u001B\[[0-9;]+m/gu, ""), PLAIN_WORDMARK);
});

test("JX-AC-044 non-interactive, termination, and absent exits stay silent", () => {
  assert.equal(
    createJixuExitOutput({
      color: true,
      reason: "interactive",
      stdoutIsTTY: false,
    }),
    "",
  );
  assert.equal(
    createJixuExitOutput({
      color: false,
      reason: "terminate",
      stdoutIsTTY: true,
    }),
    "",
  );
  assert.equal(
    createJixuExitOutput({ color: false, reason: null, stdoutIsTTY: true }),
    "",
  );
});
