import { loadConfig, pidPath } from "../config/mod.ts";
import { GitEngine, type CommitEntry, type BaselineData } from "../git/mod.ts";
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

/** Generate all commit entries for a date range without touching git. */
function generateEntries(
  heart: MockHeart,
  startMs: number,
  endMs: number,
  commitIntervalMs: number,
  thresholdPercent: number,
): CommitEntry[] {
  const entries: CommitEntry[] = [];
  const sampleStepMs = 5000;

  let simTime = startMs;
  let lastDay = new Date(simTime).getDate();
  let windowSamples: { bpm: number; timestamp: string }[] = [];
  let lastFlush = simTime;
  const rollingBpms: number[] = [];

  while (simTime < endMs) {
    simTime += sampleStepMs;
    const simDate = new Date(simTime);

    const currentDay = simDate.getDate();
    if (currentDay !== lastDay) {
      heart.replanDay();
      lastDay = currentDay;
    }

    const bpm = heart.bpmAt(simDate);

    // Event detection against rolling average
    if (rollingBpms.length >= 5) {
      const avg = rollingBpms.reduce((a, b) => a + b, 0) / rollingBpms.length;
      const deviation = Math.abs(bpm - avg) / avg * 100;
      if (deviation >= thresholdPercent) {
        entries.push({
          type: "event",
          data: {
            timestamp: simDate.toISOString(),
            bpm,
            kind: bpm > avg ? "spike" : "drop",
          },
        });
      }
    }

    rollingBpms.push(bpm);
    if (rollingBpms.length > 30) rollingBpms.shift();

    windowSamples.push({ bpm, timestamp: simDate.toISOString() });

    // Flush window at commit interval
    if (simTime - lastFlush >= commitIntervalMs) {
      if (windowSamples.length > 0) {
        const bpms = windowSamples.map((s) => s.bpm);
        const baseline: BaselineData = {
          timestamp: windowSamples[windowSamples.length - 1].timestamp,
          avgBpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
          minBpm: Math.min(...bpms),
          maxBpm: Math.max(...bpms),
          beatCount: windowSamples.length,
        };
        entries.push({ type: "baseline", data: baseline });
        windowSamples = [];
      }
      lastFlush = simTime;
    }
  }

  // Flush remaining
  if (windowSamples.length > 0) {
    const bpms = windowSamples.map((s) => s.bpm);
    entries.push({
      type: "baseline",
      data: {
        timestamp: windowSamples[windowSamples.length - 1].timestamp,
        avgBpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
        minBpm: Math.min(...bpms),
        maxBpm: Math.max(...bpms),
        beatCount: windowSamples.length,
      },
    });
  }

  return entries;
}

export async function mockCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Run `cora init` first.");
    Deno.exit(1);
  }

  let { speed, startDate, endDate } = parseArgs(Deno.args);
  const backfillMode = startDate !== null;
  const backfillEnd = endDate ?? new Date();

  await Deno.writeTextFile(pidPath(), String(Deno.pid));

  const gitEngine = new GitEngine();
  await gitEngine.init();
  console.log("✓ Git repo ready");

  // Resume from latest beat if available
  const latestBeat = await gitEngine.getLatestBeatTimestamp();
  if (latestBeat) {
    const resumeFrom = new Date(latestBeat.getTime() + 1);
    if (backfillMode && startDate && resumeFrom > startDate) {
      startDate = resumeFrom;
      console.log(`♥ Resuming from last beat: ${latestBeat.toISOString()}`);
    } else if (!backfillMode) {
      console.log(`♥ Last beat: ${latestBeat.toISOString()}`);
    }
  }

  const queue = new OfflineQueue();
  const heart = new MockHeart();

  // --- Backfill mode: generate entries in memory, then fast-import ---
  if (backfillMode) {
    if (startDate!.getTime() >= backfillEnd.getTime()) {
      console.log("Nothing to backfill — already up to date.");
      try { await Deno.remove(pidPath()); } catch { /* ignore */ }
      return;
    }

    const days = Math.ceil((backfillEnd.getTime() - startDate!.getTime()) / 86_400_000);
    console.log(`♥ Generating ${days} days of heartbeat data...`);

    const entries = generateEntries(
      heart,
      startDate!.getTime(),
      backfillEnd.getTime(),
      config.commitIntervalMs,
      config.eventThresholdPercent,
    );

    console.log(`✓ Generated ${entries.length} commits. Fast-importing into git...`);

    await gitEngine.fastImport(entries, (done, total) => {
      const pct = Math.round((done / total) * 100);
      Deno.stdout.writeSync(new TextEncoder().encode(`\r  Importing: ${done}/${total} (${pct}%)`));
    });

    console.log("\n✓ Fast-import complete. Pushing...");

    await gitEngine.shutdown();
    try { await Deno.remove(pidPath()); } catch { /* ignore */ }

    console.log(`✓ Backfill complete: ${entries.length} commits across ${days} day(s)`);
    return;
  }

  // --- Live mode ---
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

  // Fill gap if needed
  if (latestBeat && latestBeat.getTime() < Date.now() - config.commitIntervalMs) {
    const gapStart = new Date(latestBeat.getTime() + 1);
    const gapEnd = new Date();
    console.log(`♥ Filling gap: ${gapStart.toISOString()} → ${gapEnd.toISOString()}`);

    const gapEntries = generateEntries(
      heart,
      gapStart.getTime(),
      gapEnd.getTime(),
      config.commitIntervalMs,
      config.eventThresholdPercent,
    );

    if (gapEntries.length > 0) {
      await gitEngine.fastImport(gapEntries);
      console.log(`✓ Gap filled: ${gapEntries.length} commits\n`);
    }
  }

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
