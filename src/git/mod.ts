import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { repoDir, loadConfig } from "../config/mod.ts";

export interface BaselineData {
  timestamp: string;
  avgBpm: number;
  minBpm: number;
  maxBpm: number;
  beatCount: number;
}

export interface EventData {
  timestamp: string;
  bpm: number;
  kind: "spike" | "drop" | "reconnect" | "custom";
}

async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`git ${args[0]} failed: ${err}`);
  }
  return new TextDecoder().decode(stdout).trim();
}

export class GitEngine {
  private dir: string;
  private pendingCommits = 0;
  private pushIntervalMs = 10_000;
  private pushTimer: number | undefined;

  constructor(dir?: string) {
    this.dir = dir ?? repoDir();
  }

  async init(): Promise<void> {
    const config = await loadConfig();
    if (!config) throw new Error("Config not found. Run `cora init` first.");

    try {
      await Deno.stat(join(this.dir, ".git"));
    } catch {
      await ensureDir(this.dir);
      const authUrl = config.repoUrl.replace(
        "https://",
        `https://${config.githubPat}@`,
      );
      await git(["clone", authUrl, "."], this.dir);
    }

    // Ensure beats directory exists
    await ensureDir(join(this.dir, "beats"));

    this.pushTimer = setInterval(() => this.flush(), this.pushIntervalMs);
  }

  async commitBaseline(data: BaselineData): Promise<void> {
    const filename = `${data.timestamp}.beat`;
    const content = JSON.stringify({
      avg_bpm: data.avgBpm,
      min_bpm: data.minBpm,
      max_bpm: data.maxBpm,
      beat_count: data.beatCount,
    }, null, 2) + "\n";

    await Deno.writeTextFile(join(this.dir, "beats", filename), content);
    await git(["add", join("beats", filename)], this.dir);
    await git(
      ["commit", "-m", `♥ ${data.avgBpm}bpm @ ${data.timestamp}`],
      this.dir,
      {
        GIT_AUTHOR_DATE: data.timestamp,
        GIT_COMMITTER_DATE: data.timestamp,
      },
    );
    this.pendingCommits++;
  }

  async commitEvent(data: EventData): Promise<void> {
    const filename = `${data.timestamp}.beat`;
    const content = JSON.stringify({
      bpm: data.bpm,
      kind: data.kind,
    }, null, 2) + "\n";

    await Deno.writeTextFile(join(this.dir, "beats", filename), content);
    await git(["add", join("beats", filename)], this.dir);
    await git(
      ["commit", "-m", `⚡ ${data.bpm}bpm ${data.kind} @ ${data.timestamp}`],
      this.dir,
      {
        GIT_AUTHOR_DATE: data.timestamp,
        GIT_COMMITTER_DATE: data.timestamp,
      },
    );
    this.pendingCommits++;
  }

  async flush(): Promise<void> {
    if (this.pendingCommits === 0) return;
    try {
      await git(["push"], this.dir);
      this.pendingCommits = 0;
    } catch (e) {
      console.error(`Push failed (${this.pendingCommits} commits queued): ${e}`);
    }
  }

  async shutdown(): Promise<void> {
    if (this.pushTimer !== undefined) clearInterval(this.pushTimer);
    await this.flush();
  }
}
