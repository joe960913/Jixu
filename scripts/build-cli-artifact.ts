import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentJixuCliRuntime,
  describeJixuCliRuntime,
  selectJixuCliTarget,
  type JixuCliTarget,
} from "../packages/jixu/src/cli-targets.ts";
import { runCommand } from "./lib/command.ts";

interface JixuPackageManifest {
  readonly version: string;
}

export interface JixuCliArtifact {
  readonly binaryPath: string;
  readonly manifestPath: string;
  readonly metadata: {
    readonly bunVersion: string;
    readonly bytes: number;
    readonly executable: "jixu";
    readonly package: JixuCliTarget["packageName"];
    readonly schemaVersion: 1;
    readonly sha256: string;
    readonly signed: boolean;
    readonly target: JixuCliTarget["id"];
    readonly version: string;
  };
  readonly target: JixuCliTarget;
}

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

async function signMacExecutable(binaryPath: string): Promise<void> {
  const identity = process.env.JIXU_CODESIGN_IDENTITY ?? "-";
  if (process.env.JIXU_PUBLIC_RELEASE === "1") {
    assert.notEqual(
      identity,
      "-",
      "public macOS releases require JIXU_CODESIGN_IDENTITY",
    );
  }
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
      identity,
      "--force",
      ...(process.env.JIXU_PUBLIC_RELEASE === "1" ? ["--timestamp"] : []),
      binaryPath,
    ],
    { cwd: repositoryRoot },
  );
  await runCommand("codesign", ["-vvv", "--verify", binaryPath], {
    cwd: repositoryRoot,
  });
}

async function buildCliArtifact(
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

  if (target.platform === "darwin") await signMacExecutable(binaryPath);

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
    schemaVersion: 1 as const,
    sha256: sha256(bytes),
    signed: target.platform === "darwin",
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

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const artifact = await buildHostCliArtifact();
  console.log(
    `${artifact.metadata.package}@${artifact.metadata.version} ${artifact.metadata.sha256.slice(0, 12)} ${artifact.binaryPath}`,
  );
}
