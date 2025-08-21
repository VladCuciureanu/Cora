import { repoDir } from "../config/mod.ts";

export async function statsCommand(): Promise<void> {
  const dir = repoDir();

  try {
    await Deno.stat(`${dir}/.git`);
  } catch {
    console.error("No heartbeat repo found. Run `cora start` first.");
    Deno.exit(1);
  }

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

  if (dates.length === 0) {
    console.log("No heartbeat data yet.");
    return;
  }

  const first = dates[0];
  const last = dates[dates.length - 1];

  // Calculate streak (consecutive days with commits)
  const daySet = new Set(dates.map((d) => d.slice(0, 10)));
  let streak = 0;
  const today = new Date();
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

  // Parse BPMs from commit messages
  const msgCmd = new Deno.Command("git", {
    args: ["log", "--format=%s"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const msgOut = await msgCmd.output();
  const messages = new TextDecoder().decode(msgOut.stdout).trim().split("\n");
  const bpms: number[] = [];
  for (const msg of messages) {
    const match = msg.match(/(\d+)bpm/);
    if (match) bpms.push(parseInt(match[1], 10));
  }

  const avgBpm = bpms.length > 0 ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null;

  console.log("♥ Cora Stats");
  console.log(`  Total commits:  ${totalCommits}`);
  console.log(`  First beat:     ${first}`);
  console.log(`  Last beat:      ${last}`);
  console.log(`  Current streak: ${streak} day${streak !== 1 ? "s" : ""}`);
  if (avgBpm !== null) {
    console.log(`  Average BPM:    ${avgBpm}`);
  }
}
