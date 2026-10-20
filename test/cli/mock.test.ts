import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEntries, startTicker } from "../../src/cli/mock.ts";
import type { BaselineData } from "../../src/git.ts";
import { MockHeart } from "../../src/mock/heart.ts";

test("generateEntries - one baseline per commit interval, stamped with sample time", () => {
  const start = Date.parse("2026-03-24T12:00:00.000Z");
  const entries = generateEntries(
    new MockHeart({ seed: 1, timezone: "UTC" }),
    start,
    start + 10 * 60_000,
    60_000,
    20,
  );

  const baselines = entries.filter((e) => e.type === "baseline").map((e) => e.data as BaselineData);
  assert.deepEqual(baselines.length, 10);
  for (const [i, b] of baselines.entries()) {
    assert.deepEqual(b.timestamp, new Date(start + (i + 1) * 60_000).toISOString());
    assert.deepEqual(b.beatCount, 12); // one sample every 5s
  }
});

test("generateEntries - same seed produces the same entries", () => {
  const start = Date.parse("2026-03-24T00:00:00.000Z");
  const end = start + 26 * 3_600_000; // crosses a day boundary (replan)
  const a = generateEntries(new MockHeart({ seed: 9, timezone: "UTC" }), start, end, 300_000, 10);
  const b = generateEntries(new MockHeart({ seed: 9, timezone: "UTC" }), start, end, 300_000, 10);
  assert.deepEqual(a, b);
  assert.ok(
    a.some((e) => e.type === "event"),
    "expected some spike/drop events",
  );
});

test("startTicker - nothing reaches the buffer once stop() resolves", async () => {
  const calls: string[] = [];
  const buffer = {
    async addSample() {
      calls.push("sample");
      // keep a tick in flight when stop() is called
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    async flushWindow() {
      calls.push("flush");
    },
  };
  // speed 1000: a tick every 5 ms, each a full commit interval
  const ticker = startTicker(new MockHeart({ seed: 1 }), buffer, 1000, 5000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await ticker.stop();
  const seen = calls.length;
  assert.ok(seen > 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, seen);
});
