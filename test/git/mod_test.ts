import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitEngine, beatFilename, git, parseBeatFilename } from "../../src/git/mod.ts";

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
