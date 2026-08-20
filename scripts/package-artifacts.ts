import assert from "node:assert/strict";
import { createHash, type BinaryToTextEncoding } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pack, unpack } from "@publint/pack";

import { runCommand } from "./lib/command.ts";

interface PackageRepository {
  readonly directory: string;
  readonly type?: string;
  readonly url?: string;
}

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly files?: readonly string[];
  readonly license?: string;
  readonly main?: string;
  readonly name: string;
  readonly private?: boolean;
  readonly publishConfig?: Readonly<Record<string, unknown>>;
  readonly repository: PackageRepository;
  readonly type?: string;
  readonly types?: string;
  readonly version: string;
}

interface PackageExportTarget {
  readonly default?: string;
  readonly import?: string;
  readonly types: string;
}

export interface PackageArtifactCandidate {
  readonly files: readonly string[];
  readonly integrity: string;
  readonly manifest: PackageManifest;
  readonly sha256: string;
  readonly shasum: string;
  readonly tarballPath: string;
}

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const packageDirectories = [
  "core",
  "llm",
  "store-jsonl",
  "store-sqlite",
  "testkit",
  "tools-jina",
  "tools-node",
  "jixu",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(source: string, label: string): PackageManifest {
  const manifest: unknown = JSON.parse(source);
  assert.ok(isRecord(manifest), `${label} must contain a JSON object`);
  assert.equal(typeof manifest.name, "string", `${label} misses name`);
  assert.equal(typeof manifest.version, "string", `${label} misses version`);
  assert.ok(isRecord(manifest.repository), `${label} misses repository`);
  assert.equal(
    typeof manifest.repository.directory,
    "string",
    `${label} misses repository.directory`,
  );
  assert.ok(isRecord(manifest.exports), `${label} misses exports`);
  if (manifest.dependencies !== undefined) {
    assert.ok(isRecord(manifest.dependencies), `${label} dependencies must be an object`);
    for (const [name, specifier] of Object.entries(manifest.dependencies)) {
      assert.equal(typeof specifier, "string", `${label} dependency ${name} must be a string`);
    }
  }
  return manifest as unknown as PackageManifest;
}

function isInside(parent: string, target: string): boolean {
  const path = relative(parent, target);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function assertSafeArtifactDestination(destination: string): void {
  const repositoryArtifacts = join(repositoryRoot, ".artifacts");
  assert.ok(
    isInside(repositoryArtifacts, destination) || isInside(tmpdir(), destination),
    `artifact destination must be inside ${repositoryArtifacts} or ${tmpdir()}`,
  );
}

function digest(
  algorithm: string,
  bytes: Uint8Array,
  encoding: BinaryToTextEncoding,
): string {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function releaseFields(manifest: PackageManifest): Readonly<Record<string, unknown>> {
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

function exportTargets(
  manifest: PackageManifest,
): readonly (PackageExportTarget & { readonly runtime: string; readonly subpath: string })[] {
  return Object.entries(manifest.exports).map(([subpath, target]) => {
    assert.ok(isRecord(target), `${manifest.name} ${subpath} export must be conditional`);
    const types = target.types;
    assert.ok(typeof types === "string", `${manifest.name} ${subpath} misses types`);
    const runtime = target.import ?? target.default;
    assert.ok(typeof runtime === "string", `${manifest.name} ${subpath} misses ESM runtime`);
    return { runtime, subpath, types };
  });
}

async function inspectTarball(
  tarballPath: string,
  sourceManifest: PackageManifest,
  sourceManifests: ReadonlyMap<string, PackageManifest>,
): Promise<PackageArtifactCandidate> {
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
  const manifest = parseManifest(
    new TextDecoder().decode(packedManifestBytes),
    `${sourceManifest.name} packed package.json`,
  );

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

  const expectedDependencies: Record<string, string> = {};
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

  if (manifest.name === "jixu") {
    for (const path of [
      "dist/tree-sitter-assets/bash/LICENSE",
      "dist/tree-sitter-assets/bash/highlights.scm",
      "dist/tree-sitter-assets/bash/tree-sitter-bash.wasm",
      "dist/tree-sitter-assets/python/LICENSE",
      "dist/tree-sitter-assets/python/highlights.scm",
      "dist/tree-sitter-assets/python/tree-sitter-python.wasm",
    ]) {
      assert.ok(files.has(path), `${manifest.name} tarball misses ${path}`);
    }
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

async function lintTarball(candidate: PackageArtifactCandidate): Promise<void> {
  await runCommand("pnpm", ["exec", "publint", candidate.tarballPath], {
    cwd: repositoryRoot,
  });
  await runCommand(
    "pnpm",
    ["exec", "attw", candidate.tarballPath, "--profile", "esm-only", "--quiet"],
    { cwd: repositoryRoot },
  );
}

export async function buildPackageArtifacts(
  destination: string,
): Promise<readonly PackageArtifactCandidate[]> {
  const resolvedDestination = resolve(destination);
  assertSafeArtifactDestination(resolvedDestination);
  await rm(resolvedDestination, { force: true, recursive: true });
  await mkdir(resolvedDestination, { recursive: true });

  await runCommand("pnpm", ["run", "clean:packages"], { cwd: repositoryRoot });
  await runCommand("pnpm", ["run", "build:packages"], { cwd: repositoryRoot });

  const sourceManifests = new Map<string, PackageManifest>();
  for (const directory of packageDirectories) {
    const manifestPath = join(repositoryRoot, "packages", directory, "package.json");
    const manifest = parseManifest(
      await readFile(manifestPath, "utf8"),
      manifestPath,
    );
    sourceManifests.set(manifest.name, manifest);
  }

  const candidates: PackageArtifactCandidate[] = [];
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

function cliDestination(): string {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex === -1) return join(repositoryRoot, ".artifacts", "packages");
  const value = process.argv[outIndex + 1];
  assert.ok(typeof value === "string", "--out requires a directory");
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
