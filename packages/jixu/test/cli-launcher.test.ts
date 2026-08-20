import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import test from "node:test";

import { launchJixuCli, resolveJixuCliBinary } from "../src/cli-launcher.ts";
import {
  selectJixuCliTarget,
  type JixuCliTarget,
} from "../src/cli-targets.ts";

test("JX-AC-050 selects only the published OS, CPU, and libc targets", () => {
  assert.equal(
    selectJixuCliTarget({ architecture: "arm64", platform: "darwin" })?.packageName,
    "@jixu/cli-darwin-arm64",
  );
  assert.equal(
    selectJixuCliTarget({ architecture: "x64", platform: "darwin" })?.packageName,
    "@jixu/cli-darwin-x64",
  );
  assert.equal(
    selectJixuCliTarget({
      architecture: "x64",
      libc: "glibc",
      platform: "linux",
    })?.packageName,
    "@jixu/cli-linux-x64",
  );
  assert.equal(
    selectJixuCliTarget({ architecture: "x64", platform: "win32" })?.packageName,
    "@jixu/cli-win32-x64",
  );
  assert.equal(
    selectJixuCliTarget({
      architecture: "x64",
      libc: "musl",
      platform: "linux",
    }),
    undefined,
  );
  assert.equal(
    selectJixuCliTarget({ architecture: "arm64", platform: "win32" }),
    undefined,
  );
});

test("JX-AC-050 resolves and dispatches the compatible optional package", () => {
  const target = selectJixuCliTarget({ architecture: "arm64", platform: "darwin" });
  assert.ok(target);
  assert.equal(
    resolveJixuCliBinary(
      target,
      () => "/installed/node_modules/@jixu/cli-darwin-arm64/package.json",
    ),
    "/installed/node_modules/@jixu/cli-darwin-arm64/bin/jixu",
  );

  let invocation:
    | {
        readonly args: readonly string[];
        readonly command: string;
        readonly options: Readonly<Record<string, unknown>>;
      }
    | undefined;
  const spawn = ((
    command: string,
    args: readonly string[] | undefined,
    options: object | undefined,
  ) => {
    invocation = {
      args: args ?? [],
      command,
      options: options as Readonly<Record<string, unknown>>,
    };
    return {
      error: undefined,
      output: [],
      pid: 1,
      signal: null,
      status: 0,
      stderr: null,
      stdout: null,
    };
  }) as unknown as typeof spawnSync;

  assert.equal(
    launchJixuCli({
      args: ["--version"],
      resolvePackage: () =>
        "/installed/node_modules/@jixu/cli-darwin-arm64/package.json",
      runtime: { architecture: "arm64", platform: "darwin" },
      spawn,
    }),
    0,
  );
  assert.deepEqual(invocation?.args, ["--version"]);
  assert.equal(
    invocation?.command,
    "/installed/node_modules/@jixu/cli-darwin-arm64/bin/jixu",
  );
  assert.equal(invocation?.options.shell, false);
  assert.equal(invocation?.options.stdio, "inherit");

  const windowsTarget = selectJixuCliTarget({ architecture: "x64", platform: "win32" });
  assert.ok(windowsTarget);
  assert.equal(
    resolveJixuCliBinary(
      windowsTarget,
      () => "/installed/node_modules/@jixu/cli-win32-x64/package.json",
    ),
    "/installed/node_modules/@jixu/cli-win32-x64/bin/jixu.exe",
  );
  assert.equal(
    launchJixuCli({
      args: ["--version"],
      resolvePackage: () =>
        "/installed/node_modules/@jixu/cli-win32-x64/package.json",
      runtime: { architecture: "x64", platform: "win32" },
      spawn,
    }),
    0,
  );
  assert.equal(
    invocation?.command,
    "/installed/node_modules/@jixu/cli-win32-x64/bin/jixu.exe",
  );
  assert.equal(invocation?.options.shell, false);
});

test("JX-AC-050 missing and unsupported native packages fail actionably", () => {
  const target = selectJixuCliTarget({ architecture: "arm64", platform: "darwin" });
  assert.ok(target);
  assert.throws(
    () =>
      resolveJixuCliBinary(target, () => {
        throw new Error("module not found");
      }),
    /Reinstall jixu with optional dependencies enabled/u,
  );
  assert.throws(
    () =>
      launchJixuCli({
        runtime: { architecture: "arm64", platform: "win32" },
      }),
    /Supported targets: darwin\/arm64, darwin\/x64, linux\/x64\/glibc, win32\/x64/u,
  );
});
