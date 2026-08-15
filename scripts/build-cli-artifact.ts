import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentJixuCliRuntime,
  describeJixuCliRuntime,
  JIXU_CLI_TARGETS,
  selectJixuCliTarget,
  type JixuCliTarget,
} from "../packages/jixu/src/cli-targets.ts";
import { runCommand } from "./lib/command.ts";

interface JixuPackageManifest {
  readonly version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface JixuCliArtifact {
  readonly binaryPath: string;
  readonly manifestPath: string;
  readonly metadata: {
    readonly bunVersion: string;
    readonly bytes: number;
    readonly executable: JixuCliTarget["executable"];
    readonly package: JixuCliTarget["packageName"];
    readonly schemaVersion: 2;
    readonly sha256: string;
    readonly signature: "ad-hoc" | "developer-id" | "none";
    readonly target: JixuCliTarget["id"];
    readonly version: string;
  };
  readonly target: JixuCliTarget;
}

export interface MacSigningPlan {
  readonly identity: string;
  readonly signature: "ad-hoc" | "developer-id";
  readonly timestamp: boolean;
}

export type JixuReleaseChannel = "local" | "npm";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(parent: string, target: string): boolean {
  const path = relative(parent, target);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function assertSafeArtifactDestination(destination: string): void {
  const repositoryArtifacts = join(repositoryRoot, ".artifacts");
  assert.ok(
    isInside(repositoryArtifacts, destination) || isInside(tmpdir(), destination),
    `CLI artifact destination must be inside ${repositoryArtifacts} or the system temporary directory`,
  );
}

async function exactBunVersion(): Promise<string> {
  const required = (await readFile(join(repositoryRoot, ".bun-version"), "utf8")).trim();
  const actual = (await runCommand("bun", ["--version"], { cwd: repositoryRoot })).stdout;
  assert.equal(
    actual,
    required,
    `release builds require Bun ${required}; found ${actual}`,
  );
  return actual;
}

async function packageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "packages", "jixu", "package.json"), "utf8"),
  );
  assert.ok(typeof manifest === "object" && manifest !== null && !Array.isArray(manifest));
  assert.ok("version" in manifest && typeof manifest.version === "string");
  return (manifest as JixuPackageManifest).version;
}

function hostTarget(): JixuCliTarget {
  const runtime = currentJixuCliRuntime();
  const target = selectJixuCliTarget(runtime);
  assert.ok(
    target,
    `no release target matches build host ${describeJixuCliRuntime(runtime)}`,
  );
  return target;
}

export function resolveJixuReleaseChannel(
  value: string | undefined,
): JixuReleaseChannel {
  const releaseChannel = value ?? "local";
  assert.ok(
    releaseChannel === "local" || releaseChannel === "npm",
    `unsupported JIXU_RELEASE_CHANNEL ${JSON.stringify(releaseChannel)}`,
  );
  return releaseChannel;
}

export function resolveMacSigningPlan({
  identity = "-",
  releaseChannel,
}: {
  readonly identity?: string;
  readonly releaseChannel: JixuReleaseChannel;
}): MacSigningPlan {
  return {
    identity,
    signature: identity === "-" ? "ad-hoc" : "developer-id",
    timestamp: releaseChannel === "npm" && identity !== "-",
  };
}

async function signMacExecutable(
  binaryPath: string,
): Promise<"ad-hoc" | "developer-id"> {
  const plan = resolveMacSigningPlan({
    releaseChannel: resolveJixuReleaseChannel(process.env.JIXU_RELEASE_CHANNEL),
    ...(process.env.JIXU_CODESIGN_IDENTITY === undefined
      ? {}
      : { identity: process.env.JIXU_CODESIGN_IDENTITY }),
  });
  await runCommand(
    "codesign",
    [
      "--entitlements",
      join(repositoryRoot, "scripts", "macos-cli-entitlements.plist"),
      "-vvvv",
      "--deep",
      "--options",
      "runtime",
      "--sign",
      plan.identity,
      "--force",
      ...(plan.timestamp ? ["--timestamp"] : []),
      binaryPath,
    ],
    { cwd: repositoryRoot },
  );
  await runCommand("codesign", ["-vvv", "--verify", binaryPath], {
    cwd: repositoryRoot,
  });
  return plan.signature;
}

export async function buildCliArtifact(
  target: JixuCliTarget,
  destination = join(repositoryRoot, ".artifacts", "cli"),
): Promise<JixuCliArtifact> {
  const bunVersion = await exactBunVersion();
  const version = await packageVersion();
  const targetRoot = resolve(destination, target.id);
  assertSafeArtifactDestination(targetRoot);
  const binaryPath = join(targetRoot, target.executable);
  const manifestPath = join(targetRoot, "artifact.json");

  await rm(targetRoot, { force: true, recursive: true });
  await mkdir(targetRoot, { recursive: true });

  const args = [
    "build",
    "--compile",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-package-json",
    "--no-compile-autoload-tsconfig",
    `--target=${target.bunTarget}`,
    "--define",
    `process.env.JIXU_VERSION=${JSON.stringify(version)}`,
    ...(target.platform === "linux"
      ? [
          "--define",
          `process.env.OPENTUI_LIBC=${JSON.stringify(target.libc)}`,
        ]
      : []),
    join(repositoryRoot, "packages", "jixu", "src", "cli.tsx"),
    "--outfile",
    binaryPath,
  ];
  await runCommand("bun", args, { cwd: repositoryRoot });
  await chmod(binaryPath, 0o755);

  const signature: JixuCliArtifact["metadata"]["signature"] =
    target.platform === "darwin"
      ? await signMacExecutable(binaryPath)
      : "none";

  const versionResult = await runCommand(binaryPath, ["--version"], {
    cwd: repositoryRoot,
    env: { JIXU_HOME: join(targetRoot, "home") },
  });
  assert.equal(versionResult.stdout, version);

  const bytes = await readFile(binaryPath);
  const binaryStat = await stat(binaryPath);
  const metadata = {
    bunVersion,
    bytes: binaryStat.size,
    executable: target.executable,
    package: target.packageName,
    schemaVersion: 2 as const,
    sha256: sha256(bytes),
    signature,
    target: target.id,
    version,
  };
  await writeFile(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return { binaryPath, manifestPath, metadata, target };
}

export async function buildHostCliArtifact(
  destination = join(repositoryRoot, ".artifacts", "cli"),
): Promise<JixuCliArtifact> {
  return buildCliArtifact(hostTarget(), destination);
}

export async function readCliArtifact(
  target: JixuCliTarget,
  sourceRoot: string,
): Promise<JixuCliArtifact> {
  const targetRoot = resolve(sourceRoot, target.id);
  const binaryPath = join(targetRoot, target.executable);
  const manifestPath = join(targetRoot, "artifact.json");
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(isRecord(parsed), `${manifestPath} must contain an object`);
  assert.equal(parsed.schemaVersion, 2, `${manifestPath} has an unknown schema`);
  assert.equal(parsed.target, target.id, `${manifestPath} target drifted`);
  assert.equal(parsed.package, target.packageName, `${manifestPath} package drifted`);
  assert.equal(parsed.executable, target.executable, `${manifestPath} executable drifted`);

  const version = await packageVersion();
  const bunVersion = await exactBunVersion();
  assert.equal(parsed.version, version, `${manifestPath} version drifted`);
  assert.equal(parsed.bunVersion, bunVersion, `${manifestPath} Bun version drifted`);
  assert.ok(
    parsed.signature === "ad-hoc" ||
      parsed.signature === "developer-id" ||
      parsed.signature === "none",
    `${manifestPath} signature is invalid`,
  );
  if (target.platform === "darwin") {
    assert.notEqual(parsed.signature, "none", `${manifestPath} macOS artifact is unsigned`);
  } else {
    assert.equal(parsed.signature, "none", `${manifestPath} non-macOS signature drifted`);
  }

  const bytes = await readFile(binaryPath);
  const binaryStat = await stat(binaryPath);
  assert.equal(parsed.bytes, binaryStat.size, `${manifestPath} byte length drifted`);
  assert.equal(parsed.sha256, sha256(bytes), `${manifestPath} checksum drifted`);

  const metadata = parsed as unknown as JixuCliArtifact["metadata"];
  return { binaryPath, manifestPath, metadata, target };
}

export async function readCliArtifactSet(
  sourceRoot: string,
): Promise<readonly JixuCliArtifact[]> {
  return Promise.all(
    JIXU_CLI_TARGETS.map((target) => readCliArtifact(target, sourceRoot)),
  );
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const artifact = await buildHostCliArtifact();
  console.log(
    `${artifact.metadata.package}@${artifact.metadata.version} ${artifact.metadata.sha256.slice(0, 12)} ${artifact.binaryPath}`,
  );
}
