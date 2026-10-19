import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitEngine, git } from "../../src/git/mod.ts";
import { OfflineQueue } from "../../src/queue/mod.ts";

function assertIncludes(actual: string, expected: string): void {
  assert.ok(actual.includes(expected), `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}

async function makeTempFile(suffix: string): Promise<string> {
  const file = join(tmpdir(), `cora-${randomUUID()}${suffix}`);
  await writeFile(file, "");
  return file;
}

async function withTempRepo(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cora-replay-test-"));
  await git(["init"], dir);
  await git(["config", "user.email", "test@test.com"], dir);
  await git(["config", "user.name", "Test"], dir);
  await writeFile(join(dir, ".gitkeep"), "");
  await git(["add", ".gitkeep"], dir);
  await git(["commit", "-m", "init"], dir);
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("replay - drains queue and commits all entries", async () => {
  await withTempRepo(async (dir) => {
    const queueFile = await makeTempFile(".jsonl");
    const queue = new OfflineQueue(queueFile);

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
      data: {
        timestamp: "2026-01-01T00:01:00.000Z",
        bpm: 45,
        kind: "drop" as const,
      },
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

    assert.deepEqual(await queue.size(), 3);

    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const entries = await queue.drain();
    let ok = 0;
    for (const entry of entries) {
      if (entry.type === "baseline") {
        await engine.commitBaseline(entry.data);
      } else {
        await engine.commitEvent(entry.data);
      }
      ok++;
    }

    assert.deepEqual(ok, 3);
    assert.deepEqual(await queue.size(), 0);

    // Verify commits exist with correct messages
    const count = await git(["rev-list", "--count", "HEAD"], dir);
    assert.deepEqual(count, "4"); // init + 3 replayed

    const log = await git(["log", "--format=%s"], dir);
    assertIncludes(log, "♥ 68bpm");
    assertIncludes(log, "⚡ 45bpm drop");
    assertIncludes(log, "♥ 72bpm");

    await engine.shutdown();
    await rm(queueFile);
  });
});

test("replay - empty queue results in no commits", async () => {
  await withTempRepo(async (dir) => {
    const queueFile = await makeTempFile(".jsonl");
    await rm(queueFile); // ensure empty
    const queue = new OfflineQueue(queueFile);

    const entries = await queue.drain();
    assert.deepEqual(entries.length, 0);

    const count = await git(["rev-list", "--count", "HEAD"], dir);
    assert.deepEqual(count, "1"); // only init
  });
});

test("replay - preserves original timestamps", async () => {
  await withTempRepo(async (dir) => {
    const queueFile = await makeTempFile(".jsonl");
    const queue = new OfflineQueue(queueFile);

    const originalTs = "2025-06-15T03:00:00.000Z";
    await queue.enqueue({
      type: "baseline",
      data: {
        timestamp: originalTs,
        avgBpm: 55,
        minBpm: 50,
        maxBpm: 60,
        beatCount: 5,
      },
    });

    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const entries = await queue.drain();
    for (const entry of entries) {
      if (entry.type === "baseline") {
        await engine.commitBaseline(entry.data);
      }
    }

    const authorDate = await git(["log", "-1", "--format=%aI"], dir);
    assertIncludes(authorDate, "2025-06-15");

    await engine.shutdown();
    await rm(queueFile);
  });
});
