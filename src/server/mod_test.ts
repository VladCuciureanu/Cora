import { assertEquals } from "jsr:@std/assert";
import { BeatBuffer } from "../beats/mod.ts";
import { IngestionServer } from "./mod.ts";

const TEST_API_KEY = "testkey123";
const TEST_PORT = 9876;

async function withServer(fn: (base: string) => Promise<void>) {
  const buffer = new BeatBuffer(300_000, 20);
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

Deno.test("Server - health endpoint", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    const data = await res.json();
    assertEquals(data.status, "alive");
  });
});

Deno.test("Server - rejects unauthorized", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/beat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp: new Date().toISOString(), bpm: 72 }),
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });
});

Deno.test("Server - accepts valid beat", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/beat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ timestamp: new Date().toISOString(), bpm: 72, rr_intervals: [833] }),
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.status, "ok");
  });
});

Deno.test("Server - deduplicates same timestamp", async () => {
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
    assertEquals(data.status, "duplicate");
  });
});

Deno.test("Server - rejects invalid body", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/beat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ bpm: 72 }),
    });
    assertEquals(res.status, 400);
    await res.json();
  });
});
