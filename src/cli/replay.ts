import { loadConfig } from "../config/mod.ts";
import { GitEngine } from "../git/mod.ts";
import { OfflineQueue } from "../queue/mod.ts";

/**
 * Commit every queued entry in order. Entries that fail to commit stay in the
 * queue for the next replay.
 */
export function replayQueue(
  queue: OfflineQueue,
  gitEngine: GitEngine,
): ReturnType<OfflineQueue["process"]> {
  return queue.process((entry) =>
    entry.type === "baseline" ? gitEngine.commitBaseline(entry.data) : gitEngine.commitEvent(entry.data)
  );
}

export async function replayCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    process.exit(1);
  }

  const queue = new OfflineQueue();
  const total = await queue.size();

  if (total === 0) {
    console.log("No queued beats to replay.");
    return;
  }

  console.log(`♥ Replaying ${total} queued beat(s)...`);

  const gitEngine = new GitEngine();
  await gitEngine.init();

  const { processed, failed } = await replayQueue(queue, gitEngine);
  for (const { error } of failed) {
    console.error(`Failed to replay entry: ${error}`);
  }

  await gitEngine.shutdown();
  console.log(
    `✓ Replayed ${processed} beat(s)${failed.length > 0 ? `, ${failed.length} failed (kept in queue)` : ""}.`,
  );
}
