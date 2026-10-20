import { randomBytes } from "node:crypto";
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

function configDir(): string {
  return join(homedir(), ".config", "cora");
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

export async function loadConfig(path = configPath()): Promise<CoraConfig | null> {
  try {
    const text = await readFile(path, "utf8");
    return { ...DEFAULTS, ...JSON.parse(text) };
  } catch {
    return null;
  }
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
