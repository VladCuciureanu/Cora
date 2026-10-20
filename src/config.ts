import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CoraConfig {
  githubPat: string;
  repoUrl: string;
  apiKey: string;
  commitIntervalMs: number;
  eventThresholdPercent: number;
  port: number;
}

const DEFAULTS: Pick<CoraConfig, "commitIntervalMs" | "eventThresholdPercent" | "port"> = {
  commitIntervalMs: 5 * 60 * 1000,
  eventThresholdPercent: 20,
  port: 7331,
};

export interface ConfigDirInputs {
  homedir: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  note?: (message: string) => void;
}

/**
 * The config dir is `~/.config/cora` under `os.homedir()`. Before 0.2 it was
 * under `$HOME` (falling back to `%USERPROFILE%`), which differs on Windows
 * when HOME is set. If only that old location has a config, keep using it.
 */
export function resolveConfigDir({ homedir, env, exists, note }: ConfigDirInputs): string {
  const current = join(homedir, ".config", "cora");
  const legacy = join(env.HOME ?? env.USERPROFILE ?? ".", ".config", "cora");
  if (
    legacy !== current &&
    !exists(join(current, "config.json")) &&
    exists(join(legacy, "config.json"))
  ) {
    note?.(
      `Note: using the config in ${legacy}; move it to ${current} to use the new default location.`,
    );
    return legacy;
  }
  return current;
}

let legacyNoted = false;

function configDir(): string {
  return resolveConfigDir({
    homedir: homedir(),
    env: process.env,
    exists: existsSync,
    note: (message) => {
      if (legacyNoted) return;
      legacyNoted = true;
      console.error(message);
    },
  });
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function repoDir(): string {
  return join(configDir(), "repo");
}

export function pidPath(): string {
  return join(configDir(), "cora.pid");
}

export function queuePath(): string {
  return join(configDir(), "queue.jsonl");
}

export function isValidPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
}

/** Check a parsed config file's keys and value types, filling in defaults. */
function validateConfig(raw: unknown, path: string): CoraConfig {
  const invalid = (reason: string) => new Error(`Invalid config ${path}: ${reason}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("expected a JSON object");
  }
  const config: Record<string, unknown> = { ...DEFAULTS, ...raw };
  const strings = ["githubPat", "repoUrl", "apiKey"];
  const positives = ["commitIntervalMs", "eventThresholdPercent"];
  for (const key of Object.keys(config)) {
    if (![...strings, ...positives, "port"].includes(key)) throw invalid(`unknown key "${key}"`);
  }
  for (const key of strings) {
    if (typeof config[key] !== "string" || config[key] === "") {
      throw invalid(`"${key}" must be a non-empty string`);
    }
  }
  for (const key of positives) {
    const value = config[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw invalid(`"${key}" must be a positive number`);
    }
  }
  if (!isValidPort(config.port)) throw invalid(`"port" must be an integer from 1 to 65535`);
  return config as unknown as CoraConfig;
}

/**
 * Load and validate the config. Returns null when there is no config file;
 * a file that is not valid JSON or has bad keys or values is an error.
 */
export async function loadConfig(path = configPath()): Promise<CoraConfig | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Config ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return validateConfig(raw, path);
}

/** Load the config, failing with a hint to run `cora init` when there is none. */
export async function requireConfig(path?: string): Promise<CoraConfig> {
  const config = await loadConfig(path);
  if (!config) throw new Error("No config found. Run `cora init` first.");
  return config;
}

/** Write the config (it holds the GitHub PAT) readable by the owner only. */
export async function saveConfig(config: CoraConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing file too
  await chmod(path, 0o600);
}

export function generateApiKey(): string {
  return randomBytes(32).toString("hex");
}
