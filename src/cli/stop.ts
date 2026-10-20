import { readFile, rm } from "node:fs/promises";
import { pidPath } from "../config.ts";

export async function stopCommand(pidFile = pidPath()): Promise<void> {
  let pid: number;
  try {
    const text = await readFile(pidFile, "utf8");
    pid = parseInt(text.trim(), 10);
  } catch {
    console.error("Cora is not running (no PID file found).");
    process.exitCode = 1;
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`♥ Sent SIGTERM to Cora (PID ${pid})`);
    await rm(pidFile);
  } catch {
    console.error(`Failed to stop Cora (PID ${pid}). Process may have already exited.`);
    try {
      await rm(pidFile);
    } catch {
      /* ignore */
    }
  }
}
