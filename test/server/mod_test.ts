import assert from "node:assert/strict";
import { test } from "node:test";
import { BeatBuffer } from "../../src/beats/mod.ts";
import { IngestionServer } from "../../src/server/mod.ts";

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
        "Authorization": `Bearer ${TEST_API_KEY}`,
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
      "Authorization": `Bearer ${TEST_API_KEY}`,
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
        "Authorization": `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ bpm: 72 }),
    });
    assert.deepEqual(res.status, 400);
    await res.json();
  });
});
