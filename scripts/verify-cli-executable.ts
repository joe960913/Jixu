import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const DARWIN_EXPECT_SCRIPT = String.raw`
set timeout 15
spawn -noecho $env(JIXU_BINARY)
expect {
  -re {Model not configured} {}
  eof { exit 1 }
  timeout { exit 124 }
}
expect {
  -re {use /config} {}
  eof { exit 1 }
  timeout { exit 124 }
}
send -- "/quit\r"
expect eof
set wait_status [wait]
exit [lindex $wait_status 3]
`;

function ptyInvocation(binaryPath: string): {
  readonly command: string;
  readonly args: readonly string[];
  readonly binaryEnvironment?: string;
} {
  if (process.platform === "darwin") {
    return {
      args: ["-c", DARWIN_EXPECT_SCRIPT],
      binaryEnvironment: binaryPath,
      command: "/usr/bin/expect",
    };
  }
  if (process.platform === "linux") {
    return {
      args: ["-q", "-e", "-c", shellQuote(binaryPath), "/dev/null"],
      command: "script",
    };
  }
  throw new Error(`Jixu executable PTY acceptance does not support ${process.platform}`);
}

function runInPty(
  binaryPath: string,
  workspace: string,
  home: string,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = ptyInvocation(binaryPath);
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: workspace,
      env: {
        ...process.env,
        COLUMNS: "100",
        JIXU_HOME: home,
        JIXU_MOTION: "off",
        LINES: "30",
        NO_COLOR: "1",
        TERM: "xterm-256color",
        ...(invocation.binaryEnvironment === undefined
          ? {}
          : { JIXU_BINARY: invocation.binaryEnvironment }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer | string) => {
      if (output.length >= OUTPUT_LIMIT) return;
      output += chunk.toString().slice(0, OUTPUT_LIMIT - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", rejectPromise);

    const inputTimer =
      process.platform === "linux"
        ? setTimeout(() => {
            child.stdin.write("/quit\r");
          }, 750)
        : undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 15_000);

    child.on("close", (code, signal) => {
      if (inputTimer !== undefined) clearTimeout(inputTimer);
      clearTimeout(timeout);
      if (timedOut) {
        rejectPromise(new Error("Jixu executable did not quit within 15 seconds"));
        return;
      }
      if (code !== 0) {
        rejectPromise(
          new Error(
            `Jixu executable PTY smoke failed with code ${String(code)} signal ${String(signal)}\n${output}`,
          ),
        );
        return;
      }
      resolvePromise(output);
    });
  });
}

export async function verifyCliExecutable(binaryPath: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jixu-cli-acceptance-"));
  try {
    const output = await runInPty(
      resolve(binaryPath),
      root,
      join(root, "home"),
    );
    assert.match(output, /Model not configured/u);
    assert.match(output, /use \/config/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const binaryPath = process.argv[2];
  assert.ok(binaryPath, "usage: node scripts/verify-cli-executable.ts <binary>");
  await verifyCliExecutable(resolve(repositoryRoot, binaryPath));
  console.log(`JX-AC-051 passed: ${resolve(repositoryRoot, binaryPath)}`);
}
