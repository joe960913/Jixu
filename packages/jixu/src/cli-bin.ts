#!/usr/bin/env node

import { launchJixuCli } from "./cli-launcher.ts";

try {
  process.exitCode = launchJixuCli();
} catch (error) {
  const message = error instanceof Error ? error.message : "Jixu failed to start.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
