import { spawn } from "node:child_process";

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export interface CommandResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function commandError(
  command: string,
  args: readonly string[],
  result: CommandResult,
): Error {
  const rendered = [command, ...args].join(" ");
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return new Error(`${rendered} failed with exit ${result.code}\n${details}`);
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = {
        code,
        stderr: stderr.trim(),
        stdout: stdout.trim(),
      };
      if (code === 0) resolvePromise(result);
      else rejectPromise(commandError(command, args, result));
    });
  });
}
