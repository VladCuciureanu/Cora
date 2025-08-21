import { assertEquals } from "jsr:@std/assert";
import { BeatBuffer } from "../../src/beats/mod.ts";
import type { BaselineData, EventData } from "../../src/git/mod.ts";

Deno.test("BeatBuffer - flushWindow computes correct baseline", async () => {
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

  assertEquals(buffer.sampleCount, 3);
  await buffer.flushWindow();

  assertEquals(baseline!.avgBpm, 80);
  assertEquals(baseline!.minBpm, 60);
  assertEquals(baseline!.maxBpm, 100);
  assertEquals(baseline!.beatCount, 3);
  assertEquals(buffer.sampleCount, 0);
});

Deno.test("BeatBuffer - empty flushWindow is no-op", async () => {
  const buffer = new BeatBuffer(300_000, 20);
  let called = false;
  buffer.setListener({
    onBaseline: () => { called = true; },
    onEvent: () => {},
  });
  await buffer.flushWindow();
  assertEquals(called, false);
});

Deno.test("BeatBuffer - detects spike event", async () => {
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

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "spike");
  assertEquals(events[0].bpm, 120);
});

Deno.test("BeatBuffer - detects drop event", async () => {
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

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "drop");
});

Deno.test("BeatBuffer - detects reconnect after gap", async () => {
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
  assertEquals(reconnects.length, 1);
});
