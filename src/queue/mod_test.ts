import { assertEquals } from "jsr:@std/assert";
import { OfflineQueue } from "./mod.ts";

Deno.test("OfflineQueue - enqueue and drain", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".jsonl" });
  const queue = new OfflineQueue(tmp);

  await queue.enqueue({
    type: "baseline",
    data: { timestamp: "2026-01-01T00:00:00Z", avgBpm: 72, minBpm: 60, maxBpm: 80, beatCount: 10 },
  });
  await queue.enqueue({
    type: "event",
    data: { timestamp: "2026-01-01T00:01:00Z", bpm: 120, kind: "spike" },
  });

  assertEquals(await queue.size(), 2);

  const entries = await queue.drain();
  assertEquals(entries.length, 2);
  assertEquals(entries[0].type, "baseline");
  assertEquals(entries[1].type, "event");

  // After drain, queue should be empty
  assertEquals(await queue.size(), 0);

  await Deno.remove(tmp);
});

Deno.test("OfflineQueue - drain empty returns empty", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".jsonl" });
  await Deno.remove(tmp); // ensure file doesn't exist
  const queue = new OfflineQueue(tmp);

  const entries = await queue.drain();
  assertEquals(entries.length, 0);
});
