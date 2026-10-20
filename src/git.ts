import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type CoraConfig, loadConfig, repoDir } from "./config.ts";

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
  kind: "spike" | "drop" | "reconnect";
}

export type CommitEntry =
  | { type: "baseline"; data: BaselineData }
  | { type: "event"; data: EventData };

const execFileAsync = promisify(execFile);

const EVENT_KINDS = ["spike", "drop", "reconnect"] as const satisfies readonly EventData["kind"][];

/**
 * Filename for a beat at the given timestamp. ':' is not allowed in Windows
 * filenames, so it is replaced with '-' (e.g. 2026-03-24T12-00-00.000Z.beat).
 * Events carry their kind (e.g. 2026-03-24T12-00-00.000Z.spike.beat) so they
 * never share a file with a baseline stamped at the same time.
 */
export function beatFilename(timestamp: string, kind?: EventData["kind"]): string {
  return `${timestamp.replaceAll(":", "-")}${kind ? `.${kind}` : ""}.beat`;
}

/**
 * Parse the timestamp back out of a beat filename. Accepts both the
 * filename-safe format and legacy names containing ':'.
 */
export function parseBeatFilename(name: string): Date | null {
  if (!name.endsWith(".beat")) return null;
  let ts = name.slice(0, -".beat".length);
  const kind = EVENT_KINDS.find((k) => ts.endsWith(`.${k}`));
  if (kind) ts = ts.slice(0, -(kind.length + 1));
  const m =
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})(?:-(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}(?:-?\d{2})?)?$/.exec(ts);
  if (m) {
    const [, dateHour, minute, second, zone = ""] = m;
    ts = `${dateHour}:${minute}${second ? `:${second}` : ""}${zone.replace(/^([+-]\d{2})-(\d{2})$/, "$1:$2")}`;
  }
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Repo-relative path, file content and commit message for a beat commit. */
function beatCommit(entry: CommitEntry): { path: string; content: string; message: string } {
  const { timestamp } = entry.data;
  if (entry.type === "baseline") {
    const { avgBpm, minBpm, maxBpm, beatCount } = entry.data;
    const fields = { avg_bpm: avgBpm, min_bpm: minBpm, max_bpm: maxBpm, beat_count: beatCount };
    return {
      path: `beats/${beatFilename(timestamp)}`,
      content: `${JSON.stringify(fields, null, 2)}\n`,
      message: `♥ ${avgBpm}bpm @ ${timestamp}`,
    };
  }
  const { bpm, kind } = entry.data;
  return {
    path: `beats/${beatFilename(timestamp, kind)}`,
    content: `${JSON.stringify({ bpm, kind }, null, 2)}\n`,
    message: `⚡ ${bpm}bpm ${kind} @ ${timestamp}`,
  };
}

export async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
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

export type GitRunner = typeof git;

/**
 * Environment that makes git send the PAT as an HTTP Authorization header to
 * the repo's host. It is passed per command through GIT_CONFIG_* variables, so
 * the token is never written to .git/config or exposed in git's arguments.
 * Remotes that are not http(s) URLs (e.g. local paths) get no header.
 */
export function authEnv(repoUrl: string, pat: string): Record<string, string> {
  let origin: string;
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return {};
    origin = url.origin;
  } catch {
    return {};
  }
  // Append to any GIT_CONFIG_* entries already set in the environment
  const n = parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${origin}/.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${basic}`,
  };
}

/** Remove any `user:password@` from an http(s) URL; other remotes are returned unchanged. */
export function stripUrlCredentials(remote: string): string {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return remote;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || (!url.username && !url.password))
    return remote;
  url.username = "";
  url.password = "";
  return url.toString();
}

/**
 * Tail of the operation chain per repo directory. Git operations on the same
 * repo must not overlap (they race on .git/index.lock), so each one waits for
 * the previous one to settle before starting.
 */
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  repoLocks.set(key, tail);
  tail.then(() => {
    if (repoLocks.get(key) === tail) repoLocks.delete(key);
  });
  return run;
}

export class GitEngine {
  private dir: string;
  private pendingCommits = 0;
  private pushIntervalMs = 10_000;
  private pushTimer: ReturnType<typeof setInterval> | undefined;
  private skipPush: boolean;
  private git: GitRunner;
  private auth: Record<string, string> = {};

  constructor(dir?: string, opts?: { skipPush?: boolean; runGit?: GitRunner }) {
    this.dir = dir ?? repoDir();
    this.skipPush = opts?.skipPush ?? false;
    this.git = opts?.runGit ?? git;
  }

  /** Run `fn` with exclusive access to this repo's git state. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return withRepoLock(this.dir, fn);
  }

  async init(config?: CoraConfig): Promise<void> {
    const cfg = config ?? (await loadConfig());
    if (!cfg) throw new Error("Config not found. Run `cora init` first.");
    this.auth = authEnv(cfg.repoUrl, cfg.githubPat);

    let cloned = true;
    try {
      await stat(join(this.dir, ".git"));
    } catch {
      cloned = false;
    }

    if (!cloned) {
      await mkdir(this.dir, { recursive: true });
      await this.exclusive(() => this.git(["clone", cfg.repoUrl, "."], this.dir, this.auth));
    }
    // Also covers a repoUrl with `user:pat@` in it, which clone saves as-is.
    await this.exclusive(() => this.stripRemoteCredentials());

    await this.initLocal();
  }

  /** Older versions embedded the PAT in the clone URL; remove it from .git/config. */
  private async stripRemoteCredentials(): Promise<void> {
    let url: string;
    try {
      url = await this.git(["remote", "get-url", "origin"], this.dir);
    } catch {
      return; // no origin remote
    }
    const stripped = stripUrlCredentials(url);
    if (stripped !== url) {
      await this.git(["remote", "set-url", "origin", stripped], this.dir);
    }
  }

  async initLocal(): Promise<void> {
    await mkdir(join(this.dir, "beats"), { recursive: true });
    if (!this.skipPush) {
      // Never the only thing keeping the process alive (e.g. after a failed command)
      this.pushTimer = setInterval(() => this.flush(), this.pushIntervalMs).unref();
    }
  }

  commitBaseline(data: BaselineData): Promise<void> {
    return this.exclusive(() => this.commitUnlocked({ type: "baseline", data }));
  }

  commitEvent(data: EventData): Promise<void> {
    return this.exclusive(() => this.commitUnlocked({ type: "event", data }));
  }

  private async commitUnlocked(entry: CommitEntry): Promise<void> {
    const { path, content, message } = beatCommit(entry);
    await writeFile(join(this.dir, path), content);
    await this.git(["add", path], this.dir);
    await this.git(["commit", "-m", message], this.dir, {
      GIT_AUTHOR_DATE: entry.data.timestamp,
      GIT_COMMITTER_DATE: entry.data.timestamp,
    });
    this.pendingCommits++;
  }

  /**
   * Bulk-import commits using `git fast-import`. Streams directly to the
   * process to avoid buffering everything in memory.
   */
  fastImport(
    entries: CommitEntry[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    return this.exclusive(() => this.fastImportUnlocked(entries, onProgress));
  }

  private async fastImportUnlocked(
    entries: CommitEntry[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    if (entries.length === 0) return;

    // symbolic-ref also names the unborn branch of a repo with no commits yet
    // (e.g. a fresh clone of an empty GitHub repo), where rev-parse fails.
    let branch = "main";
    try {
      branch = (await this.git(["symbolic-ref", "--short", "HEAD"], this.dir)) || branch;
    } catch {
      /* detached HEAD */
    }
    let parentRef: string | null = null;
    try {
      parentRef = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], this.dir);
    } catch {
      /* no commits yet: the first imported commit has no parent */
    }

    const existingFiles = await this.readTrackedFiles();

    let userName = "Cora";
    let userEmail = "cora@heartbeat";
    try {
      userName = await this.git(["config", "user.name"], this.dir);
    } catch {
      /* */
    }
    try {
      userEmail = await this.git(["config", "user.email"], this.dir);
    } catch {
      /* */
    }

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
    exited.catch(() => {
      /* surfaced when awaited below */
    });

    const encoder = new TextEncoder();
    const stdin = child.stdin;

    const writeBytes = async (bytes: Uint8Array) => {
      if (!stdin.write(bytes)) await once(stdin, "drain");
    };
    const write = async (s: string) => {
      await writeBytes(encoder.encode(s));
    };
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
      const epoch = Math.floor(new Date(entry.data.timestamp).getTime() / 1000);
      const { path, content, message } = beatCommit(entry);
      const mark = markNum++;

      await write(`blob\nmark :${mark}\n`);
      await writeData(encoder.encode(content));

      const commitMark = markNum++;
      await write(`commit refs/heads/${branch}\nmark :${commitMark}\n`);
      await write(`author ${userName} <${userEmail}> ${epoch} +0000\n`);
      await write(`committer ${userName} <${userEmail}> ${epoch} +0000\n`);
      await writeData(encoder.encode(message));

      if (i === 0 && parentRef) {
        await write(`from ${parentRef}\n`);
      } else if (lastMark !== null) {
        await write(`from :${lastMark}\n`);
      }

      // Include existing files in first commit to preserve them
      if (i === 0) {
        for (const [filePath, blobMark] of existingFileMarks) {
          await write(`M 100644 :${blobMark} ${filePath}\n`);
        }
      }

      await write(`M 100644 :${mark} ${path}\n\n`);
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

    await this.git(["checkout", "-f", branch], this.dir);
    this.pendingCommits += entries.length;
    if (onProgress) onProgress(entries.length, entries.length);
  }

  private async readTrackedFiles(): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    try {
      const output = await this.git(["ls-files"], this.dir);
      if (!output) return files;
      for (const filePath of output.split("\n")) {
        if (!filePath) continue;
        const content = await readFile(join(this.dir, filePath));
        files.set(filePath, content);
      }
    } catch {
      /* empty repo */
    }
    return files;
  }

  flush(): Promise<void> {
    return this.exclusive(() => this.flushUnlocked());
  }

  private async flushUnlocked(): Promise<void> {
    if (this.pendingCommits === 0) return;
    try {
      await this.git(["push"], this.dir, this.auth);
      this.pendingCommits = 0;
    } catch {
      // Push failed, likely non-fast-forward — pull and retry
      try {
        await this.git(["pull", "--rebase"], this.dir, this.auth);
        await this.git(["push"], this.dir, this.auth);
        this.pendingCommits = 0;
      } catch (e) {
        console.error(
          `Push failed after pull --rebase (${this.pendingCommits} commits queued): ${e}`,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.pushTimer !== undefined) clearInterval(this.pushTimer);
    if (!this.skipPush) {
      await this.flush();
    }
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
