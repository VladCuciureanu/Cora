import assert from "node:assert/strict";
import { test } from "node:test";
import { BeatBuffer } from "../../src/beats/mod.ts";
import type { BaselineData, EventData } from "../../src/git/mod.ts";

test("BeatBuffer - flushWindow computes correct baseline", async () => {
  const buffer = new BeatBuffer(300_000, 20);
  let baseline: BaselineData | null = null;
  buffer.setListener({
    onBaseline: (data) => { baseline = data; },
    onEvent: () => {},
  });

  const now = Date.now();
  await buffer.addSample({ timestamp: new Date(now).toISOString(), bpm: 60, rrIntervals: [] });
  await buffer.addSample({ timestamp: new Date(now + 1000).toISOString(), bpm: 80, rrIntervals: [] });
  await buffer.addSample({ timestamp: new Date(now + 2000).toISOString(), bpm: 100, rrIntervals: [] });

  assert.deepEqual(buffer.sampleCount, 3);
  await buffer.flushWindow();

  assert.deepEqual(baseline!.avgBpm, 80);
  assert.deepEqual(baseline!.minBpm, 60);
  assert.deepEqual(baseline!.maxBpm, 100);
  assert.deepEqual(baseline!.beatCount, 3);
  assert.deepEqual(buffer.sampleCount, 0);
});

test("BeatBuffer - empty flushWindow is no-op", async () => {
  const buffer = new BeatBuffer(300_000, 20);
  let called = false;
  buffer.setListener({
    onBaseline: () => { called = true; },
    onEvent: () => {},
  });
  await buffer.flushWindow();
  assert.deepEqual(called, false);
});

test("BeatBuffer - detects spike event", async () => {
  const buffer = new BeatBuffer(300_000, 20);
  const events: EventData[] = [];
  buffer.setListener({
    onBaseline: () => {},
    onEvent: (data) => { events.push(data); },
  });

  // Seed 10 samples at 70bpm to establish rolling average
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    await buffer.addSample({ timestamp: new Date(now + i * 1000).toISOString(), bpm: 70, rrIntervals: [] });
  }

  // Spike to 120 (>20% above 70)
  await buffer.addSample({ timestamp: new Date(now + 11000).toISOString(), bpm: 120, rrIntervals: [] });

  assert.deepEqual(events.length, 1);
  assert.deepEqual(events[0].kind, "spike");
  assert.deepEqual(events[0].bpm, 120);
});

test("BeatBuffer - detects drop event", async () => {
  const buffer = new BeatBuffer(300_000, 20);
  const events: EventData[] = [];
  buffer.setListener({
    onBaseline: () => {},
    onEvent: (data) => { events.push(data); },
  });

  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    await buffer.addSample({ timestamp: new Date(now + i * 1000).toISOString(), bpm: 100, rrIntervals: [] });
  }

  // Drop to 50 (>20% below 100)
  await buffer.addSample({ timestamp: new Date(now + 11000).toISOString(), bpm: 50, rrIntervals: [] });

  assert.deepEqual(events.length, 1);
  assert.deepEqual(events[0].kind, "drop");
});

test("BeatBuffer - detects reconnect after gap", async () => {
  const buffer = new BeatBuffer(300_000, 20);
  const events: EventData[] = [];
  buffer.setListener({
    onBaseline: () => {},
    onEvent: (data) => { events.push(data); },
  });

  const now = Date.now();
  await buffer.addSample({ timestamp: new Date(now).toISOString(), bpm: 70, rrIntervals: [] });
  // 2 minute gap (> 60s threshold)
  await buffer.addSample({ timestamp: new Date(now + 120_000).toISOString(), bpm: 70, rrIntervals: [] });

  const reconnects = events.filter((e) => e.kind === "reconnect");
  assert.deepEqual(reconnects.length, 1);
});
