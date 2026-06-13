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

export type JixuApiFormat = "chat-completions" | "responses";

export interface JixuConnectionConfig {
  readonly apiFormat: JixuApiFormat;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface JixuStoredConfiguration {
  readonly apiFormat?: JixuApiFormat;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

type LegacyProvider = "openai" | "openrouter";

interface LegacySettingsFile {
  readonly defaultProvider?: LegacyProvider;
  readonly models: Partial<Readonly<Record<LegacyProvider, string>>>;
  readonly version: 1;
}

interface LegacyAuthFile {
  readonly providers: Partial<
    Readonly<
      Record<LegacyProvider, { readonly key: string; readonly type: "api_key" }>
    >
  >;
  readonly version: 1;
}

interface SettingsFile {
  readonly connection: {
    readonly apiFormat: JixuApiFormat;
    readonly baseUrl: string;
    readonly model: string;
  };
  readonly version: 2;
}

interface AuthFile {
  readonly connection: {
    readonly key: string;
    readonly type: "api_key";
  };
  readonly version: 2;
}

type ParsedSettings = LegacySettingsFile | SettingsFile;
type ParsedAuth = AuthFile | LegacyAuthFile;

const LEGACY_BASE_URLS: Readonly<Record<LegacyProvider, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
const LEGACY_PROVIDERS = ["openai", "openrouter"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyProvider(value: unknown): value is LegacyProvider {
  return value === "openai" || value === "openrouter";
}

function isApiFormat(value: unknown): value is JixuApiFormat {
  return value === "responses" || value === "chat-completions";
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

function parseLegacySettings(value: Record<string, unknown>): LegacySettingsFile {
  if (!isRecord(value.models)) {
    throw new TypeError("settings.json must use Jixu settings schema version 1");
  }
  if (value.defaultProvider !== undefined && !isLegacyProvider(value.defaultProvider)) {
    throw new TypeError("settings.json defaultProvider is invalid");
  }
  const models: Partial<Record<LegacyProvider, string>> = {};
  for (const provider of LEGACY_PROVIDERS) {
    const model = value.models[provider];
    if (model === undefined) continue;
    if (!nonEmptyString(model)) {
      throw new TypeError(`settings.json model for ${provider} is invalid`);
    }
    models[provider] = model;
  }
  return {
    ...(value.defaultProvider === undefined
      ? {}
      : { defaultProvider: value.defaultProvider }),
    models,
    version: 1,
  };
}

function parseSettings(value: unknown): ParsedSettings {
  if (!isRecord(value)) {
    throw new TypeError("settings.json must contain an object");
  }
  if (value.version === 1) return parseLegacySettings(value);
  if (value.version !== 2 || !isRecord(value.connection)) {
    throw new TypeError("settings.json must use Jixu settings schema version 2");
  }
  const { apiFormat, baseUrl, model } = value.connection;
  if (!isApiFormat(apiFormat)) {
    throw new TypeError("settings.json apiFormat is invalid");
  }
  if (!nonEmptyString(baseUrl) || !nonEmptyString(model)) {
    throw new TypeError("settings.json connection is incomplete");
  }
  return {
    connection: {
      apiFormat,
      baseUrl: normalizeJixuBaseUrl(baseUrl),
      model: model.trim(),
    },
    version: 2,
  };
}

function parseLegacyAuth(value: Record<string, unknown>): LegacyAuthFile {
  if (!isRecord(value.providers)) {
    throw new TypeError("auth.json must use Jixu auth schema version 1");
  }
  const providers: Partial<
    Record<LegacyProvider, { readonly key: string; readonly type: "api_key" }>
  > = {};
  for (const provider of LEGACY_PROVIDERS) {
    const credential = value.providers[provider];
    if (credential === undefined) continue;
    if (
      !isRecord(credential) ||
      credential.type !== "api_key" ||
      !nonEmptyString(credential.key)
    ) {
      throw new TypeError(`auth.json credential for ${provider} is invalid`);
    }
    providers[provider] = { key: credential.key, type: "api_key" };
  }
  return { providers, version: 1 };
}

function parseAuth(value: unknown): ParsedAuth {
  if (!isRecord(value)) throw new TypeError("auth.json must contain an object");
  if (value.version === 1) return parseLegacyAuth(value);
  if (value.version !== 2 || !isRecord(value.connection)) {
    throw new TypeError("auth.json must use Jixu auth schema version 2");
  }
  if (
    value.connection.type !== "api_key" ||
    !nonEmptyString(value.connection.key)
  ) {
    throw new TypeError("auth.json connection credential is invalid");
  }
  return {
    connection: { key: value.connection.key, type: "api_key" },
    version: 2,
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
  settings: ParsedSettings | null,
  auth: ParsedAuth | null,
): JixuStoredConfiguration {
  if (settings !== null && auth !== null && settings.version !== auth.version) {
    throw new TypeError("settings.json and auth.json schema versions do not match");
  }

  if (settings?.version === 2 || auth?.version === 2) {
    const currentSettings = settings?.version === 2 ? settings : null;
    const currentAuth = auth?.version === 2 ? auth : null;
    return {
      ...(currentSettings === null
        ? {}
        : {
            apiFormat: currentSettings.connection.apiFormat,
            baseUrl: currentSettings.connection.baseUrl,
            model: currentSettings.connection.model,
          }),
      ...(currentAuth === null ? {} : { apiKey: currentAuth.connection.key }),
    };
  }

  const legacySettings = settings?.version === 1 ? settings : null;
  const legacyAuth = auth?.version === 1 ? auth : null;
  const provider = legacySettings?.defaultProvider;
  if (provider === undefined || legacySettings === null) return {};
  const model = legacySettings.models[provider];
  const apiKey = legacyAuth?.providers[provider]?.key;
  return {
    apiFormat: "responses",
    baseUrl: LEGACY_BASE_URLS[provider],
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(model === undefined ? {} : { model }),
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
    const [settings, auth] = await Promise.all([
      readJson(this.settingsPath, "settings.json", parseSettings),
      readJson(this.authPath, "auth.json", parseAuth),
    ]);
    if (auth !== null && process.platform !== "win32") {
      await chmod(this.authPath, 0o600);
    }
    return normalizeConfiguration(settings, auth);
  }

  async saveConnection(config: JixuConnectionConfig): Promise<void> {
    const apiKey = config.apiKey.trim();
    const baseUrl = normalizeJixuBaseUrl(config.baseUrl);
    const model = config.model.trim();
    if (apiKey.length === 0) throw new TypeError("API Key must not be empty");
    if (model.length === 0) throw new TypeError("Model ID must not be empty");

    const operation = this.#writeTail.then(async () => {
      await this.#secureDirectory();
      await atomicJsonWrite(this.directory, this.authPath, {
        connection: { key: apiKey, type: "api_key" },
        version: 2,
      } satisfies AuthFile, 0o600);
      await atomicJsonWrite(this.directory, this.settingsPath, {
        connection: { apiFormat: config.apiFormat, baseUrl, model },
        version: 2,
      } satisfies SettingsFile, 0o600);
    });
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
