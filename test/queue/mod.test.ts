import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OfflineQueue } from "../../src/queue/mod.ts";

async function makeTempFile(suffix: string): Promise<string> {
  const file = join(tmpdir(), `cora-${randomUUID()}${suffix}`);
  await writeFile(file, "");
  return file;
}

test("OfflineQueue - enqueue and drain", async () => {
  const tmp = await makeTempFile(".jsonl");
  const queue = new OfflineQueue(tmp);

  await queue.enqueue({
    type: "baseline",
    data: { timestamp: "2026-01-01T00:00:00Z", avgBpm: 72, minBpm: 60, maxBpm: 80, beatCount: 10 },
  });
  await queue.enqueue({
    type: "event",
    data: { timestamp: "2026-01-01T00:01:00Z", bpm: 120, kind: "spike" },
  });

  assert.deepEqual(await queue.size(), 2);

  const entries = await queue.drain();
  assert.deepEqual(entries.length, 2);
  assert.deepEqual(entries[0].type, "baseline");
  assert.deepEqual(entries[1].type, "event");

  // After drain, queue should be empty
  assert.deepEqual(await queue.size(), 0);

  await rm(tmp);
});

test("OfflineQueue - drain empty returns empty", async () => {
  const tmp = await makeTempFile(".jsonl");
  await rm(tmp); // ensure file doesn't exist
  const queue = new OfflineQueue(tmp);

  const entries = await queue.drain();
  assert.deepEqual(entries.length, 0);
});

test("OfflineQueue - process re-queues entries whose handler fails", async () => {
  const tmp = await makeTempFile(".jsonl");
  const queue = new OfflineQueue(tmp);

  const ts = [
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:01:00Z",
    "2026-01-01T00:02:00Z",
    "2026-01-01T00:03:00Z",
  ];
  for (const timestamp of ts) {
    await queue.enqueue({ type: "event", data: { timestamp, bpm: 100, kind: "custom" } });
  }

  const seen: string[] = [];
  const result = await queue.process(async (entry) => {
    seen.push(entry.data.timestamp);
    if (entry.data.timestamp === ts[1] || entry.data.timestamp === ts[3]) {
      // Something enqueued while draining must stay behind the failed entries
      if (entry.data.timestamp === ts[1]) {
        await queue.enqueue({
          type: "event",
          data: { timestamp: "2026-01-01T00:04:00Z", bpm: 90, kind: "custom" },
        });
      }
      throw new Error("commit failed");
    }
  });

  assert.deepEqual(seen, ts);
  assert.deepEqual(result.processed, 2);
  assert.deepEqual(
    result.failed.map((f) => f.entry.data.timestamp),
    [ts[1], ts[3]],
  );
  assert.deepEqual((result.failed[0].error as Error).message, "commit failed");

  // Failed entries are retried on the next drain, in order, ahead of newer ones
  const remaining = await queue.drain();
  assert.deepEqual(
    remaining.map((e) => e.data.timestamp),
    [ts[1], ts[3], "2026-01-01T00:04:00Z"],
  );

  await rm(tmp);
});

test("OfflineQueue - process with all successes empties the queue", async () => {
  const tmp = await makeTempFile(".jsonl");
  const queue = new OfflineQueue(tmp);
  await queue.enqueue({
    type: "event",
    data: { timestamp: "2026-01-01T00:00:00Z", bpm: 100, kind: "custom" },
  });

  const result = await queue.process(async () => {});
  assert.deepEqual(result.processed, 1);
  assert.deepEqual(result.failed.length, 0);
  assert.deepEqual(await queue.size(), 0);

  await rm(tmp);
});
