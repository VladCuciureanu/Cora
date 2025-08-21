import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { generateApiKey, type CoraConfig } from "./mod.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

Deno.test("generateApiKey - returns 64-char hex string", () => {
  const key = generateApiKey();
  assertEquals(key.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(key), true);
});

Deno.test("generateApiKey - generates unique keys", () => {
  const key1 = generateApiKey();
  const key2 = generateApiKey();
  assertNotEquals(key1, key2);
});

Deno.test("config - save and load roundtrip", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "cora-config-test-" });
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
  await ensureDir(tmpDir);
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");

  // Load
  const text = await Deno.readTextFile(configPath);
  const loaded: CoraConfig = JSON.parse(text);

  assertEquals(loaded.githubPat, config.githubPat);
  assertEquals(loaded.repoUrl, config.repoUrl);
  assertEquals(loaded.apiKey, config.apiKey);
  assertEquals(loaded.commitIntervalMs, config.commitIntervalMs);
  assertEquals(loaded.eventThresholdPercent, config.eventThresholdPercent);
  assertEquals(loaded.port, config.port);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("config - load returns all fields", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "cora-config-test-" });
  const configPath = join(tmpDir, "config.json");

  const partial = { githubPat: "ghp_x", repoUrl: "https://x", apiKey: "key" };
  await Deno.writeTextFile(configPath, JSON.stringify(partial));

  const text = await Deno.readTextFile(configPath);
  const loaded = JSON.parse(text);

  assertEquals(loaded.githubPat, "ghp_x");
  assertEquals(loaded.repoUrl, "https://x");
  assertEquals(loaded.apiKey, "key");

  await Deno.remove(tmpDir, { recursive: true });
});
