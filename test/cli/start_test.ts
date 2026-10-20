import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitEngine, git } from "../../src/git/mod.ts";
import { BeatBuffer } from "../../src/beats/mod.ts";
import { OfflineQueue } from "../../src/queue/mod.ts";
import type { BaselineData, EventData } from "../../src/git/mod.ts";

async function makeTempFile(suffix: string): Promise<string> {
  const file = join(tmpdir(), `cora-${randomUUID()}${suffix}`);
  await writeFile(file, "");
  return file;
}

async function withTempRepo(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cora-start-test-"));
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

test("start - beat buffer feeds into git engine", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const buffer = new BeatBuffer(20);
    const commits: string[] = [];

    buffer.setListener({
      onBaseline: async (data: BaselineData) => {
        await engine.commitBaseline(data);
        commits.push("baseline");
      },
      onEvent: async (data: EventData) => {
        await engine.commitEvent(data);
        commits.push("event");
      },
    });

    // Add samples and flush
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await buffer.addSample({
        timestamp: new Date(now + i * 1000).toISOString(),
        bpm: 70,
        rrIntervals: [],
      });
    }
    await buffer.flushWindow();

    assert.deepEqual(commits, ["baseline"]);

    const count = await git(["rev-list", "--count", "HEAD"], dir);
    assert.deepEqual(count, "2"); // init + baseline

    await engine.shutdown();
  });
});

test("start - failed commits are queued offline", async () => {
  const queueFile = await makeTempFile(".jsonl");
  const queue = new OfflineQueue(queueFile);

  // Simulate a commit failure by queuing directly
  const baselineData: BaselineData = {
    timestamp: "2026-03-24T12:00:00.000Z",
    avgBpm: 72,
    minBpm: 60,
    maxBpm: 85,
    beatCount: 10,
  };

  await queue.enqueue({ type: "baseline", data: baselineData });

  const entries = await queue.drain();
  assert.deepEqual(entries.length, 1);
  assert.deepEqual(entries[0].type, "baseline");
  assert.deepEqual((entries[0].data as BaselineData).avgBpm, 72);

  await rm(queueFile);
});

test("start - queued beats are replayed on startup", async () => {
  await withTempRepo(async (dir) => {
    const queueFile = await makeTempFile(".jsonl");
    const queue = new OfflineQueue(queueFile);

    // Queue some beats as if previous session failed to push
    await queue.enqueue({
      type: "baseline",
      data: {
        timestamp: "2026-03-24T12:00:00.000Z",
        avgBpm: 70,
        minBpm: 65,
        maxBpm: 75,
        beatCount: 8,
      },
    });
    await queue.enqueue({
      type: "event",
      data: {
        timestamp: "2026-03-24T12:01:00.000Z",
        bpm: 130,
        kind: "spike" as const,
      },
    });

    // Simulate startup: drain queue, replay into git
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const entries = await queue.drain();
    for (const entry of entries) {
      if (entry.type === "baseline") {
        await engine.commitBaseline(entry.data);
      } else {
        await engine.commitEvent(entry.data);
      }
    }

    const count = await git(["rev-list", "--count", "HEAD"], dir);
    assert.deepEqual(count, "3"); // init + 2 replayed

    // Queue should be empty
    assert.deepEqual(await queue.size(), 0);

    await engine.shutdown();
    await rm(queueFile);
  });
});

test("start - event detection triggers immediate commit", async () => {
  await withTempRepo(async (dir) => {
    const engine = new GitEngine(dir, { skipPush: true });
    await engine.initLocal();

    const events: EventData[] = [];
    const buffer = new BeatBuffer(20);
    buffer.setListener({
      onBaseline: () => {},
      onEvent: async (data: EventData) => {
        await engine.commitEvent(data);
        events.push(data);
      },
    });

    // Seed stable HR
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await buffer.addSample({
        timestamp: new Date(now + i * 1000).toISOString(),
        bpm: 70,
        rrIntervals: [],
      });
    }

    // Spike
    await buffer.addSample({
      timestamp: new Date(now + 11000).toISOString(),
      bpm: 150,
      rrIntervals: [],
    });

    assert.deepEqual(events.length, 1);
    assert.deepEqual(events[0].kind, "spike");

    // Verify the event was committed
    const log = await git(["log", "-1", "--format=%s"], dir);
    assert.deepEqual(log.includes("150bpm"), true);

    await engine.shutdown();
  });
});

test("start - PID file is written and readable", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cora-pid-test-"));
  const pidFile = join(tmp, "cora.pid");

  await writeFile(pidFile, String(process.pid));
  const text = await readFile(pidFile, "utf8");
  assert.deepEqual(parseInt(text.trim(), 10), process.pid);

  await rm(tmp, { recursive: true, force: true });
});
