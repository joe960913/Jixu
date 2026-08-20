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
import { NODE_TOOL_NAMES } from "@jixu/tools-node";

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
export type JixuToolName = (typeof NODE_TOOL_NAMES)[number];
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
    readonly api: JixuApi;
    readonly baseUrl: string;
    readonly model: string;
  };
  readonly tools: JixuToolSettings;
  readonly version: 4;
}

interface LegacySettingsFile {
  readonly connection: SettingsFile["connection"];
  readonly version: 3;
}

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
): JixuToolSettings => Object.freeze({
  enabled: Object.freeze([...NODE_TOOL_NAMES]),
  fileScope,
  permissions: Object.freeze({
    profile,
    rules: Object.freeze([]),
  }),
});

export const DEFAULT_JIXU_TOOL_SETTINGS = defaultToolSettings(
  "workspace",
  "balanced",
);

const LEGACY_JIXU_TOOL_SETTINGS = defaultToolSettings(
  "process",
  "unrestricted",
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
  return typeof value === "string" && NODE_TOOL_NAMES.includes(value as JixuToolName);
}

function isFileScope(value: unknown): value is JixuFileScope {
  return value === "workspace" || value === "process";
}

function isPermissionProfile(
  value: unknown,
): value is JixuToolPermissionProfile {
  return value === "balanced" || value === "review" || value === "unrestricted";
}

function parseToolSettings(value: unknown): JixuToolSettings {
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
  });
}

function parseSettings(value: unknown): LegacySettingsFile | SettingsFile {
  if (!isRecord(value)) {
    throw new TypeError("settings.json must contain an object");
  }
  if ((value.version !== 3 && value.version !== 4) || !isRecord(value.connection)) {
    throw new TypeError("settings.json must use Jixu settings schema version 3 or 4");
  }
  const { api, baseUrl, model } = value.connection;
  if (!isApi(api)) {
    throw new TypeError("settings.json api is invalid");
  }
  if (!nonEmptyString(baseUrl) || !nonEmptyString(model)) {
    throw new TypeError("settings.json connection is incomplete");
  }
  const connection = {
    api,
    baseUrl: normalizeJixuBaseUrl(baseUrl),
    model: model.trim(),
  };
  if (value.version === 3) {
    return { connection, version: 3 };
  }
  return {
    connection: {
      ...connection,
    },
    tools: parseToolSettings(value.tools),
    version: 4,
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
    if (process.platform !== "win32") await chmod(path, mode);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function normalizeConfiguration(
  settings: SettingsFile | null,
  auth: AuthFile | null,
): JixuStoredConfiguration {
  return {
    ...(settings === null
      ? {}
      : {
          api: settings.connection.api,
          baseUrl: settings.connection.baseUrl,
          model: settings.connection.model,
        }),
    ...(auth === null ? {} : { apiKey: auth.connection.key }),
    tools: settings?.tools ?? DEFAULT_JIXU_TOOL_SETTINGS,
  };
}

function migrateSettings(settings: LegacySettingsFile): SettingsFile {
  return {
    connection: settings.connection,
    tools: LEGACY_JIXU_TOOL_SETTINGS,
    version: 4,
  };
}

export class JixuConfigStore {
  readonly authPath: string;
  readonly directory: string;
  readonly settingsPath: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(directory = join(homedir(), ".jixu")) {
    this.directory = directory;
    this.authPath = join(directory, "auth.json");
    this.settingsPath = join(directory, "settings.json");
  }

  async #secureDirectory(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
  }

  async load(): Promise<JixuStoredConfiguration> {
    await this.#secureDirectory();
    const [loadedSettings, auth] = await Promise.all([
      readJson(this.settingsPath, "settings.json", parseSettings),
      readJson(this.authPath, "auth.json", parseAuth),
    ]);
    const settings =
      loadedSettings?.version === 3
        ? migrateSettings(loadedSettings)
        : loadedSettings;
    if (loadedSettings?.version === 3) {
      await atomicJsonWrite(
        this.directory,
        this.settingsPath,
        settings,
        0o600,
      );
    }
    if (auth !== null && process.platform !== "win32") {
      await chmod(this.authPath, 0o600);
    }
    return normalizeConfiguration(settings, auth);
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
      await atomicJsonWrite(this.directory, this.authPath, {
        connection: { key: apiKey, type: "api_key" },
        version: 3,
      } satisfies AuthFile, 0o600);
      await atomicJsonWrite(this.directory, this.settingsPath, {
        connection: { api: config.api, baseUrl, model },
        tools,
        version: 4,
      } satisfies SettingsFile, 0o600);
    });
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
