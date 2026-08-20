import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  currentJixuCliRuntime,
  describeJixuCliRuntime,
  describeSupportedJixuCliTargets,
  selectJixuCliTarget,
  type JixuCliRuntime,
  type JixuCliTarget,
} from "./cli-targets.ts";

const requireFromLauncher = createRequire(import.meta.url);

export interface JixuCliLaunchOptions {
  readonly args?: readonly string[];
  readonly resolvePackage?: (specifier: string) => string;
  readonly runtime?: JixuCliRuntime;
  readonly spawn?: typeof spawnSync;
}

export function resolveJixuCliBinary(
  target: JixuCliTarget,
  resolvePackage: (specifier: string) => string = requireFromLauncher.resolve,
): string {
  let manifestPath: string;
  try {
    manifestPath = resolvePackage(`${target.packageName}/package.json`);
  } catch (error) {
    const cause = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(
      `Jixu could not find ${target.packageName}. Reinstall jixu-ai with optional dependencies enabled${cause}`,
      { cause: error },
    );
  }
  return join(dirname(manifestPath), "bin", target.executable);
}

export function launchJixuCli({
  args = process.argv.slice(2),
  resolvePackage,
  runtime = currentJixuCliRuntime(),
  spawn = spawnSync,
}: JixuCliLaunchOptions = {}): number {
  const target = selectJixuCliTarget(runtime);
  if (target === undefined) {
    throw new Error(
      `Jixu does not publish a native executable for ${describeJixuCliRuntime(runtime)}. Supported targets: ${describeSupportedJixuCliTargets()}.`,
    );
  }

  const binary = resolveJixuCliBinary(target, resolvePackage);
  const result = spawn(binary, [...args], {
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new Error(`Jixu could not start ${binary}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== null) return result.status;
  if (result.signal !== null) return 1;
  return 1;
}
