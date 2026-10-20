import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { replayQueue } from "../../src/cli/replay.ts";
import { GitEngine, git } from "../../src/git/mod.ts";
import { OfflineQueue } from "../../src/queue/mod.ts";

function assertIncludes(actual: string, expected: string): void {
  assert.ok(
    actual.includes(expected),
    `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`,
  );
}

async function withTempRepo(fn: (dir: string, queue: OfflineQueue) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cora-replay-test-"));
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

test("replay - drains queue and commits all entries in order", async () => {
  await withTempRepo(async (dir, queue) => {
    await queue.enqueue({
      type: "baseline",
      data: {
        timestamp: "2026-01-01T00:00:00.000Z",
        avgBpm: 68,
        minBpm: 60,
        maxBpm: 75,
        beatCount: 20,
      },
    });
    await queue.enqueue({
      type: "event",
      data: { timestamp: "2026-01-01T00:01:00.000Z", bpm: 45, kind: "drop" },
    });
    await queue.enqueue({
      type: "baseline",
      data: {
        timestamp: "2026-01-01T00:05:00.000Z",
        avgBpm: 72,
        minBpm: 65,
        maxBpm: 80,
        beatCount: 18,
      },
    });

    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const { processed, failed } = await replayQueue(queue, engine);

    assert.deepEqual(processed, 3);
    assert.deepEqual(failed, []);
    assert.deepEqual(await queue.size(), 0);
    assert.deepEqual((await git(["log", "--format=%s"], dir)).split("\n"), [
      "♥ 72bpm @ 2026-01-01T00:05:00.000Z",
      "⚡ 45bpm drop @ 2026-01-01T00:01:00.000Z",
      "♥ 68bpm @ 2026-01-01T00:00:00.000Z",
      "init",
    ]);

    await engine.shutdown();
  });
});

test("replay - empty queue results in no commits", async () => {
  await withTempRepo(async (dir, queue) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const { processed, failed } = await replayQueue(queue, engine);

    assert.deepEqual(processed, 0);
    assert.deepEqual(failed, []);
    assert.deepEqual(await git(["rev-list", "--count", "HEAD"], dir), "1"); // only init

    await engine.shutdown();
  });
});

test("replay - preserves original timestamps", async () => {
  await withTempRepo(async (dir, queue) => {
    await queue.enqueue({
      type: "baseline",
      data: {
        timestamp: "2025-06-15T03:00:00.000Z",
        avgBpm: 55,
        minBpm: 50,
        maxBpm: 60,
        beatCount: 5,
      },
    });

    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();
    await replayQueue(queue, engine);

    assertIncludes(await git(["log", "-1", "--format=%aI"], dir), "2025-06-15");

    await engine.shutdown();
  });
});

test("replay - entries that fail to commit stay queued", async () => {
  await withTempRepo(async (dir, queue) => {
    const runGit = async (args: string[]): Promise<string> => {
      if (args[0] === "commit" && args[2].includes("drop"))
        throw new Error("git commit failed: boom");
      return "";
    };
    const event = {
      type: "event" as const,
      data: { timestamp: "2026-01-01T00:01:00.000Z", bpm: 45, kind: "drop" as const },
    };
    await queue.enqueue({
      type: "baseline",
      data: {
        timestamp: "2026-01-01T00:00:00.000Z",
        avgBpm: 68,
        minBpm: 60,
        maxBpm: 75,
        beatCount: 20,
      },
    });
    await queue.enqueue(event);

    const engine = new GitEngine(dir, { skipPush: true, runGit });
    await engine.initLocal();

    const { processed, failed } = await replayQueue(queue, engine);

    assert.deepEqual(processed, 1);
    assert.deepEqual(
      failed.map((f) => f.entry),
      [event],
    );
    assert.deepEqual(await queue.drain(), [event]);

    await engine.shutdown();
  });
});
