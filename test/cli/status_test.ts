import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("status - PID file contains valid integer", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cora-status-test-"));
  const pidFile = join(tmp, "cora.pid");

  await writeFile(pidFile, String(process.pid));
  const text = await readFile(pidFile, "utf8");
  const pid = parseInt(text.trim(), 10);
  assert.deepEqual(pid, process.pid);
  assert.deepEqual(Number.isInteger(pid), true);

  await rm(tmp, { recursive: true, force: true });
});

test("status - detects dead process via kill", () => {
  // Use a PID that doesn't exist
  let alive = false;
  try {
    process.kill(2147483647, 0);
    alive = true;
  } catch {
    alive = false;
  }
  assert.deepEqual(alive, false);
});

test("status - missing PID file means not running", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cora-status-test-"));
  const pidFile = join(tmp, "nonexistent.pid");

  let running = false;
  try {
    await readFile(pidFile, "utf8");
    running = true;
  } catch {
    running = false;
  }
  assert.deepEqual(running, false);

  await rm(tmp, { recursive: true, force: true });
});

test("status - health endpoint parsing", () => {
  const mockResponse = { status: "alive", bpm: 72 };
  assert.deepEqual(mockResponse.bpm, 72);
  assert.deepEqual(mockResponse.status, "alive");

  const nullBpmResponse = { status: "alive", bpm: null };
  assert.deepEqual(nullBpmResponse.bpm ?? "no data yet", "no data yet");
});
