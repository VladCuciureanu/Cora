import { requireConfig } from "../config.ts";
import { GitEngine } from "../git.ts";
import { OfflineQueue } from "../queue.ts";

/**
 * Commit every queued entry in order. Entries that fail to commit stay in the
 * queue for the next replay.
 */
export function replayQueue(
  queue: OfflineQueue,
  gitEngine: GitEngine,
): ReturnType<OfflineQueue["process"]> {
  return queue.process((entry) =>
    entry.type === "baseline"
      ? gitEngine.commitBaseline(entry.data)
      : gitEngine.commitEvent(entry.data),
  );
}

export async function replayCommand(): Promise<void> {
  const config = await requireConfig();

  const queue = new OfflineQueue();
  const total = await queue.size();

  if (total === 0) {
    console.log("No queued beats to replay.");
    return;
  }

  console.log(`♥ Replaying ${total} queued beat(s)...`);

  const gitEngine = new GitEngine();
  await gitEngine.init(config);

  let result: Awaited<ReturnType<typeof replayQueue>>;
  try {
    result = await replayQueue(queue, gitEngine);
    for (const { error } of result.failed) {
      console.error(`Failed to replay entry: ${error}`);
    }
  } finally {
    await gitEngine.shutdown();
  }
  const { processed, failed } = result;
  console.log(
    `✓ Replayed ${processed} beat(s)${failed.length > 0 ? `, ${failed.length} failed (kept in queue)` : ""}.`,
  );
}
