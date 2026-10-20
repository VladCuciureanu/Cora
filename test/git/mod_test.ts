import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitEngine, authEnv, beatFilename, git, parseBeatFilename, stripUrlCredentials } from "../../src/git/mod.ts";

function assertIncludes(actual: string, expected: string): void {
  assert.ok(actual.includes(expected), `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}

async function withTempRepo(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cora-test-"));
  await git(["init"], dir);
  await git(["config", "user.email", "test@test.com"], dir);
  await git(["config", "user.name", "Test"], dir);
  // Need an initial commit for git log to work
  await writeFile(join(dir, ".gitkeep"), "");
  await git(["add", ".gitkeep"], dir);
  await git(["commit", "-m", "init"], dir);
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("GitEngine - commitBaseline creates beat file and commit", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const ts = "2026-03-24T12:00:00.000Z";
    await engine.commitBaseline({
      timestamp: ts,
      avgBpm: 72,
      minBpm: 60,
      maxBpm: 85,
      beatCount: 15,
    });

    // Verify file exists
    const content = await readFile(join(dir, "beats", beatFilename(ts)), "utf8");
    const data = JSON.parse(content);
    assert.deepEqual(data.avg_bpm, 72);
    assert.deepEqual(data.min_bpm, 60);
    assert.deepEqual(data.max_bpm, 85);
    assert.deepEqual(data.beat_count, 15);

    // Verify commit message
    const log = await git(["log", "-1", "--format=%s"], dir);
    assertIncludes(log, "♥ 72bpm");
    assertIncludes(log, ts);

    await engine.shutdown();
  });
});

test("GitEngine - commitEvent creates beat file and commit", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const ts = "2026-03-24T12:05:00.000Z";
    await engine.commitEvent({
      timestamp: ts,
      bpm: 140,
      kind: "spike",
    });

    const content = await readFile(join(dir, "beats", beatFilename(ts)), "utf8");
    const data = JSON.parse(content);
    assert.deepEqual(data.bpm, 140);
    assert.deepEqual(data.kind, "spike");

    const log = await git(["log", "-1", "--format=%s"], dir);
    assertIncludes(log, "⚡ 140bpm spike");

    await engine.shutdown();
  });
});

test("GitEngine - commit uses custom author date", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const ts = "2025-01-15T08:30:00.000Z";
    await engine.commitBaseline({
      timestamp: ts,
      avgBpm: 65,
      minBpm: 58,
      maxBpm: 70,
      beatCount: 10,
    });

    const authorDate = await git(["log", "-1", "--format=%aI"], dir);
    assertIncludes(authorDate, "2025-01-15");

    await engine.shutdown();
  });
});

test("GitEngine - multiple commits create sequential history", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    await engine.commitBaseline({
      timestamp: "2026-03-24T12:00:00.000Z",
      avgBpm: 70,
      minBpm: 65,
      maxBpm: 75,
      beatCount: 10,
    });

    await engine.commitEvent({
      timestamp: "2026-03-24T12:01:00.000Z",
      bpm: 120,
      kind: "spike",
    });

    await engine.commitBaseline({
      timestamp: "2026-03-24T12:05:00.000Z",
      avgBpm: 80,
      minBpm: 70,
      maxBpm: 90,
      beatCount: 12,
    });

    // init commit + 3 cora commits = 4
    const count = await git(["rev-list", "--count", "HEAD"], dir);
    assert.deepEqual(count, "4");

    await engine.shutdown();
  });
});

test("GitEngine - initLocal creates beats directory", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const stat = await fsStat(join(dir, "beats"));
    assert.deepEqual(stat.isDirectory(), true);

    await engine.shutdown();
  });
});

test("GitEngine - getLatestBeatTimestamp returns latest", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    await engine.commitBaseline({
      timestamp: "2026-01-01T10:00:00.000Z",
      avgBpm: 70, minBpm: 65, maxBpm: 75, beatCount: 10,
    });
    await engine.commitBaseline({
      timestamp: "2026-03-15T14:30:00.000Z",
      avgBpm: 72, minBpm: 66, maxBpm: 78, beatCount: 12,
    });
    await engine.commitEvent({
      timestamp: "2026-02-10T08:00:00.000Z",
      bpm: 130, kind: "spike",
    });

    const latest = await engine.getLatestBeatTimestamp();
    assert.deepEqual(latest!.toISOString(), "2026-03-15T14:30:00.000Z");

    await engine.shutdown();
  });
});

test("GitEngine - getLatestBeatTimestamp returns null when empty", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const latest = await engine.getLatestBeatTimestamp();
    assert.deepEqual(latest, null);

    await engine.shutdown();
  });
});

test("beatFilename - contains no ':' and round-trips", () => {
  for (const ts of [
    "2026-03-24T12:00:00.000Z",
    "2025-01-15T08:30:45Z",
    "2026-03-24T14:00:00+02:00",
  ]) {
    const name = beatFilename(ts);
    assert.ok(!name.includes(":"), `${name} should not contain ':'`);
    assert.ok(name.endsWith(".beat"));
    assert.deepEqual(parseBeatFilename(name)!.toISOString(), new Date(ts).toISOString());
  }
});

test("parseBeatFilename - still reads legacy names with ':'", () => {
  assert.deepEqual(
    parseBeatFilename("2026-03-24T12:00:00.000Z.beat")!.toISOString(),
    "2026-03-24T12:00:00.000Z",
  );
  assert.deepEqual(parseBeatFilename("notes.txt"), null);
  assert.deepEqual(parseBeatFilename("garbage.beat"), null);
});

test("GitEngine - beat files are written without ':' in the name", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    await engine.commitEvent({ timestamp: "2026-03-24T12:05:00.000Z", bpm: 99, kind: "custom" });

    const files = await git(["ls-files", "beats"], dir);
    assert.deepEqual(files, "beats/2026-03-24T12-05-00.000Z.beat");

    await engine.shutdown();
  });
});

test("GitEngine - concurrent git operations run one at a time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cora-lock-test-"));
  try {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const runGit = async (args: string[]): Promise<string> => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(args[0]);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return "";
    };

    const engine = new GitEngine(dir, { skipPush: true, runGit });
    // A second engine on the same repo must share the lock
    const other = new GitEngine(dir, { skipPush: true, runGit });
    await engine.initLocal();

    await Promise.all([
      engine.commitBaseline({ timestamp: "2026-03-24T12:00:00.000Z", avgBpm: 70, minBpm: 65, maxBpm: 75, beatCount: 10 }),
      engine.commitEvent({ timestamp: "2026-03-24T12:01:00.000Z", bpm: 120, kind: "spike" }),
      other.commitBaseline({ timestamp: "2026-03-24T12:02:00.000Z", avgBpm: 72, minBpm: 66, maxBpm: 78, beatCount: 12 }),
      engine.flush(),
      engine.commitEvent({ timestamp: "2026-03-24T12:03:00.000Z", bpm: 40, kind: "drop" }),
      engine.flush(),
    ]);

    assert.deepEqual(maxActive, 1);
    // Each operation's add+commit pair stays together; the first flush runs
    // after two commits, the second after the last commit.
    assert.deepEqual(calls, ["add", "commit", "add", "commit", "add", "commit", "push", "add", "commit", "push"]);

    await engine.shutdown();
    await other.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitEngine - a failing git operation does not block later ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cora-lock-test-"));
  try {
    let fail = true;
    const runGit = async (args: string[]): Promise<string> => {
      if (fail && args[0] === "commit") {
        fail = false;
        throw new Error("git commit failed: boom");
      }
      return "";
    };
    const engine = new GitEngine(dir, { skipPush: true, runGit });
    await engine.initLocal();

    const results = await Promise.allSettled([
      engine.commitEvent({ timestamp: "2026-03-24T12:00:00.000Z", bpm: 120, kind: "spike" }),
      engine.commitEvent({ timestamp: "2026-03-24T12:01:00.000Z", bpm: 121, kind: "spike" }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled"]);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const AUTH_CONFIG = {
  githubPat: "ghp_secret123",
  repoUrl: "https://github.com/user/cora-heartbeat.git",
  apiKey: "k",
  commitIntervalMs: 300_000,
  eventThresholdPercent: 20,
  port: 7331,
};

test("GitEngine - clone/push send the PAT as a header, never in the URL", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cora-auth-test-"));
  try {
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const runGit = async (args: string[], _cwd: string, env?: Record<string, string>): Promise<string> => {
      calls.push({ args, env });
      return "";
    };
    const engine = new GitEngine(join(tmp, "repo"), { skipPush: true, runGit });
    await engine.init(AUTH_CONFIG);
    await engine.commitEvent({ timestamp: "2026-03-24T12:00:00.000Z", bpm: 120, kind: "spike" });
    await engine.flush();

    const clone = calls.find((c) => c.args[0] === "clone")!;
    assert.deepEqual(clone.args, ["clone", AUTH_CONFIG.repoUrl, "."]);
    const push = calls.find((c) => c.args[0] === "push")!;
    for (const call of [clone, push]) {
      assert.deepEqual(call.env, authEnv(AUTH_CONFIG.repoUrl, AUTH_CONFIG.githubPat));
    }
    for (const call of calls) {
      assert.ok(!call.args.join(" ").includes(AUTH_CONFIG.githubPat), `token leaked into: git ${call.args.join(" ")}`);
    }

    await engine.shutdown();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("GitEngine - init strips a PAT embedded in an existing clone's remote URL", async () => {
  await withTempRepo(async (dir) => {
    await git(["remote", "add", "origin", "https://ghp_secret123@github.com/user/cora-heartbeat.git"], dir);

    const engine = new GitEngine(dir, { skipPush: true });
    await engine.init(AUTH_CONFIG);

    assert.deepEqual(await git(["remote", "get-url", "origin"], dir), AUTH_CONFIG.repoUrl);
    const gitConfig = await readFile(join(dir, ".git", "config"), "utf8");
    assert.ok(!gitConfig.includes("ghp_secret123"), ".git/config still contains the token");

    await engine.shutdown();
  });
});

test("authEnv - git sees the Authorization header for the repo's host only", async () => {
  await withTempRepo(async (dir) => {
    const env = authEnv(AUTH_CONFIG.repoUrl, AUTH_CONFIG.githubPat);
    const expected = `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret123").toString("base64")}`;
    assert.deepEqual(
      await git(["config", "--get-urlmatch", "http.extraHeader", AUTH_CONFIG.repoUrl], dir, env),
      expected,
    );
    await assert.rejects(git(["config", "--get-urlmatch", "http.extraHeader", "https://example.com/x.git"], dir, env));
    // Local paths and non-http remotes get no header
    assert.deepEqual(authEnv("/tmp/some/repo", "ghp_x"), {});
  });
});

test("stripUrlCredentials - removes user info from http(s) URLs only", () => {
  assert.deepEqual(stripUrlCredentials("https://ghp_x@github.com/u/r.git"), "https://github.com/u/r.git");
  assert.deepEqual(stripUrlCredentials("https://user:ghp_x@github.com/u/r"), "https://github.com/u/r");
  assert.deepEqual(stripUrlCredentials("https://github.com/u/r.git"), "https://github.com/u/r.git");
  assert.deepEqual(stripUrlCredentials("git@github.com:u/r.git"), "git@github.com:u/r.git");
});
