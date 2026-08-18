import { spawn } from "node:child_process";

function commandError(command, args, result) {
  const rendered = [command, ...args].join(" ");
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return new Error(`${rendered} failed with exit ${result.code}\n${details}`);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
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
