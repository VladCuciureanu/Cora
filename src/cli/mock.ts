import { loadConfig, pidPath } from "../config/mod.ts";
import { GitEngine } from "../git/mod.ts";
import { BeatBuffer } from "../beats/mod.ts";
import { OfflineQueue } from "../queue/mod.ts";
import { MockHeart } from "../mock/heart.ts";

export async function mockCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    Deno.exit(1);
  }

  const speed = parseFloat(Deno.args[1] ?? "1");
  if (isNaN(speed) || speed <= 0) {
    console.error("Speed must be a positive number (e.g. 60 = 1 hour/min, 1440 = 1 day/min)");
    Deno.exit(1);
  }

  await Deno.writeTextFile(pidPath(), String(Deno.pid));

  const gitEngine = new GitEngine();
  await gitEngine.init();
  console.log("✓ Git repo ready");

  const queue = new OfflineQueue();
  const heart = new MockHeart();
  const buffer = new BeatBuffer(config.commitIntervalMs, config.eventThresholdPercent);

  buffer.setListener({
    onBaseline: async (data) => {
      try {
        await gitEngine.commitBaseline(data);
        console.log(`  ♥ baseline ${data.avgBpm}bpm (${data.minBpm}–${data.maxBpm}) x${data.beatCount}`);
      } catch (e) {
        console.error(`Baseline commit failed, queuing: ${e}`);
        await queue.enqueue({ type: "baseline", data });
      }
    },
    onEvent: async (data) => {
      try {
        await gitEngine.commitEvent(data);
        console.log(`  ⚡ ${data.kind} ${data.bpm}bpm`);
      } catch (e) {
        console.error(`Event commit failed, queuing: ${e}`);
        await queue.enqueue({ type: "event", data });
      }
    },
  });

  console.log(`♥ Mock heart started (speed: ${speed}x)`);
  console.log(`  1 real second = ${speed} simulated seconds`);
  if (speed >= 60) console.log(`  ≈ ${(speed / 60).toFixed(1)} simulated minutes per real second`);
  console.log(`  Commit interval: ${config.commitIntervalMs / 1000}s simulated`);
  console.log(`  Activities planned: ${heart.getActivityPlan().length}`);
  for (const act of heart.getActivityPlan()) {
    const h = Math.floor(act.startMinute / 60);
    const m = act.startMinute % 60;
    console.log(`    ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} — peak ${act.peakBpm}bpm for ${act.durationMin}min`);
  }
  console.log();

  let simTime = Date.now();
  let lastDay = new Date(simTime).getDate();
  let lastFlush = simTime;

  // Sample every ~5 simulated seconds (adjusting for speed)
  const sampleIntervalReal = Math.max(50, 5000 / speed); // ms between samples in real time
  const simStepMs = 5000; // always advance 5 simulated seconds per tick

  const ticker = setInterval(async () => {
    simTime += simStepMs;
    const simDate = new Date(simTime);

    // Replan activities at midnight
    const currentDay = simDate.getDate();
    if (currentDay !== lastDay) {
      heart.replanDay();
      lastDay = currentDay;
      console.log(`\n— New day: ${simDate.toISOString().slice(0, 10)} — ${heart.getActivityPlan().length} activities planned\n`);
    }

    const bpm = heart.bpmAt(simDate);
    await buffer.addSample({
      timestamp: simDate.toISOString(),
      bpm,
      rrIntervals: [Math.round(60000 / bpm)],
    });

    // Flush at commit interval (in simulated time)
    if (simTime - lastFlush >= config.commitIntervalMs) {
      await buffer.flushWindow();
      lastFlush = simTime;
    }
  }, sampleIntervalReal);

  const shutdown = async () => {
    console.log("\n♥ Stopping mock heart...");
    clearInterval(ticker);
    await buffer.flushWindow();
    await gitEngine.shutdown();
    try { await Deno.remove(pidPath()); } catch { /* ignore */ }
    console.log("♥ Goodbye.");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}
