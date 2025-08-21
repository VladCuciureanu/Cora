import { repoDir } from "../config/mod.ts";

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
  const totalCmd = new Deno.Command("git", {
    args: ["rev-list", "--count", "HEAD"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const totalOut = await totalCmd.output();
  const totalCommits = parseInt(new TextDecoder().decode(totalOut.stdout).trim(), 10);

  // Get first and last commit dates
  const logCmd = new Deno.Command("git", {
    args: ["log", "--format=%aI", "--reverse"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const logOut = await logCmd.output();
  const dates = new TextDecoder().decode(logOut.stdout).trim().split("\n").filter(Boolean);

  if (dates.length === 0) return null;

  const firstBeat = dates[0];
  const lastBeat = dates[dates.length - 1];
  const streakDays = calculateStreak(dates, today ?? new Date());

  // Parse BPMs from commit messages
  const msgCmd = new Deno.Command("git", {
    args: ["log", "--format=%s"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const msgOut = await msgCmd.output();
  const messages = new TextDecoder().decode(msgOut.stdout).trim().split("\n");
  const bpms = parseBpmsFromMessages(messages);
  const avgBpm = bpms.length > 0 ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null;

  return { totalCommits, firstBeat, lastBeat, streakDays, avgBpm };
}

export async function statsCommand(): Promise<void> {
  const dir = repoDir();

  try {
    await Deno.stat(`${dir}/.git`);
  } catch {
    console.error("No heartbeat repo found. Run `cora start` first.");
    Deno.exit(1);
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
