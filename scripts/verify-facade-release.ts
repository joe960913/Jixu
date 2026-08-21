import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  currentJixuCliRuntime,
  selectJixuCliTarget,
} from "../packages/jixu/src/cli-targets.ts";
import { buildPackageArtifacts, repositoryRoot } from "./package-artifacts.ts";
import { runCommand } from "./lib/command.ts";

const temporaryRoot = await mkdtemp(join(tmpdir(), "jixu-facade-release-"));
const artifactsRoot = join(temporaryRoot, "artifacts");
const consumerRoot = join(temporaryRoot, "consumer");

try {
  const candidates = await buildPackageArtifacts(artifactsRoot, {
    facadeOnly: true,
  });
  assert.equal(candidates.length, 1);
  const facade = candidates[0];
  assert.ok(facade);
  assert.equal(facade.manifest.name, "jixu-ai");
  assert.match(facade.manifest.version, /^\d+\.\d+\.\d+$/u);
  assert.ok(facade.files.includes("README.md"));
  assert.equal(facade.files.includes("dist/jixu"), false);

  const target = selectJixuCliTarget(currentJixuCliRuntime());
  assert.ok(target, "facade release verification requires a supported host target");
  const nativeVersion = facade.manifest.optionalDependencies?.[target.packageName];
  const coreVersion = facade.manifest.dependencies?.["jixu-core"];
  assert.ok(nativeVersion, `jixu-ai misses ${target.packageName}`);
  assert.ok(coreVersion, "jixu-ai misses jixu-core");

  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "jixu-facade-release-consumer",
        private: true,
        type: "module",
        dependencies: {
          "jixu-ai": pathToFileURL(facade.tarballPath).href,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "smoke.mjs"),
    'import { JixuConfigStore } from "jixu-ai";\nif (typeof JixuConfigStore !== "function") process.exit(1);\n',
    "utf8",
  );
  const environment = {
    npm_config_audit: "false",
    npm_config_cache: join(temporaryRoot, "npm-cache"),
    npm_config_fund: "false",
  };
  await runCommand(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumerRoot, env: environment },
  );

  const installed = async (name: string) =>
    JSON.parse(
      await readFile(join(consumerRoot, "node_modules", name, "package.json"), "utf8"),
    ) as { readonly version: string };
  assert.equal((await installed("jixu-ai")).version, facade.manifest.version);
  assert.equal((await installed("jixu-core")).version, coreVersion);
  assert.equal((await installed(target.packageName)).version, nativeVersion);
  const readme = await readFile(
    join(consumerRoot, "node_modules", "jixu-ai", "README.md"),
    "utf8",
  );
  assert.match(readme, /npm install -g jixu-ai(?:\r?\n|$)/u);
  assert.doesNotMatch(readme, /jixu-ai@beta/u);

  const executable = join(consumerRoot, "node_modules", ".bin", "jixu");
  assert.equal(
    (await runCommand(executable, ["--version"], { cwd: consumerRoot })).stdout,
    nativeVersion,
  );
  assert.match(
    (await runCommand(executable, ["--help"], { cwd: consumerRoot })).stdout,
    /Jixu — Continue durable Agent work/u,
  );
  await runCommand(process.execPath, ["smoke.mjs"], { cwd: consumerRoot });

  console.log(
    `JX-AC-050 facade-only release passed: ${facade.manifest.name}@${facade.manifest.version} -> ${target.packageName}@${nativeVersion}`,
  );
  console.log(`Packed candidate: ${facade.tarballPath.replace(`${repositoryRoot}/`, "")}`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
