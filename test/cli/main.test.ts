import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type CoraConfig, saveConfig } from "../../src/config.ts";

const MAIN = join(import.meta.dirname, "..", "..", "src", "main.ts");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI in a child process with its home (and so its config dir) at `home`. */
function runCli(args: string[], home: string, input = ""): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "cora-cli-test-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function configFor(home: string, overrides: Partial<CoraConfig> = {}): CoraConfig {
  return {
    githubPat: "ghp_test",
    repoUrl: join(home, "no-such-remote"),
    apiKey: "key",
    commitIntervalMs: 300_000,
    eventThresholdPercent: 20,
    port: 7331,
    ...overrides,
  };
}

const configPathIn = (home: string) => join(home, ".config", "cora", "config.json");

test("cli - a failing command prints one error line without a stack trace and exits 1", async () => {
  await withHome(async (home) => {
    await saveConfig(configFor(home), configPathIn(home));
    const { code, stderr } = await runCli(["start"], home);
    assert.equal(code, 1);
    assert.match(stderr, /^cora: git clone failed: .*\n$/);
  });
});

test("cli - a malformed config is reported as such, not as missing", async () => {
  await withHome(async (home) => {
    await saveConfig(configFor(home), configPathIn(home));
    await writeFile(configPathIn(home), "{ not json");
    const { code, stderr } = await runCli(["status"], home);
    assert.equal(code, 1);
    assert.match(stderr, /^cora: Config .*config\.json is not valid JSON: .*\n$/);
  });
});
