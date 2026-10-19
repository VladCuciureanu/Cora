import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

/**
 * Filename for a beat at the given timestamp. ':' is not allowed in Windows
 * filenames, so it is replaced with '-' (e.g. 2026-03-24T12-00-00.000Z.beat).
 */
export function beatFilename(timestamp: string): string {
  return `${timestamp.replaceAll(":", "-")}.beat`;
}

/**
 * Parse the timestamp back out of a beat filename. Accepts both the
 * filename-safe format and legacy names containing ':'.
 */
export function parseBeatFilename(name: string): Date | null {
  if (!name.endsWith(".beat")) return null;
  let ts = name.slice(0, -".beat".length);
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})(?:-(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}(?:-?\d{2})?)?$/.exec(ts);
  if (m) {
    const [, dateHour, minute, second, zone = ""] = m;
    ts = `${dateHour}:${minute}${second ? `:${second}` : ""}${zone.replace(/^([+-]\d{2})-(\d{2})$/, "$1:$2")}`;
  }
  const date = new Date(ts);
  return isNaN(date.getTime()) ? null : date;
}

export async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      maxBuffer: Infinity,
    });
    return stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (typeof err.code === "string") throw err; // git could not be spawned
    throw new Error(`git ${args[0]} failed: ${err.stderr ?? ""}`);
  }
}

export class GitEngine {
  private dir: string;
  private pendingCommits = 0;
  private pushIntervalMs = 10_000;
  private pushTimer: ReturnType<typeof setInterval> | undefined;
  private skipPush: boolean;

  constructor(dir?: string, opts?: { skipPush?: boolean }) {
    this.dir = dir ?? repoDir();
    this.skipPush = opts?.skipPush ?? false;
  }

  async init(): Promise<void> {
    const config = await loadConfig();
    if (!config) throw new Error("Config not found. Run `cora init` first.");

    try {
      await stat(join(this.dir, ".git"));
    } catch {
      await mkdir(this.dir, { recursive: true });
      const authUrl = config.repoUrl.replace(
        "https://",
        `https://${config.githubPat}@`,
      );
      await git(["clone", authUrl, "."], this.dir);
    }

    await this.initLocal();
  }

  async initLocal(): Promise<void> {
    await mkdir(join(this.dir, "beats"), { recursive: true });
    if (!this.skipPush) {
      this.pushTimer = setInterval(() => this.flush(), this.pushIntervalMs);
    }
  }

  async commitBaseline(data: BaselineData): Promise<void> {
    const filename = beatFilename(data.timestamp);
    const content = JSON.stringify({
      avg_bpm: data.avgBpm,
      min_bpm: data.minBpm,
      max_bpm: data.maxBpm,
      beat_count: data.beatCount,
    }, null, 2) + "\n";

    await writeFile(join(this.dir, "beats", filename), content);
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
    const filename = beatFilename(data.timestamp);
    const content = JSON.stringify({
      bpm: data.bpm,
      kind: data.kind,
    }, null, 2) + "\n";

    await writeFile(join(this.dir, "beats", filename), content);
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
    const child = spawn("git", ["fast-import", "--done", "--quiet"], {
      cwd: this.dir,
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    exited.catch(() => { /* surfaced when awaited below */ });

    const encoder = new TextEncoder();
    const stdin = child.stdin;

    const writeBytes = async (bytes: Uint8Array) => {
      if (!stdin.write(bytes)) await once(stdin, "drain");
    };
    const write = async (s: string) => { await writeBytes(encoder.encode(s)); };
    const writeData = async (data: Uint8Array) => {
      await write(`data ${data.length}\n`);
      await writeBytes(data);
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

      const filename = `beats/${beatFilename(ts)}`;
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
    stdin.end();

    const code = await exited;
    if (code !== 0) {
      const err = Buffer.concat(stderrChunks).toString("utf8");
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
        const content = await readFile(join(this.dir, filePath));
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
      for (const entry of await readdir(beatsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".beat")) continue;
        const date = parseBeatFilename(entry.name);
        if (date !== null && (latest === null || date > latest)) {
          latest = date;
        }
      }
    } catch {
      // beats dir doesn't exist yet
    }

    return latest;
  }
}
