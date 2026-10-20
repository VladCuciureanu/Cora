import { rm, writeFile } from "node:fs/promises";
import { BeatBuffer, detectDeviation, pushRolling, summarizeWindow } from "../beats.ts";
import { type CoraConfig, pidPath, requireConfig } from "../config.ts";
import { type CommitEntry, GitEngine } from "../git.ts";
import { MockHeart } from "../mock/heart.ts";
import { OfflineQueue } from "../queue.ts";
import { commitListener } from "./start.ts";

/** Fastest live simulation speed. */
const MAX_LIVE_SPEED = 100;

/** `cora mock` options as given on the command line. */
export interface MockOptions {
  speed?: string;
  from?: string;
  to?: string;
}

function parseDate(flag: string, value: string | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${flag} date: ${value}`);
  return date;
}

function parseOptions(options: MockOptions): {
  speed: number;
  startDate: Date | null;
  endDate: Date | null;
} {
  const speed = options.speed === undefined ? 1 : Number(options.speed);
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error("Speed must be a positive number (e.g. 60 = 1 hour/min)");
  }
  if (options.to !== undefined && options.from === undefined) {
    throw new Error("--to needs --from");
  }
  return {
    speed,
    startDate: parseDate("--from", options.from),
    endDate: parseDate("--to", options.to),
  };
}

/** Generate all commit entries for a date range without touching git. */
export function generateEntries(
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
    const kind = detectDeviation(rollingBpms, bpm, thresholdPercent);
    if (kind) {
      entries.push({ type: "event", data: { timestamp: simDate.toISOString(), bpm, kind } });
    }

    pushRolling(rollingBpms, bpm);

    windowSamples.push({ bpm, timestamp: simDate.toISOString() });

    // Flush window at commit interval
    if (simTime - lastFlush >= commitIntervalMs) {
      const baseline = summarizeWindow(windowSamples);
      if (baseline) {
        entries.push({ type: "baseline", data: baseline });
        windowSamples = [];
      }
      lastFlush = simTime;
    }
  }

  // Flush remaining
  const baseline = summarizeWindow(windowSamples);
  if (baseline) entries.push({ type: "baseline", data: baseline });

  return entries;
}

/** Remove the PID file, ignoring a missing one. */
async function removePidFile(): Promise<void> {
  try {
    await rm(pidPath());
  } catch {
    /* ignore */
  }
}

/** Generate the beats from `start` to `end` and fast-import them in one go. */
async function backfill(
  gitEngine: GitEngine,
  heart: MockHeart,
  config: CoraConfig,
  start: Date,
  end: Date,
): Promise<void> {
  if (start.getTime() >= end.getTime()) {
    console.log("Nothing to backfill — already up to date.");
    return;
  }

  await writeFile(pidPath(), String(process.pid));
  try {
    const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
    console.log(`♥ Generating ${days} days of heartbeat data...`);

    const entries = generateEntries(
      heart,
      start.getTime(),
      end.getTime(),
      config.commitIntervalMs,
      config.eventThresholdPercent,
    );

    console.log(`✓ Generated ${entries.length} commits. Fast-importing into git...`);

    await gitEngine.fastImport(entries, (done, total) => {
      const pct = Math.round((done / total) * 100);
      process.stdout.write(`\r  Importing: ${done}/${total} (${pct}%)`);
    });

    console.log("\n✓ Fast-import complete. Pushing...");

    await gitEngine.shutdown();

    console.log(`✓ Backfill complete: ${entries.length} commits across ${days} day(s)`);
  } finally {
    await removePidFile();
  }
}

/** Fast-import beats for the time since `latestBeat` if more than a commit interval has passed. */
async function fillGap(
  gitEngine: GitEngine,
  heart: MockHeart,
  config: CoraConfig,
  latestBeat: Date | null,
): Promise<void> {
  if (!latestBeat || latestBeat.getTime() >= Date.now() - config.commitIntervalMs) return;

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

function logCommit(entry: CommitEntry): void {
  if (entry.type === "baseline") {
    const { avgBpm, minBpm, maxBpm, beatCount } = entry.data;
    console.log(`  ♥ baseline ${avgBpm}bpm (${minBpm}–${maxBpm}) x${beatCount}`);
  } else {
    console.log(`  ⚡ ${entry.data.kind} ${entry.data.bpm}bpm`);
  }
}

function printLiveStart(heart: MockHeart, speed: number, commitIntervalMs: number): void {
  console.log(`♥ Mock heart started (speed: ${speed}x)`);
  console.log(`  1 real second = ${speed} simulated seconds`);
  if (speed >= 60) console.log(`  ≈ ${(speed / 60).toFixed(1)} simulated minutes per real second`);
  console.log(`  Commit interval: ${commitIntervalMs / 1000}s simulated`);
  console.log(`  Activities planned: ${heart.getActivityPlan().length}`);
  for (const act of heart.getActivityPlan()) {
    const h = Math.floor(act.startMinute / 60);
    const m = act.startMinute % 60;
    console.log(
      `    ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} — peak ${act.peakBpm}bpm for ${act.durationMin}min`,
    );
  }
  console.log();
}

/** Feed `buffer` one 5 s sample per tick, starting now, flushing a baseline every commit interval. */
function startTicker(
  heart: MockHeart,
  buffer: BeatBuffer,
  speed: number,
  commitIntervalMs: number,
): ReturnType<typeof setInterval> {
  const simStepMs = 5000;
  let simTime = Date.now();
  let lastDay = new Date(simTime).getDate();
  let lastFlush = simTime;

  return setInterval(async () => {
    simTime += simStepMs;
    const simDate = new Date(simTime);

    const currentDay = simDate.getDate();
    if (currentDay !== lastDay) {
      heart.replanDay();
      lastDay = currentDay;
      console.log(
        `\n— New day: ${simDate.toISOString().slice(0, 10)} — ${heart.getActivityPlan().length} activities planned\n`,
      );
    }

    const bpm = heart.bpmAt(simDate);
    await buffer.addSample({
      timestamp: simDate.toISOString(),
      bpm,
      rrIntervals: [Math.round(60000 / bpm)],
    });

    if (simTime - lastFlush >= commitIntervalMs) {
      await buffer.flushWindow();
      lastFlush = simTime;
    }
  }, simStepMs / speed);
}

/** Simulate the heart live until SIGINT or SIGTERM, first filling any gap since `latestBeat`. */
async function runLive(
  gitEngine: GitEngine,
  heart: MockHeart,
  config: CoraConfig,
  requestedSpeed: number,
  latestBeat: Date | null,
): Promise<void> {
  const buffer = new BeatBuffer(config.eventThresholdPercent);
  buffer.setListener(commitListener(gitEngine, new OfflineQueue(), logCommit));

  await fillGap(gitEngine, heart, config, latestBeat);

  // Only advertise the PID once setup has succeeded
  await writeFile(pidPath(), String(process.pid));

  // One 5 s sample every 50 ms of real time at most
  let speed = requestedSpeed;
  if (speed > MAX_LIVE_SPEED) {
    console.log(`  Speed ${speed}x is above the live maximum; using ${MAX_LIVE_SPEED}x`);
    speed = MAX_LIVE_SPEED;
  }
  printLiveStart(heart, speed, config.commitIntervalMs);

  const ticker = startTicker(heart, buffer, speed, config.commitIntervalMs);

  const shutdown = async () => {
    console.log("\n♥ Stopping mock heart...");
    clearInterval(ticker);
    await buffer.flushWindow();
    await gitEngine.shutdown();
    await removePidFile();
    console.log("♥ Goodbye.");
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function mockCommand(options: MockOptions = {}): Promise<void> {
  const { speed, startDate, endDate } = parseOptions(options);
  const config = await requireConfig();
  const backfillEnd = endDate ?? new Date();

  const gitEngine = new GitEngine();
  await gitEngine.init(config);
  console.log("✓ Git repo ready");

  try {
    const latestBeat = await gitEngine.getLatestBeatTimestamp();
    const heart = new MockHeart();

    if (!startDate) {
      if (latestBeat) console.log(`♥ Last beat: ${latestBeat.toISOString()}`);
      await runLive(gitEngine, heart, config, speed, latestBeat);
      return;
    }

    // Resume after the latest beat rather than duplicating beats already in the repo
    let backfillStart = startDate;
    if (latestBeat && latestBeat.getTime() + 1 > startDate.getTime()) {
      backfillStart = new Date(latestBeat.getTime() + 1);
      console.log(`♥ Resuming from last beat: ${latestBeat.toISOString()}`);
    }
    await backfill(gitEngine, heart, config, backfillStart, backfillEnd);
  } catch (e) {
    // Stop the push timer and push what was committed before failing
    await gitEngine.shutdown();
    throw e;
  }
}
