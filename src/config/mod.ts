import { join } from "@std/path";
import { ensureDir } from "@std/fs";

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
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return join(home, ".config", "cora");
}

function configPath(): string {
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

export async function loadConfig(): Promise<CoraConfig | null> {
  try {
    const text = await Deno.readTextFile(configPath());
    return { ...DEFAULTS, ...JSON.parse(text) };
  } catch {
    return null;
  }
}

export async function saveConfig(config: CoraConfig): Promise<void> {
  await ensureDir(configDir());
  await Deno.writeTextFile(configPath(), JSON.stringify(config, null, 2) + "\n");
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
