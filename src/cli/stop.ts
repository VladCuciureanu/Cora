import { pidPath } from "../config/mod.ts";

export async function stopCommand(): Promise<void> {
  let pid: number;
  try {
    const text = await Deno.readTextFile(pidPath());
    pid = parseInt(text.trim(), 10);
  } catch {
    console.error("Cora is not running (no PID file found).");
    Deno.exit(1);
  }

  try {
    Deno.kill(pid, "SIGTERM");
    console.log(`♥ Sent SIGTERM to Cora (PID ${pid})`);
    await Deno.remove(pidPath());
  } catch {
    console.error(`Failed to stop Cora (PID ${pid}). Process may have already exited.`);
    try { await Deno.remove(pidPath()); } catch { /* ignore */ }
  }
}
