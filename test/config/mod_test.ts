import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateApiKey, saveConfig, type CoraConfig } from "../../src/config/mod.ts";

test("generateApiKey - returns 64-char hex string", () => {
  const key = generateApiKey();
  assert.deepEqual(key.length, 64);
  assert.deepEqual(/^[0-9a-f]+$/.test(key), true);
});

test("generateApiKey - generates unique keys", () => {
  const key1 = generateApiKey();
  const key2 = generateApiKey();
  assert.notDeepEqual(key1, key2);
});

test("config - save and load roundtrip", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cora-config-test-"));
  const configPath = join(tmpDir, "config.json");

  const config: CoraConfig = {
    githubPat: "ghp_testtoken123",
    repoUrl: "https://github.com/test/repo",
    apiKey: "abc123",
    commitIntervalMs: 300_000,
    eventThresholdPercent: 20,
    port: 7331,
  };

  // Save
  await mkdir(tmpDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  // Load
  const text = await readFile(configPath, "utf8");
  const loaded: CoraConfig = JSON.parse(text);

  assert.deepEqual(loaded.githubPat, config.githubPat);
  assert.deepEqual(loaded.repoUrl, config.repoUrl);
  assert.deepEqual(loaded.apiKey, config.apiKey);
  assert.deepEqual(loaded.commitIntervalMs, config.commitIntervalMs);
  assert.deepEqual(loaded.eventThresholdPercent, config.eventThresholdPercent);
  assert.deepEqual(loaded.port, config.port);

  await rm(tmpDir, { recursive: true, force: true });
});

test("config - load returns all fields", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cora-config-test-"));
  const configPath = join(tmpDir, "config.json");

  const partial = { githubPat: "ghp_x", repoUrl: "https://x", apiKey: "key" };
  await writeFile(configPath, JSON.stringify(partial));

  const text = await readFile(configPath, "utf8");
  const loaded = JSON.parse(text);

  assert.deepEqual(loaded.githubPat, "ghp_x");
  assert.deepEqual(loaded.repoUrl, "https://x");
  assert.deepEqual(loaded.apiKey, "key");

  await rm(tmpDir, { recursive: true, force: true });
});

test("saveConfig - config file is readable by the owner only", {
  skip: process.platform === "win32" ? "POSIX file modes not supported on Windows" : false,
}, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cora-config-test-"));
  try {
    const path = join(tmpDir, "cora", "config.json");
    const config: CoraConfig = {
      githubPat: "ghp_x", repoUrl: "https://x", apiKey: "key",
      commitIntervalMs: 300_000, eventThresholdPercent: 20, port: 7331,
    };
    await saveConfig(config, path);
    assert.deepEqual((await stat(path)).mode & 0o777, 0o600);

    // An existing world-readable config is tightened on the next save
    await chmod(path, 0o644);
    await saveConfig(config, path);
    assert.deepEqual((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
