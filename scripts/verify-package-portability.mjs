import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runCommand } from "./lib/command.mjs";
import { buildPackageArtifacts, repositoryRoot } from "./package-artifacts.mjs";

const managers = ["npm", "pnpm", "yarn", "bun"];
const nodeFloorVersion = "22.18.0";
const yarnVersion = "4.18.0";
const typescriptCli = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

async function resolveNodeFloor() {
  const result = await runCommand(
    "pnpm",
    [
      `--package=node@${nodeFloorVersion}`,
      "dlx",
      "node",
      "-p",
      "process.execPath",
    ],
    { cwd: repositoryRoot },
  );
  const executable = result.stdout.split("\n").at(-1);
  assert.equal(typeof executable, "string");
  const version = await runCommand(executable, ["--version"]);
  assert.equal(version.stdout, `v${nodeFloorVersion}`);
  return executable;
}

function runtimeSmoke(manager) {
  return `
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntime, defineAgent } from "@jixu/core";
import { createOpenAICompatibleModelDriver } from "@jixu/llm";
import { JsonlEventStore } from "@jixu/store-jsonl";
import { SqliteEventStore } from "@jixu/store-sqlite";
import { SequenceModelDriver } from "@jixu/testkit";
import { defineStoreContract } from "@jixu/testkit/store-contract";
import { createNodeTools } from "@jixu/tools-node";
import { JixuConfigStore } from "jixu";

assert.equal(process.version, "v${nodeFloorVersion}");
const root = await mkdtemp(join(tmpdir(), "jixu-installed-smoke-"));
try {
  const model = new SequenceModelDriver([
    { status: "succeeded", value: { content: "portable", toolCalls: [] } },
  ]);
  const runtime = createRuntime({ modelDrivers: { fixture: model } });
  const agent = defineAgent({
    instructions: "Prove the installed package can execute.",
    model: { provider: "fixture", model: "deterministic" },
    tools: [],
  });
  const run = await runtime.run(agent, "package portability");
  assert.equal((await run.wait()).status, "completed");

  const jsonl = new JsonlEventStore(join(root, "jsonl"));
  await jsonl.createRun("jsonl-import-smoke");
  const sqlite = new SqliteEventStore(join(root, "sqlite.db"));
  sqlite.close();
  assert.equal(createNodeTools({ root }).all.length, 4);
  assert.equal(typeof defineStoreContract, "function");
  assert.equal(typeof JixuConfigStore, "function");
  assert.equal(
    typeof createOpenAICompatibleModelDriver({
      apiFormat: "responses",
      apiKey: "fixture-secret",
      baseURL: "http://127.0.0.1:1/v1",
    }).generate,
    "function",
  );
  console.log("JX-AC-017 ${manager}: installed package Run completed on Node ${nodeFloorVersion}");
} finally {
  await rm(root, { force: true, recursive: true });
}
`;
}

function typeConsumer() {
  return `
import { createRuntime, defineAgent, type ModelDriver } from "@jixu/core";
import { createOpenAICompatibleModelDriver } from "@jixu/llm";
import { JsonlEventStore } from "@jixu/store-jsonl";
import { SqliteEventStore } from "@jixu/store-sqlite";
import { SequenceModelDriver } from "@jixu/testkit";
import { defineStoreContract } from "@jixu/testkit/store-contract";
import { createNodeTools } from "@jixu/tools-node";
import { JixuConfigStore } from "jixu";

const fixture: ModelDriver = new SequenceModelDriver([]);
const runtime = createRuntime({ modelDrivers: { fixture } });
const agent = defineAgent({
  instructions: "Type-check the installed public API.",
  model: { provider: "fixture", model: "deterministic" },
  tools: [],
});

void runtime;
void agent;
void JsonlEventStore;
void SqliteEventStore;
void defineStoreContract;
void createNodeTools;
void JixuConfigStore;
void createOpenAICompatibleModelDriver;
`;
}

async function writeConsumerFiles(root, manager, candidates) {
  const tarballs = Object.fromEntries(
    candidates.map((candidate) => [
      candidate.manifest.name,
      pathToFileURL(candidate.tarballPath).href,
    ]),
  );
  let localResolution = {};
  if (manager === "yarn") localResolution = { resolutions: tarballs };
  if (manager === "bun") localResolution = { overrides: tarballs };
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: `jixu-${manager}-consumer`,
        version: "0.0.0",
        private: true,
        type: "module",
        ...(manager === "yarn" ? { packageManager: `yarn@${yarnVersion}` } : {}),
        dependencies: tarballs,
        ...localResolution,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (manager === "pnpm") {
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      [
        "overrides:",
        ...Object.entries(tarballs).map(
          ([name, tarball]) => `  ${JSON.stringify(name)}: ${JSON.stringify(tarball)}`,
        ),
        "",
      ].join("\n"),
      "utf8",
    );
  }
  await writeFile(join(root, "smoke.mjs"), runtimeSmoke(manager), "utf8");
  await writeFile(join(root, "types.mts"), typeConsumer(), "utf8");
  await writeFile(
    join(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ES2023", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2023",
          types: [],
        },
        files: ["types.mts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function verifyInstalledPackages(root, candidates) {
  for (const candidate of candidates) {
    const manifestPath = join(
      root,
      "node_modules",
      ...candidate.manifest.name.split("/"),
      "package.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.name, candidate.manifest.name);
    assert.equal(manifest.version, candidate.manifest.version);
    assert.equal(
      JSON.stringify(manifest).includes("workspace:"),
      false,
      `${candidate.manifest.name} installed with a workspace protocol`,
    );
  }
}

async function verifyManager(
  manager,
  consumerRoot,
  candidates,
  corepackHome,
  nodeFloor,
) {
  const fixtureRoot = join(consumerRoot, manager);
  await mkdir(fixtureRoot, { recursive: true });
  await writeConsumerFiles(fixtureRoot, manager, candidates);

  const userConfig = join(fixtureRoot, ".npmrc");
  await writeFile(userConfig, "", { encoding: "utf8", mode: 0o600 });
  const environment = {
    COREPACK_HOME: corepackHome,
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_cache: join(fixtureRoot, ".npm-cache"),
    npm_config_fund: "false",
    npm_config_userconfig: userConfig,
  };

  if (manager === "yarn") {
    await writeFile(
      join(fixtureRoot, ".yarnrc.yml"),
      [
        "nodeLinker: node-modules",
        "enableScripts: false",
        "enableGlobalCache: false",
        "globalFolder: \"./.yarn/global\"",
        "npmPreapprovedPackages:",
        "  - \"openai@7.5.0\"",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  const installs = {
    npm: ["npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]],
    pnpm: ["pnpm", ["install", "--ignore-scripts", "--reporter=append-only"]],
    yarn: ["corepack", ["yarn", "install"]],
    bun: ["bun", ["install", "--ignore-scripts"]],
  };
  const [command, args] = installs[manager];
  await runCommand(command, args, { cwd: fixtureRoot, env: environment });
  await verifyInstalledPackages(fixtureRoot, candidates);
  await runCommand(process.execPath, [typescriptCli, "--project", "tsconfig.json"], {
    cwd: fixtureRoot,
    env: environment,
  });
  const smoke = await runCommand(nodeFloor, ["smoke.mjs"], {
    cwd: fixtureRoot,
    env: environment,
  });
  assert.match(smoke.stdout, new RegExp(`JX-AC-017 ${manager}:`));
  console.log(`  ✓ ${manager} clean install + TypeScript + Node ${nodeFloorVersion} smoke`);
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "jixu-package-portability-"));
  const tarballRoot = join(temporaryRoot, "tarballs");
  const consumerRoot = join(temporaryRoot, "consumers");
  const corepackHome = join(temporaryRoot, "corepack");
  await mkdir(consumerRoot, { recursive: true });

  try {
    console.log("JX-AC-017 package-manager portability");
    console.log("Building and linting one authoritative tarball set...");
    const candidates = await buildPackageArtifacts(tarballRoot);
    for (const candidate of candidates) {
      console.log(
        `  ✓ ${candidate.manifest.name}@${candidate.manifest.version} ${candidate.sha256.slice(0, 12)}`,
      );
    }

    const nodeFloor = await resolveNodeFloor();
    console.log("Installing the exact local tarballs in isolated consumers...");
    for (const manager of managers) {
      await verifyManager(
        manager,
        consumerRoot,
        candidates,
        corepackHome,
        nodeFloor,
      );
    }
    console.log(
      `JX-AC-017 passed: one real tarball set works with npm, pnpm, Yarn, and Bun on Node ${nodeFloorVersion}.`,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

await main();
