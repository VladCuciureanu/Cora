import { readFile, rm } from "node:fs/promises";
import { pidPath } from "../config.ts";

export async function stopCommand({
  pidFile = pidPath(),
}: {
  pidFile?: string;
} = {}): Promise<void> {
  let pid: number;
  try {
    const text = await readFile(pidFile, "utf8");
    pid = parseInt(text.trim(), 10);
  } catch {
    console.error("cora: Cora is not running (no PID file found).");
    process.exitCode = 1;
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`♥ Sent SIGTERM to Cora (PID ${pid})`);
    await rm(pidFile);
  } catch {
    console.error(`cora: Failed to stop Cora (PID ${pid}). Process may have already exited.`);
    process.exitCode = 1;
    try {
      await rm(pidFile);
    } catch {
      /* ignore */
    }
  }
}
