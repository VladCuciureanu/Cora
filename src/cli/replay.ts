import { loadConfig } from "../config/mod.ts";
import { GitEngine } from "../git/mod.ts";
import { OfflineQueue } from "../queue/mod.ts";

export async function replayCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    Deno.exit(1);
  }

  const queue = new OfflineQueue();
  const entries = await queue.drain();

  if (entries.length === 0) {
    console.log("No queued beats to replay.");
    return;
  }

  console.log(`♥ Replaying ${entries.length} queued beat(s)...`);

  const gitEngine = new GitEngine();
  await gitEngine.init();

  let ok = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      if (entry.type === "baseline") {
        await gitEngine.commitBaseline(entry.data);
      } else {
        await gitEngine.commitEvent(entry.data);
      }
      ok++;
    } catch (e) {
      console.error(`Failed to replay entry: ${e}`);
      failed++;
    }
  }

  await gitEngine.shutdown();
  console.log(`✓ Replayed ${ok} beat(s)${failed > 0 ? `, ${failed} failed` : ""}.`);
}
