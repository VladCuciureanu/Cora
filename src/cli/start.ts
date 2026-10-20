import { rm, writeFile } from "node:fs/promises";
import { BeatBuffer, type BeatListener } from "../beats.ts";
import { pidPath, requireConfig } from "../config.ts";
import { type CommitEntry, GitEngine } from "../git.ts";
import { OfflineQueue } from "../queue.ts";
import { IngestionServer } from "../server.ts";
import { replayQueue } from "./replay.ts";

/**
 * Commit baselines and events as they arrive; anything that fails to commit is
 * queued for replay. `onCommitted` is told about each successful commit.
 */
export function commitListener(
  gitEngine: GitEngine,
  queue: OfflineQueue,
  onCommitted?: (entry: CommitEntry) => void,
): BeatListener {
  return {
    onBaseline: async (data) => {
      try {
        await gitEngine.commitBaseline(data);
        onCommitted?.({ type: "baseline", data });
      } catch (e) {
        console.error(`Baseline commit failed, queuing: ${e}`);
        await queue.enqueue({ type: "baseline", data });
      }
    },
    onEvent: async (data) => {
      try {
        await gitEngine.commitEvent(data);
        onCommitted?.({ type: "event", data });
      } catch (e) {
        console.error(`Event commit failed, queuing: ${e}`);
        await queue.enqueue({ type: "event", data });
      }
    },
  };
}

export async function startCommand(): Promise<void> {
  const config = await requireConfig();

  const gitEngine = new GitEngine();
  await gitEngine.init(config);
  console.log("✓ Git repo ready");

  const queue = new OfflineQueue();
  const buffer = new BeatBuffer(config.eventThresholdPercent);
  buffer.setListener(commitListener(gitEngine, queue));
  let baselineTimer: ReturnType<typeof setInterval> | undefined;
  const server = new IngestionServer(buffer, config.apiKey, config.port);

  try {
    // Replay any queued beats from previous sessions; failures stay queued
    const queuedCount = await queue.size();
    if (queuedCount > 0) {
      console.log(`♥ Replaying ${queuedCount} queued beat(s)...`);
      const { failed } = await replayQueue(queue, gitEngine);
      for (const { error } of failed) {
        console.error(`Replay failed, kept in queue: ${error}`);
      }
    }

    // Periodic baseline flush
    baselineTimer = setInterval(() => buffer.flushWindow(), config.commitIntervalMs);
    server.start();

    // Only advertise the PID once setup has succeeded
    await writeFile(pidPath(), String(process.pid));
  } catch (e) {
    // Release everything that would keep the process alive
    clearInterval(baselineTimer);
    server.stop();
    await gitEngine.shutdown();
    throw e;
  }

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
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
