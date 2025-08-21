import { loadConfig, pidPath } from "../config/mod.ts";
import { GitEngine } from "../git/mod.ts";
import { BeatBuffer } from "../beats/mod.ts";
import { OfflineQueue } from "../queue/mod.ts";
import { MockHeart } from "../mock/heart.ts";

function parseArgs(args: string[]): { speed: number; startDate: Date | null; endDate: Date | null } {
  let speed = 1;
  let startDate: Date | null = null;
  let endDate: Date | null = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      startDate = new Date(args[++i]);
      if (isNaN(startDate.getTime())) {
        console.error(`Invalid --from date: ${args[i]}`);
        Deno.exit(1);
      }
    } else if (args[i] === "--to" && args[i + 1]) {
      endDate = new Date(args[++i]);
      if (isNaN(endDate.getTime())) {
        console.error(`Invalid --to date: ${args[i]}`);
        Deno.exit(1);
      }
    } else if (args[i] === "--speed" && args[i + 1]) {
      speed = parseFloat(args[++i]);
    } else if (!args[i].startsWith("--")) {
      speed = parseFloat(args[i]);
    }
  }

  if (isNaN(speed) || speed <= 0) {
    console.error("Speed must be a positive number (e.g. 60 = 1 hour/min, 1440 = 1 day/min)");
    Deno.exit(1);
  }

  return { speed, startDate, endDate };
}

export async function mockCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    Deno.exit(1);
  }

  const { speed, startDate, endDate } = parseArgs(Deno.args);
  const backfillMode = startDate !== null;
  const backfillEnd = endDate ?? new Date();

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

  // --- Backfill mode: generate all beats synchronously, then exit ---
  if (backfillMode) {
    console.log(`♥ Backfilling from ${startDate!.toISOString()} to ${backfillEnd.toISOString()}`);

    let simTime = startDate!.getTime();
    const endTime = backfillEnd.getTime();
    let lastDay = new Date(simTime).getDate();
    let lastFlush = simTime;
    let totalBaselines = 0;

    while (simTime < endTime) {
      simTime += 5000; // advance 5 simulated seconds per tick
      const simDate = new Date(simTime);

      const currentDay = simDate.getDate();
      if (currentDay !== lastDay) {
        heart.replanDay();
        lastDay = currentDay;
        console.log(`\n— ${simDate.toISOString().slice(0, 10)} — ${heart.getActivityPlan().length} activities`);
      }

      const bpm = heart.bpmAt(simDate);
      await buffer.addSample({
        timestamp: simDate.toISOString(),
        bpm,
        rrIntervals: [Math.round(60000 / bpm)],
      });

      if (simTime - lastFlush >= config.commitIntervalMs) {
        await buffer.flushWindow();
        lastFlush = simTime;
        totalBaselines++;
      }
    }

    // Flush remaining
    await buffer.flushWindow();
    await gitEngine.shutdown();
    try { await Deno.remove(pidPath()); } catch { /* ignore */ }

    const days = Math.ceil((endTime - startDate!.getTime()) / 86_400_000);
    console.log(`\n✓ Backfill complete: ~${totalBaselines} baselines across ${days} day(s)`);
    return;
  }

  // --- Live mode: generate beats in real-time (with speed multiplier) ---
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

  const sampleIntervalReal = Math.max(50, 5000 / speed);
  const simStepMs = 5000;

  const ticker = setInterval(async () => {
    simTime += simStepMs;
    const simDate = new Date(simTime);

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
