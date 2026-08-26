import assert from "node:assert/strict";
import { createHash, type BinaryToTextEncoding } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { pack, unpack } from "@publint/pack";

import { JIXU_CLI_TARGETS } from "../packages/jixu/src/cli-targets.ts";
import {
  buildHostCliArtifact,
  readCliArtifactSet,
  type JixuCliArtifact,
} from "./build-cli-artifact.ts";
import { runCommand } from "./lib/command.ts";
import { verifyCliExecutable } from "./verify-cli-executable.ts";

interface PackageRepository {
  readonly directory: string;
  readonly type?: string;
  readonly url?: string;
}

interface PackageManifest {
  readonly bin?: Readonly<Record<string, string>>;
  readonly cpu?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly files?: readonly string[];
  readonly libc?: readonly string[];
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly main?: string;
  readonly name: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly os?: readonly string[];
  readonly preferUnplugged?: boolean;
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

export interface BuildPackageArtifactsOptions {
  readonly facadeOnly?: boolean;
  readonly nativeArtifactsRoot?: string;
}

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const libraryPackageDirectories = [
  "core",
  "llm",
  "store-jsonl",
  "store-sqlite",
  "testkit",
  "tools-jina",
  "tools-node",
  "jixu",
];

const cliPackageDirectories = JIXU_CLI_TARGETS.map(
  (target) => target.packageDirectory,
);

const packageDirectories = [
  ...libraryPackageDirectories,
  ...cliPackageDirectories,
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
  if (manifest.exports !== undefined) {
    assert.ok(isRecord(manifest.exports), `${label} exports must be an object`);
  }
  if (manifest.dependencies !== undefined) {
    assert.ok(isRecord(manifest.dependencies), `${label} dependencies must be an object`);
    for (const [name, specifier] of Object.entries(manifest.dependencies)) {
      assert.equal(typeof specifier, "string", `${label} dependency ${name} must be a string`);
    }
  }
  if (manifest.optionalDependencies !== undefined) {
    assert.ok(
      isRecord(manifest.optionalDependencies),
      `${label} optionalDependencies must be an object`,
    );
    for (const [name, specifier] of Object.entries(manifest.optionalDependencies)) {
      assert.equal(
        typeof specifier,
        "string",
        `${label} optional dependency ${name} must be a string`,
      );
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

function packedFileMode(bytes: Uint8Array, target: string): number | undefined {
  const archive = gunzipSync(bytes);
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 512 <= archive.byteLength; ) {
    const header = archive.subarray(offset, offset + 512);
    const type = decoder.decode(header.subarray(156, 157));
    if (type === "\0") return undefined;
    const readOctal = (start: number, end: number) =>
      Number.parseInt(
        decoder.decode(header.subarray(start, end)).replaceAll("\0", "").trim(),
        8,
      );
    const size = readOctal(124, 136);
    const name = decoder
      .decode(header.subarray(0, 100))
      .split("\0", 1)[0];
    if (type === "0" && name === target) return readOctal(100, 108);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

function releaseFields(manifest: PackageManifest): Readonly<Record<string, unknown>> {
  return {
    bin: manifest.bin,
    cpu: manifest.cpu,
    description: manifest.description,
    engines: manifest.engines,
    exports: manifest.exports,
    files: manifest.files,
    keywords: manifest.keywords,
    libc: manifest.libc,
    license: manifest.license,
    main: manifest.main,
    name: manifest.name,
    os: manifest.os,
    preferUnplugged: manifest.preferUnplugged,
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
  return Object.entries(manifest.exports ?? {}).map(([subpath, target]) => {
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
  expectedNativeSha256?: string,
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
  const expectedOptionalDependencies: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(
    sourceManifest.optionalDependencies ?? {},
  )) {
    if (specifier.startsWith("workspace:")) {
      const dependency = sourceManifests.get(name);
      assert.ok(
        dependency,
        `${manifest.name} references unknown optional workspace dependency ${name}`,
      );
      expectedOptionalDependencies[name] = dependency.version;
    } else {
      expectedOptionalDependencies[name] = specifier;
    }
  }
  assert.deepEqual(
    manifest.optionalDependencies ?? {},
    expectedOptionalDependencies,
    `${manifest.name} packed optional dependencies are not derived from package.json`,
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
  assert.ok(files.has("README.md"), `${manifest.name} tarball misses README.md`);

  if (manifest.name === "jixu-ai") {
    assert.equal(manifest.bin?.jixu, "./dist/cli-bin.js");
    assert.equal(files.has("dist/jixu"), false, "jixu-ai tarball embeds a native executable");
    assert.ok(files.has("dist/cli-bin.js"), "jixu-ai tarball misses its command launcher");
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

  if (manifest.name.startsWith("jixu-cli-")) {
    const binaryPath = manifest.files?.[0];
    assert.ok(binaryPath, `${manifest.name} misses its executable file declaration`);
    assert.deepEqual([...files.keys()].sort(), [
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
      binaryPath,
      "package.json",
    ]);
    const thirdPartyNotices = files.get("THIRD_PARTY_NOTICES.md");
    assert.ok(thirdPartyNotices, `${manifest.name} misses third-party notices`);
    assert.equal(
      new TextDecoder().decode(thirdPartyNotices),
      await readFile(
        join(repositoryRoot, "packages", "jixu", "THIRD_PARTY_NOTICES.md"),
        "utf8",
      ),
      `${manifest.name} third-party notices drifted from the canonical source`,
    );
    const binary = files.get(binaryPath);
    assert.ok(binary, `${manifest.name} tarball misses ${binaryPath}`);
    const binaryMode = packedFileMode(bytes, `${unpacked.rootDir}/${binaryPath}`);
    assert.ok(
      binaryMode !== undefined && (binaryMode & 0o111) !== 0,
      `${manifest.name} ${binaryPath} is not executable in the tarball`,
    );
    assert.equal(
      digest("sha256", binary, "hex"),
      expectedNativeSha256,
      `${manifest.name} binary differs from the release manifest`,
    );
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
  if (candidate.manifest.exports !== undefined) {
    await runCommand(
      "pnpm",
      ["exec", "attw", candidate.tarballPath, "--profile", "esm-only", "--quiet"],
      { cwd: repositoryRoot },
    );
  }
}

export async function buildPackageArtifacts(
  destination: string,
  options: BuildPackageArtifactsOptions = {},
): Promise<readonly PackageArtifactCandidate[]> {
  const resolvedDestination = resolve(destination);
  assertSafeArtifactDestination(resolvedDestination);
  await rm(resolvedDestination, { force: true, recursive: true });
  await mkdir(resolvedDestination, { recursive: true });

  await runCommand("pnpm", ["run", "clean:packages"], { cwd: repositoryRoot });
  await runCommand("pnpm", ["run", "build:packages"], { cwd: repositoryRoot });

  let cliArtifacts: readonly JixuCliArtifact[];
  if (options.facadeOnly === true) {
    cliArtifacts = [];
  } else if (options.nativeArtifactsRoot === undefined) {
    const cliArtifact = await buildHostCliArtifact(
      join(resolvedDestination, "native"),
    );
    await verifyCliExecutable(cliArtifact.binaryPath);
    cliArtifacts = [cliArtifact];
  } else {
    cliArtifacts = await readCliArtifactSet(resolve(options.nativeArtifactsRoot));
  }
  for (const cliArtifact of cliArtifacts) {
    const cliPackageRoot = join(
      repositoryRoot,
      "packages",
      cliArtifact.target.packageDirectory,
    );
    const packagedBinary = join(
      cliPackageRoot,
      "bin",
      cliArtifact.target.executable,
    );
    await mkdir(join(cliPackageRoot, "bin"), { recursive: true });
    await copyFile(cliArtifact.binaryPath, packagedBinary);
    await chmod(packagedBinary, 0o755);
    await copyFile(
      join(repositoryRoot, "LICENSE"),
      join(cliPackageRoot, "LICENSE"),
    );
    await copyFile(
      join(repositoryRoot, "packages", "jixu", "THIRD_PARTY_NOTICES.md"),
      join(cliPackageRoot, "THIRD_PARTY_NOTICES.md"),
    );
  }

  const sourceManifests = new Map<string, PackageManifest>();
  for (const directory of packageDirectories) {
    const manifestPath = join(repositoryRoot, "packages", directory, "package.json");
    const manifest = parseManifest(
      await readFile(manifestPath, "utf8"),
      manifestPath,
    );
    sourceManifests.set(manifest.name, manifest);
  }
  assert.equal(
    new Set(
      [...sourceManifests.values()]
        .filter((manifest) => manifest.name !== "jixu-ai")
        .map((manifest) => manifest.version),
    ).size,
    1,
    "reusable Jixu Framework and CLI packages must share one exact version",
  );
  const facade = sourceManifests.get("jixu-ai");
  assert.ok(facade, "source manifests miss jixu-ai");
  assert.deepEqual(
    Object.keys(facade.optionalDependencies ?? {}).sort(),
    JIXU_CLI_TARGETS.map((target) => target.packageName).sort(),
    "jixu-ai optionalDependencies drifted from the CLI target catalogue",
  );
  for (const target of JIXU_CLI_TARGETS) {
    const manifest = sourceManifests.get(target.packageName);
    assert.ok(manifest, `source manifests miss ${target.packageName}`);
    assert.deepEqual(manifest.os, [target.platform]);
    assert.deepEqual(manifest.cpu, [target.architecture]);
    assert.deepEqual(
      manifest.libc,
      target.platform === "linux" ? [target.libc] : undefined,
    );
    assert.deepEqual(manifest.files, [
      `bin/${target.executable}`,
      "THIRD_PARTY_NOTICES.md",
    ]);
    assert.equal(manifest.preferUnplugged, true);
    assert.deepEqual(manifest.publishConfig, { access: "public" });
    assert.equal(
      manifest.repository.directory,
      `packages/${target.packageDirectory}`,
    );
    const artifact = cliArtifacts.find(
      (candidate) => candidate.target.packageName === target.packageName,
    );
    if (artifact !== undefined) {
      assert.equal(
        artifact.metadata.version,
        manifest.version,
        `${target.packageName} artifact version drifted from its package manifest`,
      );
    }
  }

  const candidates: PackageArtifactCandidate[] = [];
  const candidateDirectories =
    options.facadeOnly === true
      ? ["jixu"]
      : [
          ...libraryPackageDirectories,
          ...cliArtifacts.map((artifact) => artifact.target.packageDirectory),
        ];
  for (const directory of candidateDirectories) {
    const packageRoot = join(repositoryRoot, "packages", directory);
    const sourceManifest = [...sourceManifests.values()].find(
      (manifest) => manifest.repository.directory === `packages/${directory}`,
    );
    assert.ok(sourceManifest, `missing source manifest for ${directory}`);
    const tarballPath = await pack(packageRoot, {
      destination: resolvedDestination,
      ignoreScripts: true,
      // npm preserves the chmod'd native executable without pnpm-only
      // publishConfig metadata that npm warns about during publication.
      packageManager: sourceManifest.name.startsWith("jixu-cli-") ? "npm" : "pnpm",
    });
    const candidate = await inspectTarball(
      tarballPath,
      sourceManifest,
      sourceManifests,
      cliArtifacts.find((artifact) => artifact.target.packageName === sourceManifest.name)
        ?.metadata.sha256,
    );
    await lintTarball(candidate);
    candidates.push(candidate);
  }

  const artifactManifest = {
    cli: cliArtifacts.map((artifact) => artifact.metadata),
    schemaVersion: 2,
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

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  assert.ok(typeof value === "string", `${name} requires a directory`);
  return resolve(repositoryRoot, value);
}

function cliDestination(): string {
  return optionValue("--out") ?? join(repositoryRoot, ".artifacts", "packages");
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const destination = cliDestination();
  const nativeArtifactsRoot = optionValue("--native-root");
  const facadeOnly = process.argv.includes("--facade-only");
  assert.equal(
    facadeOnly && nativeArtifactsRoot !== undefined,
    false,
    "--facade-only cannot be combined with --native-root",
  );
  const candidates = await buildPackageArtifacts(
    destination,
    {
      ...(nativeArtifactsRoot === undefined ? {} : { nativeArtifactsRoot }),
      ...(facadeOnly ? { facadeOnly: true } : {}),
    },
  );
  for (const candidate of candidates) {
    console.log(
      `${candidate.manifest.name}@${candidate.manifest.version} ${candidate.sha256.slice(0, 12)}`,
    );
  }
  console.log(`Packed ${candidates.length} release candidates into ${destination}`);
}
