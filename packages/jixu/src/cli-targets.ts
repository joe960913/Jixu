export type JixuCliArchitecture = "arm64" | "x64";
export type JixuCliLibc = "glibc" | "musl";
export type JixuCliPlatform = "darwin" | "linux";

export interface JixuCliTarget {
  readonly architecture: JixuCliArchitecture;
  readonly bunTarget: "bun-darwin-arm64" | "bun-linux-x64";
  readonly executable: "jixu";
  readonly id: "darwin-arm64" | "linux-x64";
  readonly libc?: "glibc";
  readonly packageDirectory: "cli-darwin-arm64" | "cli-linux-x64";
  readonly packageName: "jixu-cli-darwin-arm64" | "jixu-cli-linux-x64";
  readonly platform: JixuCliPlatform;
}

export interface JixuCliRuntime {
  readonly architecture: string;
  readonly libc?: JixuCliLibc;
  readonly platform: string;
}

export const JIXU_CLI_TARGETS = Object.freeze([
  {
    architecture: "arm64",
    bunTarget: "bun-darwin-arm64",
    executable: "jixu",
    id: "darwin-arm64",
    packageDirectory: "cli-darwin-arm64",
    packageName: "jixu-cli-darwin-arm64",
    platform: "darwin",
  },
  {
    architecture: "x64",
    bunTarget: "bun-linux-x64",
    executable: "jixu",
    id: "linux-x64",
    libc: "glibc",
    packageDirectory: "cli-linux-x64",
    packageName: "jixu-cli-linux-x64",
    platform: "linux",
  },
] as const satisfies readonly JixuCliTarget[]);

export function detectJixuLinuxLibc(
  header?: Readonly<Record<string, unknown>>,
): JixuCliLibc {
  const detected =
    header ??
    (process.report.getReport() as {
      readonly header?: Readonly<Record<string, unknown>>;
    }).header ??
    {};
  return typeof detected.glibcVersionRuntime === "string" ? "glibc" : "musl";
}

export function currentJixuCliRuntime(): JixuCliRuntime {
  return {
    architecture: process.arch,
    platform: process.platform,
    ...(process.platform === "linux" ? { libc: detectJixuLinuxLibc() } : {}),
  };
}

export function selectJixuCliTarget(
  runtime: JixuCliRuntime,
): JixuCliTarget | undefined {
  return JIXU_CLI_TARGETS.find(
    (target) =>
      target.platform === runtime.platform &&
      target.architecture === runtime.architecture &&
      (target.platform !== "linux" || target.libc === runtime.libc),
  );
}

export function describeJixuCliRuntime(runtime: JixuCliRuntime): string {
  return [runtime.platform, runtime.architecture, runtime.libc]
    .filter((part) => part !== undefined)
    .join("/");
}

export function describeSupportedJixuCliTargets(): string {
  return JIXU_CLI_TARGETS.map((target) =>
    [
      target.platform,
      target.architecture,
      "libc" in target ? target.libc : undefined,
    ]
      .filter((part) => part !== undefined)
      .join("/"),
  ).join(", ");
}
