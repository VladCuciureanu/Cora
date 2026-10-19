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
