import assert from "node:assert/strict";
import { test } from "node:test";
import { BeatBuffer } from "../src/beats.ts";
import { IngestionServer } from "../src/server.ts";

const TEST_API_KEY = "testkey123";
const TEST_PORT = 9876;

async function withServer(fn: (base: string) => Promise<void>) {
  const buffer = new BeatBuffer(20);
  buffer.setListener({ onBaseline: () => {}, onEvent: () => {} });
  const server = new IngestionServer(buffer, TEST_API_KEY, TEST_PORT);
  server.start();

  // Give server time to bind
  await new Promise((r) => setTimeout(r, 100));

  try {
    await fn(`http://localhost:${TEST_PORT}`);
  } finally {
    server.stop();
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("Server - health endpoint", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    const data = await res.json();
    assert.deepEqual(data.status, "alive");
  });
});

test("Server - rejects unauthorized", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/beat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp: new Date().toISOString(), bpm: 72 }),
    });
    assert.deepEqual(res.status, 401);
    await res.body?.cancel();
  });
});

test("Server - accepts valid beat", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/beat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ timestamp: new Date().toISOString(), bpm: 72, rr_intervals: [833] }),
    });
    assert.deepEqual(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.status, "ok");
  });
});

test("Server - deduplicates same timestamp", async () => {
  await withServer(async (base) => {
    const ts = new Date().toISOString();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY}`,
    };
    const body = JSON.stringify({ timestamp: ts, bpm: 72 });

    const res1 = await fetch(`${base}/beat`, { method: "POST", headers, body });
    await res1.json();
    const res2 = await fetch(`${base}/beat`, { method: "POST", headers, body });
    const data = await res2.json();
    assert.deepEqual(data.status, "duplicate");
  });
});

test("Server - rejects invalid body", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/beat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ bpm: 72 }),
    });
    assert.deepEqual(res.status, 400);
    await res.json();
  });
});

test("Server - 401 and 404 errors are JSON", async () => {
  await withServer(async (base) => {
    const unauthorized = await fetch(`${base}/beat`, { method: "POST", body: "{}" });
    assert.deepEqual(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });

    const missing = await fetch(`${base}/nope`);
    assert.deepEqual(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Not found" });
  });
});

test("Server - rejects an out-of-range bpm or unparseable timestamp", async () => {
  await withServer(async (base) => {
    const timestamp = new Date().toISOString();
    for (const body of [
      { timestamp, bpm: -5 },
      { timestamp, bpm: 0 },
      { timestamp, bpm: 1000 },
      { timestamp, bpm: "72" },
      { timestamp: "garbage", bpm: 72 },
      { timestamp: "2026-13-45T00:00:00Z", bpm: 72 },
      { timestamp: "2026-02-30T10:00:00Z", bpm: 72 },
      { timestamp: "2026-04-31T10:00:00+02:00", bpm: 72 },
      { timestamp: "2026-03-24T24:30:00Z", bpm: 72 },
      { timestamp: "March 7, 2026", bpm: 72 },
      { timestamp: 1_774_000_000_000, bpm: 72 },
    ]) {
      const res = await fetch(`${base}/beat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        body: JSON.stringify(body),
      });
      assert.deepEqual(res.status, 400, JSON.stringify(body));
      assert.ok(typeof (await res.json()).error === "string");
    }
  });
});

test("Server - health is liveness only; BPM needs the API key", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { status: "alive" });

    const anonymous = await fetch(`${base}/status`);
    assert.deepEqual(anonymous.status, 401);
    await anonymous.json();

    const status = await fetch(`${base}/status`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.deepEqual(await status.json(), { status: "alive", bpm: null });
  });
});
