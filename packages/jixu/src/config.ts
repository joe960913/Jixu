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

export type JixuApi =
  | "anthropic-messages"
  | "openai-chat-completions";

export interface JixuConnectionConfig {
  readonly api: JixuApi;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface JixuStoredConfiguration {
  readonly api?: JixuApi;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

interface SettingsFile {
  readonly connection: {
    readonly api: JixuApi;
    readonly baseUrl: string;
    readonly model: string;
  };
  readonly version: 3;
}

interface AuthFile {
  readonly connection: {
    readonly key: string;
    readonly type: "api_key";
  };
  readonly version: 3;
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

function parseSettings(value: unknown): SettingsFile {
  if (!isRecord(value)) {
    throw new TypeError("settings.json must contain an object");
  }
  if (value.version !== 3 || !isRecord(value.connection)) {
    throw new TypeError("settings.json must use Jixu settings schema version 3");
  }
  const { api, baseUrl, model } = value.connection;
  if (!isApi(api)) {
    throw new TypeError("settings.json api is invalid");
  }
  if (!nonEmptyString(baseUrl) || !nonEmptyString(model)) {
    throw new TypeError("settings.json connection is incomplete");
  }
  return {
    connection: {
      api,
      baseUrl: normalizeJixuBaseUrl(baseUrl),
      model: model.trim(),
    },
    version: 3,
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
    if (!isApi(config.api)) throw new TypeError("LLM API is invalid");
    const apiKey = config.apiKey.trim();
    const baseUrl = normalizeJixuBaseUrl(config.baseUrl);
    const model = config.model.trim();
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
        version: 3,
      } satisfies SettingsFile, 0o600);
    });
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
