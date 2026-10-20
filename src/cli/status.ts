import { readFile } from "node:fs/promises";
import { pidPath, requireConfig } from "../config.ts";

export async function statusCommand({
  configPath,
  pidFile = pidPath(),
}: {
  configPath?: string;
  pidFile?: string;
} = {}): Promise<void> {
  const config = await requireConfig(configPath);

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

  // The latest BPM is only served to holders of the API key
  try {
    const res = await fetch(`http://localhost:${config.port}/status`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      await res.body?.cancel();
      console.log(`  Could not read status endpoint (HTTP ${res.status}).`);
      return;
    }
    const data = await res.json();
    console.log(`  Current BPM: ${data.bpm ?? "no data yet"}`);
  } catch {
    console.log("  Could not reach status endpoint.");
  }
}
