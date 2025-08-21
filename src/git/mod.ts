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

export type CommitEntry =
  | { type: "baseline"; data: BaselineData }
  | { type: "event"; data: EventData };

export async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
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
  private skipPush: boolean;

  constructor(dir?: string, opts?: { skipPush?: boolean }) {
    this.dir = dir ?? repoDir();
    this.skipPush = opts?.skipPush ?? false;
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

    await this.initLocal();
  }

  async initLocal(): Promise<void> {
    await ensureDir(join(this.dir, "beats"));
    if (!this.skipPush) {
      this.pushTimer = setInterval(() => this.flush(), this.pushIntervalMs);
    }
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

  /**
   * Bulk-import commits using `git fast-import`. Streams directly to the
   * process to avoid buffering everything in memory.
   */
  async fastImport(entries: CommitEntry[], onProgress?: (done: number, total: number) => void): Promise<void> {
    if (entries.length === 0) return;

    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], this.dir)) || "main";
    let parentRef: string | null = null;
    try {
      parentRef = await git(["rev-parse", "HEAD"], this.dir);
    } catch { /* empty repo */ }

    const existingFiles = await this.readTrackedFiles();

    let userName = "Cora";
    let userEmail = "cora@heartbeat";
    try { userName = await git(["config", "user.name"], this.dir); } catch { /* */ }
    try { userEmail = await git(["config", "user.email"], this.dir); } catch { /* */ }

    // Spawn fast-import and stream to it
    const child = new Deno.Command("git", {
      args: ["fast-import", "--done", "--quiet"],
      cwd: this.dir,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const encoder = new TextEncoder();
    const writer = child.stdin.getWriter();

    const write = async (s: string) => { await writer.write(encoder.encode(s)); };
    const writeData = async (data: Uint8Array) => {
      await write(`data ${data.length}\n`);
      await writer.write(data);
      await write("\n");
    };

    let markNum = 1;
    let lastMark: number | null = null;

    // Pre-emit blobs for existing tracked files
    const existingFileMarks: [string, number][] = [];
    for (const [path, content] of existingFiles) {
      const blobMark = markNum++;
      await write(`blob\nmark :${blobMark}\n`);
      await writeData(content);
      existingFileMarks.push([path, blobMark]);
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isBaseline = entry.type === "baseline";
      const data = entry.data;
      const ts = data.timestamp;
      const epoch = Math.floor(new Date(ts).getTime() / 1000);

      let fileContent: string;
      let commitMsg: string;
      if (isBaseline) {
        const bd = data as BaselineData;
        fileContent = JSON.stringify({
          avg_bpm: bd.avgBpm, min_bpm: bd.minBpm,
          max_bpm: bd.maxBpm, beat_count: bd.beatCount,
        }, null, 2) + "\n";
        commitMsg = `♥ ${bd.avgBpm}bpm @ ${ts}`;
      } else {
        const ed = data as EventData;
        fileContent = JSON.stringify({ bpm: ed.bpm, kind: ed.kind }, null, 2) + "\n";
        commitMsg = `⚡ ${ed.bpm}bpm ${ed.kind} @ ${ts}`;
      }

      const filename = `beats/${ts}.beat`;
      const mark = markNum++;
      const contentBytes = encoder.encode(fileContent);

      await write(`blob\nmark :${mark}\n`);
      await writeData(contentBytes);

      const commitMark = markNum++;
      await write(`commit refs/heads/${branch}\nmark :${commitMark}\n`);
      await write(`author ${userName} <${userEmail}> ${epoch} +0000\n`);
      await write(`committer ${userName} <${userEmail}> ${epoch} +0000\n`);
      await writeData(encoder.encode(commitMsg));

      if (i === 0 && parentRef) {
        await write(`from ${parentRef}\n`);
      } else if (lastMark !== null) {
        await write(`from :${lastMark}\n`);
      }

      // Include existing files in first commit to preserve them
      if (i === 0) {
        for (const [path, blobMark] of existingFileMarks) {
          await write(`M 100644 :${blobMark} ${path}\n`);
        }
      }

      await write(`M 100644 :${mark} ${filename}\n\n`);
      lastMark = commitMark;

      if (onProgress && (i + 1) % 500 === 0) {
        onProgress(i + 1, entries.length);
      }
    }

    await write("done\n");
    await writer.close();

    const { code, stderr } = await child.output();
    if (code !== 0) {
      const err = new TextDecoder().decode(stderr);
      throw new Error(`git fast-import failed: ${err}`);
    }

    await git(["checkout", "-f", branch], this.dir);
    this.pendingCommits += entries.length;
    if (onProgress) onProgress(entries.length, entries.length);
  }

  private async readTrackedFiles(): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    try {
      const output = await git(["ls-files"], this.dir);
      if (!output) return files;
      for (const filePath of output.split("\n")) {
        if (!filePath) continue;
        const content = await Deno.readFile(join(this.dir, filePath));
        files.set(filePath, content);
      }
    } catch { /* empty repo */ }
    return files;
  }

  async flush(): Promise<void> {
    if (this.pendingCommits === 0) return;
    try {
      await git(["push"], this.dir);
      this.pendingCommits = 0;
    } catch {
      // Push failed, likely non-fast-forward — pull and retry
      try {
        await git(["pull", "--rebase"], this.dir);
        await git(["push"], this.dir);
        this.pendingCommits = 0;
      } catch (e) {
        console.error(`Push failed after pull --rebase (${this.pendingCommits} commits queued): ${e}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.pushTimer !== undefined) clearInterval(this.pushTimer);
    if (!this.skipPush) {
      await this.flush();
    }
  }

  getDir(): string {
    return this.dir;
  }

  async getLatestBeatTimestamp(): Promise<Date | null> {
    const beatsDir = join(this.dir, "beats");
    let latest: Date | null = null;

    try {
      for await (const entry of Deno.readDir(beatsDir)) {
        if (!entry.isFile || !entry.name.endsWith(".beat")) continue;
        const tsStr = entry.name.replace(".beat", "");
        const date = new Date(tsStr);
        if (!isNaN(date.getTime()) && (latest === null || date > latest)) {
          latest = date;
        }
      }
    } catch {
      // beats dir doesn't exist yet
    }

    return latest;
  }
}
