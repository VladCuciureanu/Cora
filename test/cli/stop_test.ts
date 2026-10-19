import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("stop - reads PID from file correctly", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cora-stop-test-"));
  const pidFile = join(tmp, "cora.pid");

  await writeFile(pidFile, "12345");
  const text = await readFile(pidFile, "utf8");
  const pid = parseInt(text.trim(), 10);
  assert.deepEqual(pid, 12345);

  await rm(tmp, { recursive: true, force: true });
});

test("stop - missing PID file throws", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cora-stop-test-"));
  const pidFile = join(tmp, "nonexistent.pid");

  await assert.rejects(async () => {
    await readFile(pidFile, "utf8");
  });

  await rm(tmp, { recursive: true, force: true });
});

test("stop - PID file removal works", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cora-stop-test-"));
  const pidFile = join(tmp, "cora.pid");

  await writeFile(pidFile, "99999");
  await rm(pidFile);

  // Should no longer exist
  await assert.rejects(async () => {
    await readFile(pidFile, "utf8");
  });

  await rm(tmp, { recursive: true, force: true });
});

test("stop - killing non-existent PID throws", () => {
  // Use a PID that almost certainly doesn't exist
  let threw = false;
  try {
    process.kill(2147483647, "SIGTERM");
  } catch {
    threw = true;
  }
  assert.deepEqual(threw, true);
});
