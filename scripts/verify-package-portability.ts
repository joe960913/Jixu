import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { pack } from "@publint/pack";

import { JIXU_CLI_TARGETS } from "../packages/jixu/src/cli-targets.ts";
import { runCommand } from "./lib/command.ts";
import {
  buildPackageArtifacts,
  repositoryRoot,
  type PackageArtifactCandidate,
} from "./package-artifacts.ts";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const managers: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];
const nodeFloorVersion = "22.19.0";
const yarnVersion = "4.18.0";
const typescriptCli = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

async function resolveNodeFloor(): Promise<string> {
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
  assert.ok(typeof executable === "string");
  const version = await runCommand(executable, ["--version"]);
  assert.equal(version.stdout, `v${nodeFloorVersion}`);
  return executable;
}

function runtimeSmoke(manager: PackageManager): string {
  return `
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, defineAgent } from "@jixu/core";
import { createLLMModelDriver } from "@jixu/llm";
import { JsonlEventStore } from "@jixu/store-jsonl";
import { SqliteEventStore } from "@jixu/store-sqlite";
import { SequenceModelDriver } from "@jixu/testkit";
import { defineStoreContract } from "@jixu/testkit/store-contract";
import { createJinaWebSearchTool } from "@jixu/tools-jina";
import { createNodeTools } from "@jixu/tools-node";
import { JixuConfigStore } from "jixu";

assert.equal(process.version, "v${nodeFloorVersion}");
const root = await mkdtemp(join(tmpdir(), "jixu-installed-smoke-"));
try {
  const model = new SequenceModelDriver([
    { status: "succeeded", value: { content: "portable", toolCalls: [] } },
  ]);
  const agent = defineAgent({
    instructions: "Prove the installed package can execute.",
    model: { provider: "fixture", model: "deterministic" },
    tools: [],
  });
  const harness = createHarness({ agent, modelDrivers: { fixture: model } });
  const thread = await harness.createThread();
  assert.equal((await thread.send("package portability")).status, "idle");

  const jsonl = new JsonlEventStore(join(root, "jsonl"));
  await jsonl.createThread("jsonl-import-smoke");
  const sqlite = new SqliteEventStore(join(root, "sqlite.db"));
  sqlite.close();
  assert.equal(createNodeTools({ root }).all.length, 4);
  assert.equal(createJinaWebSearchTool().descriptor.name, "web_search");
  assert.equal(typeof defineStoreContract, "function");
  assert.equal(typeof JixuConfigStore, "function");
  assert.equal(
    typeof createLLMModelDriver({
      api: "openai-chat-completions",
      apiKey: "fixture-secret",
      baseURL: "http://127.0.0.1:1/v1",
    }).generate,
    "function",
  );
  console.log("JX-AC-017 ${manager}: installed package Thread replied on Node ${nodeFloorVersion}");
} finally {
  await rm(root, { force: true, recursive: true });
}
`;
}

function typeConsumer(): string {
  return `
import { createHarness, defineAgent, type ModelDriver } from "@jixu/core";
import { createLLMModelDriver } from "@jixu/llm";
import { JsonlEventStore } from "@jixu/store-jsonl";
import { SqliteEventStore } from "@jixu/store-sqlite";
import { SequenceModelDriver } from "@jixu/testkit";
import { defineStoreContract } from "@jixu/testkit/store-contract";
import { createJinaWebSearchTool } from "@jixu/tools-jina";
import { createNodeTools } from "@jixu/tools-node";
import { JixuConfigStore } from "jixu";

const fixture: ModelDriver = new SequenceModelDriver([]);
const agent = defineAgent({
  instructions: "Type-check the installed public API.",
  model: { provider: "fixture", model: "deterministic" },
  tools: [],
});
const harness = createHarness({ agent, modelDrivers: { fixture } });

void harness;
void agent;
void JsonlEventStore;
void SqliteEventStore;
void defineStoreContract;
void createNodeTools;
void createJinaWebSearchTool;
void JixuConfigStore;
void createLLMModelDriver;
`;
}

async function writeConsumerFiles(
  root: string,
  manager: PackageManager,
  candidates: readonly PackageArtifactCandidate[],
): Promise<void> {
  const tarballs = Object.fromEntries(
    candidates.map((candidate) => [
      candidate.manifest.name,
      pathToFileURL(candidate.tarballPath).href,
    ]),
  );
  const platformFixtureTarballs = join(
    root,
    ".platform-resolutions",
    "tarballs",
  );
  await mkdir(platformFixtureTarballs, { recursive: true });
  const platformResolutions = Object.fromEntries(
    await Promise.all(
      JIXU_CLI_TARGETS.map(async (target) => {
        const tarball = tarballs[target.packageName];
        if (tarball !== undefined) return [target.packageName, tarball] as const;

        // Yarn and Bun resolve every optional dependency before applying the
        // platform filter. These metadata-only fixtures stand in for registry
        // manifests; they are never added to the release candidate set.
        const fixtureRoot = join(
          root,
          ".platform-resolutions",
          target.packageDirectory,
        );
        await mkdir(fixtureRoot, { recursive: true });
        const releaseVersion = candidates[0]?.manifest.version;
        assert.ok(releaseVersion, "release candidates are empty");
        await writeFile(
          join(fixtureRoot, "package.json"),
          `${JSON.stringify(
            {
              name: target.packageName,
              version: releaseVersion,
              os: [target.platform],
              cpu: [target.architecture],
              ...(target.platform === "linux" ? { libc: [target.libc] } : {}),
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        const fixtureTarball = await pack(fixtureRoot, {
          destination: platformFixtureTarballs,
          ignoreScripts: true,
          packageManager: "npm",
        });
        return [target.packageName, pathToFileURL(fixtureTarball).href] as const;
      }),
    ),
  );
  const localResolution =
    manager === "yarn"
      ? { resolutions: { ...tarballs, ...platformResolutions } }
      : manager === "bun"
        ? { overrides: { ...tarballs, ...platformResolutions } }
        : {};
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
  await writeFile(join(root, "smoke.ts"), runtimeSmoke(manager), "utf8");
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

async function verifyInstalledPackages(
  root: string,
  candidates: readonly PackageArtifactCandidate[],
): Promise<void> {
  for (const candidate of candidates) {
    const manifestPath = join(
      root,
      "node_modules",
      ...candidate.manifest.name.split("/"),
      "package.json",
    );
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.ok(typeof manifest === "object" && manifest !== null && !Array.isArray(manifest));
    assert.ok("name" in manifest && "version" in manifest);
    assert.equal(manifest.name, candidate.manifest.name);
    assert.equal(manifest.version, candidate.manifest.version);
    assert.equal(
      JSON.stringify(manifest).includes("workspace:"),
      false,
      `${candidate.manifest.name} installed with a workspace protocol`,
    );
  }
}

async function verifyInstalledCli(
  manager: PackageManager,
  root: string,
  candidates: readonly PackageArtifactCandidate[],
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> {
  const jixu = candidates.find((candidate) => candidate.manifest.name === "jixu");
  assert.ok(jixu, "release candidates miss jixu");

  const executable = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "jixu.cmd" : "jixu",
  );
  const version = await runCommand(executable, ["--version"], {
    cwd: root,
    env: environment,
  });
  assert.equal(version.stdout, jixu.manifest.version);
  const help = await runCommand(executable, ["--help"], {
    cwd: root,
    env: environment,
  });
  assert.match(help.stdout, /Jixu — Continue durable Agent work/u);
  assert.doesNotMatch(help.stdout, /pnpm dev/u);

  const executions: Readonly<
    Record<PackageManager, readonly [command: string, args: readonly string[]]>
  > = {
    npm: ["npm", ["exec", "--", "jixu", "--version"]],
    pnpm: ["pnpm", ["exec", "jixu", "--version"]],
    yarn: ["corepack", ["yarn", "exec", "jixu", "--version"]],
    bun: ["bunx", ["--no-install", "jixu", "--version"]],
  };
  const [command, args] = executions[manager];
  const executed = await runCommand(command, args, {
    cwd: root,
    env: environment,
  });
  assert.equal(executed.stdout, jixu.manifest.version);
}

async function verifyManager(
  manager: PackageManager,
  consumerRoot: string,
  candidates: readonly PackageArtifactCandidate[],
  corepackHome: string,
  nodeFloor: string,
): Promise<void> {
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
        "supportedArchitectures:",
        "  os:",
        "    - current",
        "    - darwin",
        "    - linux",
        "  cpu:",
        "    - current",
        "    - arm64",
        "    - x64",
        "  libc:",
        "    - current",
        "    - glibc",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  const installs: Readonly<
    Record<PackageManager, readonly [command: string, args: readonly string[]]>
  > = {
    npm: ["npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]],
    pnpm: ["pnpm", ["install", "--ignore-scripts", "--reporter=append-only"]],
    yarn: ["corepack", ["yarn", "install"]],
    bun: ["bun", ["install", "--ignore-scripts"]],
  };
  const [command, args] = installs[manager];
  await runCommand(command, args, { cwd: fixtureRoot, env: environment });
  await verifyInstalledPackages(fixtureRoot, candidates);
  await verifyInstalledCli(manager, fixtureRoot, candidates, environment);
  await runCommand(process.execPath, [typescriptCli, "--project", "tsconfig.json"], {
    cwd: fixtureRoot,
    env: environment,
  });
  const smoke = await runCommand(nodeFloor, ["smoke.ts"], {
    cwd: fixtureRoot,
    env: environment,
  });
  assert.match(smoke.stdout, new RegExp(`JX-AC-017 ${manager}:`));
  console.log(
    `  ✓ ${manager} clean install + jixu command + TypeScript + Node ${nodeFloorVersion} smoke`,
  );
}

async function main(): Promise<void> {
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
