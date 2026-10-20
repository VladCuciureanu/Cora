import { readFile } from "node:fs/promises";
import { loadConfig, pidPath } from "../config.ts";

export async function statusCommand({
  configPath,
  pidFile = pidPath(),
}: {
  configPath?: string;
  pidFile?: string;
} = {}): Promise<void> {
  const config = await loadConfig(configPath);
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    process.exit(1);
  }

  // Check if process is running
  let running = false;
  let pid: number | null = null;
  try {
    const text = await readFile(pidFile, "utf8");
    pid = parseInt(text.trim(), 10);
    process.kill(pid, 0); // check if process exists
    running = true;
  } catch {
    running = false;
  }

  if (!running) {
    console.log("♥ Cora is not running.");
    return;
  }

  console.log(`♥ Cora is running (PID ${pid})`);
  console.log(`  Port: ${config.port}`);

  // Query health endpoint
  try {
    const res = await fetch(`http://localhost:${config.port}/health`);
    const data = await res.json();
    console.log(`  Current BPM: ${data.bpm ?? "no data yet"}`);
  } catch {
    console.log("  Could not reach health endpoint.");
  }
}
