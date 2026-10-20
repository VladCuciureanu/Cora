import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stopCommand } from "../../src/cli/stop.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cora-stop-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("stop - terminates the process in the PID file and removes it", async (t) => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, "cora.pid");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    try {
      await writeFile(pidFile, String(child.pid));
      t.mock.method(console, "log", () => {});

      await stopCommand(pidFile);

      await exited;
      assert.notDeepEqual(child.exitCode, 0);
      await assert.rejects(stat(pidFile), { code: "ENOENT" });
    } finally {
      child.kill();
    }
  });
});

test("stop - stale PID file is removed", async (t) => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, "cora.pid");
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    await writeFile(pidFile, String(child.pid));
    const error = t.mock.method(console, "error", () => {});

    await stopCommand(pidFile);

    await assert.rejects(stat(pidFile), { code: "ENOENT" });
    assert.match(String(error.mock.calls[0].arguments[0]), /Failed to stop Cora/);
  });
});

test("stop - missing PID file reports not running and fails", async (t) => {
  await withTempDir(async (dir) => {
    const error = t.mock.method(console, "error", () => {});
    try {
      await stopCommand(join(dir, "cora.pid"));
      assert.deepEqual(process.exitCode, 1);
      assert.match(String(error.mock.calls[0].arguments[0]), /not running/);
    } finally {
      process.exitCode = 0;
    }
  });
});

test("stop - failing to signal the process fails", async (t) => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, "cora.pid");
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    await writeFile(pidFile, String(child.pid));
    t.mock.method(console, "error", () => {});
    try {
      await stopCommand(pidFile);
      assert.deepEqual(process.exitCode, 1);
    } finally {
      process.exitCode = 0;
    }
  });
});
