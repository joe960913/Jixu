import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  defineToolPermissionPolicy,
  resolveToolPermission,
} from "@jixu/core";
import type {
  ToolPermissionEffect,
  ToolPermissionPolicy,
  ToolPermissionRule,
} from "@jixu/core";
import {
  JINA_TOOL_NAMES,
  type JinaWebSearchToolName,
} from "@jixu/tools-jina";
import { NODE_TOOL_NAMES } from "@jixu/tools-node";
import type { NodeToolName } from "@jixu/tools-node";

export type JixuApi =
  | "anthropic-messages"
  | "openai-chat-completions";

export interface JixuConnectionConfig {
  readonly api: JixuApi;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly tools: JixuToolSettings;
}

export type JixuFileScope = "process" | "workspace";
export type JixuToolName = NodeToolName | JinaWebSearchToolName;
export type JixuToolPermissionProfile =
  | "balanced"
  | "review"
  | "unrestricted";

export interface JixuToolSettings {
  readonly enabled: readonly JixuToolName[];
  readonly fileScope: JixuFileScope;
  readonly permissions: {
    readonly profile: JixuToolPermissionProfile;
    readonly rules: readonly ToolPermissionRule[];
  };
  readonly webSearch: {
    readonly apiKey?: string;
    readonly provider: "jina";
  };
}

export interface JixuStoredConfiguration {
  readonly api?: JixuApi;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly tools: JixuToolSettings;
}

interface SettingsFile {
  readonly connection: {
    readonly api?: JixuApi;
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly model?: string;
  };
  readonly tools: JixuToolSettings;
  readonly version: 5;
}

type LegacySettingsFile =
  | {
      readonly connection: {
        readonly api: JixuApi;
        readonly baseUrl: string;
        readonly model: string;
      };
      readonly version: 3;
    }
  | {
      readonly connection: {
        readonly api: JixuApi;
        readonly baseUrl: string;
        readonly model: string;
      };
      readonly tools: Omit<JixuToolSettings, "webSearch">;
      readonly version: 4;
    };

interface AuthFile {
  readonly connection: {
    readonly key: string;
    readonly type: "api_key";
  };
  readonly version: 3;
}

const defaultToolSettings = (
  fileScope: JixuFileScope,
  profile: JixuToolPermissionProfile,
  enabled: readonly JixuToolName[],
): JixuToolSettings => Object.freeze({
  enabled: Object.freeze([...enabled]),
  fileScope,
  permissions: Object.freeze({
    profile,
    rules: Object.freeze([]),
  }),
  webSearch: Object.freeze({ provider: "jina" }),
});

export const FIRST_PARTY_JIXU_TOOL_NAMES = Object.freeze([
  ...NODE_TOOL_NAMES,
  ...JINA_TOOL_NAMES,
] as const);

export const DEFAULT_JIXU_TOOL_SETTINGS = defaultToolSettings(
  "workspace",
  "balanced",
  FIRST_PARTY_JIXU_TOOL_NAMES,
);

const LEGACY_JIXU_TOOL_SETTINGS = defaultToolSettings(
  "process",
  "unrestricted",
  NODE_TOOL_NAMES,
);

const PROFILE_RULES = {
  balanced: [
    { action: "read", effect: "allow", resource: "*" },
    { action: "write", effect: "allow", resource: "*" },
    { action: "edit", effect: "allow", resource: "*" },
  ],
  review: [{ action: "read", effect: "allow", resource: "*" }],
  unrestricted: [],
} as const satisfies Record<
  JixuToolPermissionProfile,
  readonly ToolPermissionRule[]
>;

function defaultPermissionEffect(
  profile: JixuToolPermissionProfile,
): ToolPermissionEffect {
  return profile === "unrestricted" ? "allow" : "ask";
}

export function jixuToolPermissionPolicy(
  settings: JixuToolSettings,
): ToolPermissionPolicy {
  return defineToolPermissionPolicy({
    defaultEffect: defaultPermissionEffect(settings.permissions.profile),
    rules: [
      ...PROFILE_RULES[settings.permissions.profile],
      ...settings.permissions.rules,
    ],
  });
}

export function effectiveJixuToolPermission(
  settings: JixuToolSettings,
  action: string,
  resource = "*",
): ToolPermissionEffect {
  return resolveToolPermission(jixuToolPermissionPolicy(settings), {
    action,
    resources: [resource],
  }).effect;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApi(value: unknown): value is JixuApi {
  return (
    value === "openai-chat-completions" || value === "anthropic-messages"
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function errorCode(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return undefined;
}

export function normalizeJixuBaseUrl(value: string): string {
  const clean = value.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    throw new TypeError("Base URL must be a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Base URL must use HTTP or HTTPS");
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError("Base URL must not contain credentials, query, or fragment");
  }
  return clean;
}

function isToolName(value: unknown): value is JixuToolName {
  return (
    typeof value === "string" &&
    FIRST_PARTY_JIXU_TOOL_NAMES.includes(value as JixuToolName)
  );
}

function isFileScope(value: unknown): value is JixuFileScope {
  return value === "workspace" || value === "process";
}

function isPermissionProfile(
  value: unknown,
): value is JixuToolPermissionProfile {
  return value === "balanced" || value === "review" || value === "unrestricted";
}

function parseWebSearchSettings(value: unknown): JixuToolSettings["webSearch"] {
  if (!isRecord(value)) {
    throw new TypeError("settings.json tools.webSearch must contain an object");
  }
  if (value.provider !== "jina") {
    throw new TypeError("settings.json tools.webSearch.provider must be jina");
  }
  if (value.apiKey !== undefined && !nonEmptyString(value.apiKey)) {
    throw new TypeError("settings.json tools.webSearch.apiKey is invalid");
  }
  return Object.freeze({
    ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey.trim() }),
    provider: "jina" as const,
  });
}

function parseToolSettings(
  value: unknown,
  options: { readonly legacy?: boolean } = {},
): JixuToolSettings {
  if (!isRecord(value)) {
    throw new TypeError("settings.json tools must contain an object");
  }
  if (!Array.isArray(value.enabled)) {
    throw new TypeError("settings.json tools.enabled must be an array");
  }
  const enabled = value.enabled.map((name, index) => {
    if (!isToolName(name)) {
      throw new TypeError(
        `settings.json tools.enabled[${index}] is not a registered first-party Tool`,
      );
    }
    return name;
  });
  if (new Set(enabled).size !== enabled.length) {
    throw new TypeError("settings.json tools.enabled contains duplicates");
  }
  if (!isFileScope(value.fileScope)) {
    throw new TypeError("settings.json tools.fileScope is invalid");
  }
  if (!isRecord(value.permissions)) {
    throw new TypeError("settings.json tools.permissions must contain an object");
  }
  if (!isPermissionProfile(value.permissions.profile)) {
    throw new TypeError("settings.json tools.permissions.profile is invalid");
  }
  if (!Array.isArray(value.permissions.rules)) {
    throw new TypeError("settings.json tools.permissions.rules must be an array");
  }
  const policy = defineToolPermissionPolicy({
    defaultEffect: "ask",
    rules: value.permissions.rules.map((rule, index) => {
      if (!isRecord(rule)) {
        throw new TypeError(
          `settings.json tools.permissions.rules[${index}] must be an object`,
        );
      }
      return {
        action: rule.action as string,
        effect: rule.effect as ToolPermissionEffect,
        resource: rule.resource as string,
      };
    }),
  });
  return Object.freeze({
    enabled: Object.freeze(enabled),
    fileScope: value.fileScope,
    permissions: Object.freeze({
      profile: value.permissions.profile,
      rules: policy.rules,
    }),
    webSearch:
      options.legacy === true
        ? Object.freeze({ provider: "jina" as const })
        : parseWebSearchSettings(value.webSearch),
  });
}

function parseLegacyConnection(value: Record<string, unknown>): {
  readonly api: JixuApi;
  readonly baseUrl: string;
  readonly model: string;
} {
  const { api, baseUrl, model } = value;
  if (!isApi(api)) throw new TypeError("settings.json api is invalid");
  if (!nonEmptyString(baseUrl) || !nonEmptyString(model)) {
    throw new TypeError("settings.json connection is incomplete");
  }
  return {
    api,
    baseUrl: normalizeJixuBaseUrl(baseUrl),
    model: model.trim(),
  };
}

function parseSettings(value: unknown): LegacySettingsFile | SettingsFile {
  if (!isRecord(value)) {
    throw new TypeError("settings.json must contain an object");
  }
  if (
    (value.version !== 3 && value.version !== 4 && value.version !== 5) ||
    !isRecord(value.connection)
  ) {
    throw new TypeError(
      "settings.json must use Jixu settings schema version 3, 4, or 5",
    );
  }
  if (value.version === 3) {
    return { connection: parseLegacyConnection(value.connection), version: 3 };
  }
  if (value.version === 4) {
    const tools = parseToolSettings(value.tools, { legacy: true });
    return {
      connection: parseLegacyConnection(value.connection),
      tools: {
        enabled: tools.enabled,
        fileScope: tools.fileScope,
        permissions: tools.permissions,
      },
      version: 4,
    };
  }
  const connection: SettingsFile["connection"] = {
    ...(value.connection.api === undefined
      ? {}
      : isApi(value.connection.api)
        ? { api: value.connection.api }
        : (() => {
            throw new TypeError("settings.json api is invalid");
          })()),
    ...(value.connection.apiKey === undefined
      ? {}
      : nonEmptyString(value.connection.apiKey)
        ? { apiKey: value.connection.apiKey.trim() }
        : (() => {
            throw new TypeError("settings.json connection.apiKey is invalid");
          })()),
    ...(value.connection.baseUrl === undefined
      ? {}
      : nonEmptyString(value.connection.baseUrl)
        ? { baseUrl: normalizeJixuBaseUrl(value.connection.baseUrl) }
        : (() => {
            throw new TypeError("settings.json connection.baseUrl is invalid");
          })()),
    ...(value.connection.model === undefined
      ? {}
      : nonEmptyString(value.connection.model)
        ? { model: value.connection.model.trim() }
        : (() => {
            throw new TypeError("settings.json connection.model is invalid");
          })()),
  };
  return {
    connection,
    tools: parseToolSettings(value.tools),
    version: 5,
  };
}

function parseAuth(value: unknown): AuthFile {
  if (!isRecord(value)) throw new TypeError("auth.json must contain an object");
  if (value.version !== 3 || !isRecord(value.connection)) {
    throw new TypeError("auth.json must use Jixu auth schema version 3");
  }
  if (
    value.connection.type !== "api_key" ||
    !nonEmptyString(value.connection.key)
  ) {
    throw new TypeError("auth.json connection credential is invalid");
  }
  return {
    connection: { key: value.connection.key, type: "api_key" },
    version: 3,
  };
}

async function readJson<TValue>(
  path: string,
  label: string,
  parse: (value: unknown) => TValue,
): Promise<TValue | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    return parse(JSON.parse(source) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new TypeError(`Could not load ${label}: ${message}`);
  }
}

async function atomicJsonWrite(
  directory: string,
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function normalizeConfiguration(
  settings: SettingsFile | null,
): JixuStoredConfiguration {
  return {
    ...(settings === null
      ? {}
      : {
          ...(settings.connection.api === undefined
            ? {}
            : { api: settings.connection.api }),
          ...(settings.connection.apiKey === undefined
            ? {}
            : { apiKey: settings.connection.apiKey }),
          ...(settings.connection.baseUrl === undefined
            ? {}
            : { baseUrl: settings.connection.baseUrl }),
          ...(settings.connection.model === undefined
            ? {}
            : { model: settings.connection.model }),
        }),
    tools: settings?.tools ?? DEFAULT_JIXU_TOOL_SETTINGS,
  };
}

function migrateSettings(
  settings: LegacySettingsFile | null,
  auth: AuthFile | null,
): SettingsFile | null {
  if (settings === null && auth === null) return null;
  const tools = settings === null
    ? DEFAULT_JIXU_TOOL_SETTINGS
    : settings.version === 3
      ? LEGACY_JIXU_TOOL_SETTINGS
      : {
          ...settings.tools,
          webSearch: { provider: "jina" as const },
        };
  return {
    connection: {
      ...(settings === null ? {} : settings.connection),
      ...(auth === null ? {} : { apiKey: auth.connection.key }),
    },
    tools,
    version: 5,
  };
}

export class JixuConfigStore {
  readonly #legacyAuthPath: string;
  readonly directory: string;
  readonly settingsPath: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(directory = join(homedir(), ".jixu")) {
    this.directory = directory;
    this.#legacyAuthPath = join(directory, "auth.json");
    this.settingsPath = join(directory, "settings.json");
  }

  async #secureDirectory(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    await chmod(this.directory, 0o700);
  }

  async load(): Promise<JixuStoredConfiguration> {
    await this.#secureDirectory();
    const [loadedSettings, auth] = await Promise.all([
      readJson(this.settingsPath, "settings.json", parseSettings),
      readJson(this.#legacyAuthPath, "auth.json", parseAuth),
    ]);
    let settings = loadedSettings?.version === 5
      ? loadedSettings
      : migrateSettings(loadedSettings, auth);
    if (loadedSettings?.version === 5 && auth !== null) {
      settings = {
        ...loadedSettings,
        connection: {
          ...loadedSettings.connection,
          apiKey: loadedSettings.connection.apiKey ?? auth.connection.key,
        },
      };
    }
    if (settings !== null && (loadedSettings?.version !== 5 || auth !== null)) {
      await atomicJsonWrite(
        this.directory,
        this.settingsPath,
        settings,
        0o600,
      );
      await unlink(this.#legacyAuthPath).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
    if (settings !== null) {
      await chmod(this.settingsPath, 0o600);
    }
    return normalizeConfiguration(settings);
  }

  async saveConnection(config: JixuConnectionConfig): Promise<void> {
    if (!isApi(config.api)) throw new TypeError("LLM API is invalid");
    const apiKey = config.apiKey.trim();
    const baseUrl = normalizeJixuBaseUrl(config.baseUrl);
    const model = config.model.trim();
    const tools = parseToolSettings(config.tools);
    if (apiKey.length === 0) throw new TypeError("API Key must not be empty");
    if (model.length === 0) throw new TypeError("Model ID must not be empty");

    const operation = this.#writeTail.then(async () => {
      await this.#secureDirectory();
      await atomicJsonWrite(this.directory, this.settingsPath, {
        connection: { api: config.api, apiKey, baseUrl, model },
        tools,
        version: 5,
      } satisfies SettingsFile, 0o600);
      await unlink(this.#legacyAuthPath).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    });
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
