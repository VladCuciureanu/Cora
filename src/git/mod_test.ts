import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { join } from "@std/path";
import { GitEngine, git } from "./mod.ts";

async function withTempRepo(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "cora-test-" });
  await git(["init"], dir);
  await git(["config", "user.email", "test@test.com"], dir);
  await git(["config", "user.name", "Test"], dir);
  // Need an initial commit for git log to work
  await Deno.writeTextFile(join(dir, ".gitkeep"), "");
  await git(["add", ".gitkeep"], dir);
  await git(["commit", "-m", "init"], dir);
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("GitEngine - commitBaseline creates beat file and commit", async () => {
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
    const content = await Deno.readTextFile(join(dir, "beats", `${ts}.beat`));
    const data = JSON.parse(content);
    assertEquals(data.avg_bpm, 72);
    assertEquals(data.min_bpm, 60);
    assertEquals(data.max_bpm, 85);
    assertEquals(data.beat_count, 15);

    // Verify commit message
    const log = await git(["log", "-1", "--format=%s"], dir);
    assertStringIncludes(log, "♥ 72bpm");
    assertStringIncludes(log, ts);

    await engine.shutdown();
  });
});

Deno.test("GitEngine - commitEvent creates beat file and commit", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const ts = "2026-03-24T12:05:00.000Z";
    await engine.commitEvent({
      timestamp: ts,
      bpm: 140,
      kind: "spike",
    });

    const content = await Deno.readTextFile(join(dir, "beats", `${ts}.beat`));
    const data = JSON.parse(content);
    assertEquals(data.bpm, 140);
    assertEquals(data.kind, "spike");

    const log = await git(["log", "-1", "--format=%s"], dir);
    assertStringIncludes(log, "⚡ 140bpm spike");

    await engine.shutdown();
  });
});

Deno.test("GitEngine - commit uses custom author date", async () => {
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
    assertStringIncludes(authorDate, "2025-01-15");

    await engine.shutdown();
  });
});

Deno.test("GitEngine - multiple commits create sequential history", async () => {
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
    assertEquals(count, "4");

    await engine.shutdown();
  });
});

Deno.test("GitEngine - initLocal creates beats directory", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const stat = await Deno.stat(join(dir, "beats"));
    assertEquals(stat.isDirectory, true);

    await engine.shutdown();
  });
});

Deno.test("GitEngine - getLatestBeatTimestamp returns latest", async () => {
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
    assertEquals(latest!.toISOString(), "2026-03-15T14:30:00.000Z");

    await engine.shutdown();
  });
});

Deno.test("GitEngine - getLatestBeatTimestamp returns null when empty", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const latest = await engine.getLatestBeatTimestamp();
    assertEquals(latest, null);

    await engine.shutdown();
  });
});
