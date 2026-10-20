import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pidPath, saveConfig } from "../../src/config/mod.ts";
import { startCommand } from "../../src/cli/start.ts";
import { mockCommand } from "../../src/cli/mock.ts";

/** Point the config dir at a fresh temp home whose repo URL cannot be cloned. */
async function withBrokenHome(fn: () => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "cora-pid-test-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await saveConfig({
      githubPat: "ghp_test",
      repoUrl: join(home, "no-such-remote"),
      apiKey: "key",
      commitIntervalMs: 300_000,
      eventThresholdPercent: 20,
      port: 7331,
    });
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test("start - no PID file is left behind when git setup fails", async () => {
  await withBrokenHome(async () => {
    await assert.rejects(startCommand(), /git clone failed/);
    await assert.rejects(stat(pidPath()), { code: "ENOENT" });
  });
});

test("mock - no PID file is left behind when git setup fails", async () => {
  await withBrokenHome(async () => {
    await assert.rejects(mockCommand(["mock", "--from", "2026-01-01", "--to", "2026-01-02"]), /git clone failed/);
    await assert.rejects(stat(pidPath()), { code: "ENOENT" });
  });
});
