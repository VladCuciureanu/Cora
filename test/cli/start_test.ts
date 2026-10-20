import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitEngine, git } from "../../src/git/mod.ts";
import { BeatBuffer } from "../../src/beats/mod.ts";
import { OfflineQueue } from "../../src/queue/mod.ts";
import { commitListener } from "../../src/cli/start.ts";
import type { BaselineData } from "../../src/git/mod.ts";

async function withTempRepo(fn: (dir: string, queue: OfflineQueue) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cora-start-test-"));
  const repo = join(dir, "repo");
  await git(["init", repo], dir);
  await git(["config", "user.email", "test@test.com"], repo);
  await git(["config", "user.name", "Test"], repo);
  await writeFile(join(repo, ".gitkeep"), "");
  await git(["add", ".gitkeep"], repo);
  await git(["commit", "-m", "init"], repo);
  try {
    await fn(repo, new OfflineQueue(join(dir, "queue.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("start - beat buffer baselines are committed", async () => {
  await withTempRepo(async (dir, queue) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const buffer = new BeatBuffer(20);
    buffer.setListener(commitListener(engine, queue));

    const start = Date.parse("2026-03-24T12:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await buffer.addSample({ timestamp: new Date(start + i * 1000).toISOString(), bpm: 70, rrIntervals: [] });
    }
    await buffer.flushWindow();

    assert.deepEqual(await git(["rev-list", "--count", "HEAD"], dir), "2"); // init + baseline
    assert.deepEqual(await git(["log", "-1", "--format=%s"], dir), "♥ 70bpm @ 2026-03-24T12:00:04.000Z");
    assert.deepEqual(await queue.size(), 0);

    await engine.shutdown();
  });
});

test("start - event detection triggers immediate commit", async () => {
  await withTempRepo(async (dir, queue) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const buffer = new BeatBuffer(20);
    buffer.setListener(commitListener(engine, queue));

    const start = Date.parse("2026-03-24T12:00:00.000Z");
    for (let i = 0; i < 10; i++) {
      await buffer.addSample({ timestamp: new Date(start + i * 1000).toISOString(), bpm: 70, rrIntervals: [] });
    }
    await buffer.addSample({ timestamp: new Date(start + 11_000).toISOString(), bpm: 150, rrIntervals: [] });

    assert.deepEqual(await git(["log", "-1", "--format=%s"], dir), "⚡ 150bpm spike @ 2026-03-24T12:00:11.000Z");

    await engine.shutdown();
  });
});

test("start - failed commits are queued offline", async (t) => {
  await withTempRepo(async (dir, queue) => {
    const runGit = async (args: string[]): Promise<string> => {
      if (args[0] === "commit") throw new Error("git commit failed: boom");
      return "";
    };
    const engine = new GitEngine(dir, { skipPush: true, runGit });
    await engine.initLocal();
    t.mock.method(console, "error", () => {});

    const listener = commitListener(engine, queue);
    const baseline: BaselineData = {
      timestamp: "2026-03-24T12:00:00.000Z",
      avgBpm: 72,
      minBpm: 60,
      maxBpm: 85,
      beatCount: 10,
    };
    await listener.onBaseline(baseline);
    await listener.onEvent({ timestamp: "2026-03-24T12:01:00.000Z", bpm: 130, kind: "spike" });

    assert.deepEqual(await queue.drain(), [
      { type: "baseline", data: baseline },
      { type: "event", data: { timestamp: "2026-03-24T12:01:00.000Z", bpm: 130, kind: "spike" } },
    ]);

    await engine.shutdown();
  });
});
