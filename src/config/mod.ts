import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".config", "cora");
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

/** Write the config (it holds the GitHub PAT) readable by the owner only. */
export async function saveConfig(config: CoraConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing file too
  await chmod(path, 0o600);
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
