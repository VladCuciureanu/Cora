import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { repoDir } from "../config/mod.ts";

/** Run git and return stdout, ignoring a non-zero exit code (an empty repo yields empty output, not an error). */
function gitStdout(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: Infinity }, (err, stdout) => {
      // A string code means git could not be spawned at all (e.g. ENOENT); a numeric one is just the exit code.
      if (err && typeof err.code === "string") reject(err);
      else resolve(stdout ?? "");
    });
  });
}

export interface StatsResult {
  totalCommits: number;
  firstBeat: string;
  lastBeat: string;
  streakDays: number;
  avgBpm: number | null;
}

export function calculateStreak(dates: string[], today: Date): number {
  const daySet = new Set(dates.map((d) => d.slice(0, 10)));
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (daySet.has(key)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export function parseBpmsFromMessages(messages: string[]): number[] {
  const bpms: number[] = [];
  for (const msg of messages) {
    const match = msg.match(/(\d+)bpm/);
    if (match) bpms.push(parseInt(match[1], 10));
  }
  return bpms;
}

export async function getStats(dir: string, today?: Date): Promise<StatsResult | null> {
  // Count total commits
  const totalOut = await gitStdout(["rev-list", "--count", "HEAD"], dir);
  const totalCommits = parseInt(totalOut.trim(), 10);

  // Get first and last commit dates
  const logOut = await gitStdout(["log", "--format=%aI", "--reverse"], dir);
  const dates = logOut.trim().split("\n").filter(Boolean);

  if (dates.length === 0) return null;

  const firstBeat = dates[0];
  const lastBeat = dates[dates.length - 1];
  const streakDays = calculateStreak(dates, today ?? new Date());

  // Parse BPMs from commit messages
  const msgOut = await gitStdout(["log", "--format=%s"], dir);
  const messages = msgOut.trim().split("\n");
  const bpms = parseBpmsFromMessages(messages);
  const avgBpm = bpms.length > 0 ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null;

  return { totalCommits, firstBeat, lastBeat, streakDays, avgBpm };
}

export async function statsCommand(): Promise<void> {
  const dir = repoDir();

  try {
    await stat(`${dir}/.git`);
  } catch {
    console.error("No heartbeat repo found. Run `cora start` first.");
    process.exit(1);
  }

  const stats = await getStats(dir);
  if (!stats) {
    console.log("No heartbeat data yet.");
    return;
  }

  console.log("♥ Cora Stats");
  console.log(`  Total commits:  ${stats.totalCommits}`);
  console.log(`  First beat:     ${stats.firstBeat}`);
  console.log(`  Last beat:      ${stats.lastBeat}`);
  console.log(`  Current streak: ${stats.streakDays} day${stats.streakDays !== 1 ? "s" : ""}`);
  if (stats.avgBpm !== null) {
    console.log(`  Average BPM:    ${stats.avgBpm}`);
  }
}
