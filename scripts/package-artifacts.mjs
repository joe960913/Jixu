import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pack, unpack } from "@publint/pack";

import { runCommand } from "./lib/command.mjs";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const packageDirectories = [
  "core",
  "llm",
  "store-jsonl",
  "store-sqlite",
  "testkit",
  "tools-node",
  "jixu",
];

function isInside(parent, target) {
  const path = relative(parent, target);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function assertSafeArtifactDestination(destination) {
  const repositoryArtifacts = join(repositoryRoot, ".artifacts");
  assert.ok(
    isInside(repositoryArtifacts, destination) || isInside(tmpdir(), destination),
    `artifact destination must be inside ${repositoryArtifacts} or ${tmpdir()}`,
  );
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function releaseFields(manifest) {
  return {
    description: manifest.description,
    engines: manifest.engines,
    exports: manifest.exports,
    files: manifest.files,
    license: manifest.license,
    main: manifest.main,
    name: manifest.name,
    publishConfig: manifest.publishConfig,
    repository: manifest.repository,
    type: manifest.type,
    types: manifest.types,
    version: manifest.version,
  };
}

function exportTargets(manifest) {
  return Object.entries(manifest.exports).map(([subpath, target]) => {
    assert.equal(typeof target, "object", `${manifest.name} ${subpath} export must be conditional`);
    assert.ok(target !== null && !Array.isArray(target));
    assert.equal(typeof target.types, "string", `${manifest.name} ${subpath} misses types`);
    const runtime = target.import ?? target.default;
    assert.equal(typeof runtime, "string", `${manifest.name} ${subpath} misses ESM runtime`);
    return { runtime, subpath, types: target.types };
  });
}

async function inspectTarball(tarballPath, sourceManifest, sourceManifests) {
  const bytes = await readFile(tarballPath);
  const unpacked = await unpack(bytes);
  const prefix = `${unpacked.rootDir}/`;
  const files = new Map(
    unpacked.files.map((file) => [
      file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name,
      file.data,
    ]),
  );
  const packedManifestBytes = files.get("package.json");
  assert.ok(packedManifestBytes, `${sourceManifest.name} tarball misses package.json`);
  const manifest = JSON.parse(new TextDecoder().decode(packedManifestBytes));

  assert.deepEqual(
    releaseFields(manifest),
    releaseFields(sourceManifest),
    `${sourceManifest.name} packed release metadata drifted from its package.json`,
  );
  assert.notEqual(manifest.private, true, `${manifest.name} is still marked private`);
  assert.equal(
    JSON.stringify(manifest).includes("workspace:"),
    false,
    `${manifest.name} packed manifest contains workspace protocol`,
  );

  const expectedDependencies = {};
  for (const [name, specifier] of Object.entries(sourceManifest.dependencies ?? {})) {
    if (specifier.startsWith("workspace:")) {
      const dependency = sourceManifests.get(name);
      assert.ok(dependency, `${manifest.name} references unknown workspace dependency ${name}`);
      expectedDependencies[name] = dependency.version;
    } else {
      expectedDependencies[name] = specifier;
    }
  }
  assert.deepEqual(
    manifest.dependencies ?? {},
    expectedDependencies,
    `${manifest.name} packed runtime dependencies are not derived from package.json`,
  );

  for (const target of exportTargets(manifest)) {
    assert.match(target.runtime, /^\.\/dist\/.*\.js$/u);
    assert.match(target.types, /^\.\/dist\/.*\.d\.ts$/u);
    assert.ok(files.has(target.runtime.slice(2)), `${manifest.name} misses ${target.runtime}`);
    assert.ok(files.has(target.types.slice(2)), `${manifest.name} misses ${target.types}`);
  }

  for (const path of files.keys()) {
    assert.equal(path.startsWith("src/"), false, `${manifest.name} packed source ${path}`);
    assert.equal(path.startsWith("test/"), false, `${manifest.name} packed test ${path}`);
    assert.equal(path.endsWith(".tsbuildinfo"), false, `${manifest.name} packed ${path}`);
  }

  const sha256 = digest("sha256", bytes, "hex");
  return {
    files: [...files.keys()].sort(),
    integrity: `sha512-${digest("sha512", bytes, "base64")}`,
    manifest,
    sha256,
    shasum: digest("sha1", bytes, "hex"),
    tarballPath,
  };
}

async function lintTarball(candidate) {
  await runCommand("pnpm", ["exec", "publint", candidate.tarballPath], {
    cwd: repositoryRoot,
  });
  await runCommand(
    "pnpm",
    ["exec", "attw", candidate.tarballPath, "--profile", "esm-only", "--quiet"],
    { cwd: repositoryRoot },
  );
}

export async function buildPackageArtifacts(destination) {
  const resolvedDestination = resolve(destination);
  assertSafeArtifactDestination(resolvedDestination);
  await rm(resolvedDestination, { force: true, recursive: true });
  await mkdir(resolvedDestination, { recursive: true });

  await runCommand("pnpm", ["run", "clean:packages"], { cwd: repositoryRoot });
  await runCommand("pnpm", ["run", "build:packages"], { cwd: repositoryRoot });

  const sourceManifests = new Map();
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, "packages", directory, "package.json"), "utf8"),
    );
    sourceManifests.set(manifest.name, manifest);
  }

  const candidates = [];
  for (const directory of packageDirectories) {
    const packageRoot = join(repositoryRoot, "packages", directory);
    const sourceManifest = [...sourceManifests.values()].find(
      (manifest) => manifest.repository.directory === `packages/${directory}`,
    );
    assert.ok(sourceManifest, `missing source manifest for ${directory}`);
    const tarballPath = await pack(packageRoot, {
      destination: resolvedDestination,
      ignoreScripts: true,
      packageManager: "pnpm",
    });
    const candidate = await inspectTarball(tarballPath, sourceManifest, sourceManifests);
    await lintTarball(candidate);
    candidates.push(candidate);
  }

  const artifactManifest = {
    schemaVersion: 1,
    packages: candidates.map((candidate) => ({
      files: candidate.files,
      integrity: candidate.integrity,
      name: candidate.manifest.name,
      sha256: candidate.sha256,
      shasum: candidate.shasum,
      tarball: relative(resolvedDestination, candidate.tarballPath),
      version: candidate.manifest.version,
    })),
  };
  await writeFile(
    join(resolvedDestination, "artifacts.json"),
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
    "utf8",
  );

  return candidates;
}

function cliDestination() {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex === -1) return join(repositoryRoot, ".artifacts", "packages");
  const value = process.argv[outIndex + 1];
  assert.equal(typeof value, "string", "--out requires a directory");
  return resolve(repositoryRoot, value);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const destination = cliDestination();
  const candidates = await buildPackageArtifacts(destination);
  for (const candidate of candidates) {
    console.log(
      `${candidate.manifest.name}@${candidate.manifest.version} ${candidate.sha256.slice(0, 12)}`,
    );
  }
  console.log(`Packed ${candidates.length} release candidates into ${destination}`);
}
