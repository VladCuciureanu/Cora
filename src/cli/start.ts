import { rm, writeFile } from "node:fs/promises";
import { BeatBuffer, type BeatListener } from "../beats.ts";
import { loadConfig, pidPath } from "../config.ts";
import { GitEngine } from "../git.ts";
import { OfflineQueue } from "../queue.ts";
import { IngestionServer } from "../server.ts";
import { replayQueue } from "./replay.ts";

/** Commit baselines and events as they arrive; anything that fails to commit is queued for replay. */
export function commitListener(gitEngine: GitEngine, queue: OfflineQueue): BeatListener {
  return {
    onBaseline: async (data) => {
      try {
        await gitEngine.commitBaseline(data);
      } catch (e) {
        console.error(`Baseline commit failed, queuing: ${e}`);
        await queue.enqueue({ type: "baseline", data });
      }
    },
    onEvent: async (data) => {
      try {
        await gitEngine.commitEvent(data);
      } catch (e) {
        console.error(`Event commit failed, queuing: ${e}`);
        await queue.enqueue({ type: "event", data });
      }
    },
  };
}

export async function startCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    process.exit(1);
  }

  const gitEngine = new GitEngine();
  await gitEngine.init();
  console.log("✓ Git repo ready");

  const queue = new OfflineQueue();

  // Replay any queued beats from previous sessions; failures stay queued
  const queuedCount = await queue.size();
  if (queuedCount > 0) {
    console.log(`♥ Replaying ${queuedCount} queued beat(s)...`);
    const { failed } = await replayQueue(queue, gitEngine);
    for (const { error } of failed) {
      console.error(`Replay failed, kept in queue: ${error}`);
    }
  }

  const buffer = new BeatBuffer(config.eventThresholdPercent);
  buffer.setListener(commitListener(gitEngine, queue));

  // Periodic baseline flush
  const baselineTimer = setInterval(() => buffer.flushWindow(), config.commitIntervalMs);

  const server = new IngestionServer(buffer, config.apiKey, config.port);
  server.start();

  // Only advertise the PID once setup has succeeded
  await writeFile(pidPath(), String(process.pid));

  console.log(`♥ Cora is alive (PID ${process.pid})`);
  console.log(
    `  Baseline every ${config.commitIntervalMs / 1000}s | Event threshold ±${config.eventThresholdPercent}%`,
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n♥ Shutting down...");
    clearInterval(baselineTimer);
    server.stop();
    await buffer.flushWindow();
    await gitEngine.shutdown();
    try {
      await rm(pidPath());
    } catch {
      /* ignore */
    }
    console.log("♥ Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
