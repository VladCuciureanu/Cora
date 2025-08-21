import { loadConfig, pidPath } from "../config/mod.ts";
import { GitEngine } from "../git/mod.ts";
import { BeatBuffer } from "../beats/mod.ts";
import { IngestionServer } from "../server/mod.ts";

export async function startCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    Deno.exit(1);
  }

  // Write PID file
  await Deno.writeTextFile(pidPath(), String(Deno.pid));

  const gitEngine = new GitEngine();
  await gitEngine.init();
  console.log("✓ Git repo ready");

  const buffer = new BeatBuffer(config.commitIntervalMs, config.eventThresholdPercent);
  buffer.setListener({
    onBaseline: async (data) => {
      try {
        await gitEngine.commitBaseline(data);
      } catch (e) {
        console.error(`Baseline commit failed: ${e}`);
      }
    },
    onEvent: async (data) => {
      try {
        await gitEngine.commitEvent(data);
      } catch (e) {
        console.error(`Event commit failed: ${e}`);
      }
    },
  });

  // Periodic baseline flush
  const baselineTimer = setInterval(() => buffer.flushWindow(), config.commitIntervalMs);

  const server = new IngestionServer(buffer, config.apiKey, config.port);
  server.start();

  console.log(`♥ Cora is alive (PID ${Deno.pid})`);
  console.log(`  Baseline every ${config.commitIntervalMs / 1000}s | Event threshold ±${config.eventThresholdPercent}%`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n♥ Shutting down...");
    clearInterval(baselineTimer);
    server.stop();
    await buffer.flushWindow();
    await gitEngine.shutdown();
    try { await Deno.remove(pidPath()); } catch { /* ignore */ }
    console.log("♥ Goodbye.");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}
