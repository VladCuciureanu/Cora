import { loadConfig, pidPath } from "../config/mod.ts";

export async function statusCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    Deno.exit(1);
  }

  // Check if process is running
  let running = false;
  let pid: number | null = null;
  try {
    const text = await Deno.readTextFile(pidPath());
    pid = parseInt(text.trim(), 10);
    Deno.kill(pid, "SIGCONT"); // check if process exists
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
