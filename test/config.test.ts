import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type CoraConfig,
  generateApiKey,
  loadConfig,
  resolveConfigDir,
  saveConfig,
} from "../src/config.ts";

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

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cora-config-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveConfig/loadConfig - roundtrip, creating the directory", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "config.json");
    const config: CoraConfig = {
      githubPat: "ghp_testtoken123",
      repoUrl: "https://github.com/test/repo",
      apiKey: "abc123",
      commitIntervalMs: 60_000,
      eventThresholdPercent: 15,
      port: 8080,
    };

    await saveConfig(config, path);
    assert.deepEqual(await loadConfig(path), config);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
  });
});

test("loadConfig - fills in defaults for missing optional fields", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({ githubPat: "ghp_x", repoUrl: "https://x", apiKey: "key", port: 9000 }),
    );

    assert.deepEqual(await loadConfig(path), {
      githubPat: "ghp_x",
      repoUrl: "https://x",
      apiKey: "key",
      commitIntervalMs: 5 * 60 * 1000,
      eventThresholdPercent: 20,
      port: 9000,
    });
  });
});

test("loadConfig - returns null for a missing file", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await loadConfig(join(dir, "missing.json")), null);
  });
});

test("loadConfig - a malformed file is an error, not a missing config", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    await writeFile(path, "{ not json");
    await assert.rejects(loadConfig(path), /is not valid JSON/);
  });
});

test("loadConfig - rejects unknown keys and wrongly typed values", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    const valid = { githubPat: "ghp_x", repoUrl: "https://x", apiKey: "key" };
    const cases: [Record<string, unknown>, RegExp][] = [
      [[] as unknown as Record<string, unknown>, /expected a JSON object/],
      [{ ...valid, prot: 8080 }, /unknown key "prot"/],
      [{ ...valid, githubPat: undefined }, /"githubPat" must be a non-empty string/],
      [{ ...valid, repoUrl: 42 }, /"repoUrl" must be a non-empty string/],
      [{ ...valid, apiKey: "" }, /"apiKey" must be a non-empty string/],
      [{ ...valid, port: "8080" }, /"port" must be an integer from 1 to 65535/],
      [{ ...valid, port: 70000 }, /"port" must be an integer from 1 to 65535/],
      [{ ...valid, commitIntervalMs: 0 }, /"commitIntervalMs" must be a positive number/],
      [{ ...valid, eventThresholdPercent: "20" }, /"eventThresholdPercent" must be a positive/],
    ];
    for (const [config, error] of cases) {
      await writeFile(path, JSON.stringify(config));
      await assert.rejects(loadConfig(path), error, JSON.stringify(config));
    }
  });
});

test("saveConfig - config file is readable by the owner only", {
  skip: process.platform === "win32" ? "POSIX file modes not supported on Windows" : false,
}, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cora-config-test-"));
  try {
    const path = join(tmpDir, "cora", "config.json");
    const config: CoraConfig = {
      githubPat: "ghp_x",
      repoUrl: "https://x",
      apiKey: "key",
      commitIntervalMs: 300_000,
      eventThresholdPercent: 20,
      port: 7331,
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

test("resolveConfigDir - uses the os home dir when HOME agrees or nothing is there", () => {
  const exists = () => false;
  assert.equal(
    resolveConfigDir({ homedir: "/u", env: { HOME: "/u" }, exists }),
    join("/u", ".config", "cora"),
  );
  assert.equal(
    resolveConfigDir({ homedir: "/u", env: { HOME: "/h" }, exists }),
    join("/u", ".config", "cora"),
  );
});

test("resolveConfigDir - keeps a pre-0.2 config under a different HOME", () => {
  const legacy = join("/h", ".config", "cora");
  const current = join("/u", ".config", "cora");
  const notes: string[] = [];
  const dir = resolveConfigDir({
    homedir: "/u",
    env: { HOME: "/h", USERPROFILE: "/u" },
    exists: (p) => p === join(legacy, "config.json"),
    note: (m) => notes.push(m),
  });
  assert.equal(dir, legacy);
  assert.equal(notes.length, 1);
  assert.match(notes[0] as string, /\.config.cora/);

  // a config at the new location wins
  const both = resolveConfigDir({
    homedir: "/u",
    env: { HOME: "/h" },
    exists: (p) => p === join(legacy, "config.json") || p === join(current, "config.json"),
  });
  assert.equal(both, current);
});
