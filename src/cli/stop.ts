import { readFile, rm } from "node:fs/promises";
import { pidPath } from "../config/mod.ts";

export async function stopCommand(): Promise<void> {
  let pid: number;
  try {
    const text = await readFile(pidPath(), "utf8");
    pid = parseInt(text.trim(), 10);
  } catch {
    console.error("Cora is not running (no PID file found).");
    process.exit(1);
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`♥ Sent SIGTERM to Cora (PID ${pid})`);
    await rm(pidPath());
  } catch {
    console.error(`Failed to stop Cora (PID ${pid}). Process may have already exited.`);
    try { await rm(pidPath()); } catch { /* ignore */ }
  }
}
