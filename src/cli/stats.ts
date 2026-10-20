import { stat } from "node:fs/promises";
import { repoDir } from "../config.ts";
import { git } from "../git.ts";

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
  // Count total commits; this fails in a repo with no commits yet
  let totalOut: string;
  try {
    totalOut = await git(["rev-list", "--count", "HEAD"], dir);
  } catch (e) {
    if (typeof (e as NodeJS.ErrnoException).code === "string") throw e; // git could not be spawned
    return null;
  }
  const totalCommits = parseInt(totalOut, 10);

  // Get first and last commit dates
  const dates = (await git(["log", "--format=%aI", "--reverse"], dir)).split("\n").filter(Boolean);
  if (dates.length === 0) return null;

  const firstBeat = dates[0];
  const lastBeat = dates[dates.length - 1];
  const streakDays = calculateStreak(dates, today ?? new Date());

  // Parse BPMs from commit messages
  const messages = (await git(["log", "--format=%s"], dir)).split("\n");
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
