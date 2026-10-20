import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type CoraConfig, loadConfig, saveConfig } from "../../src/config.ts";

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

test("cli - init re-prompts for an invalid port and prints the real config path", async () => {
  await withHome(async (home) => {
    const { code, stdout, stderr } = await runCli(
      ["init"],
      home,
      "ghp_test\nhttps://github.com/u/r\nabc\n70000\n8080\n",
    );
    assert.equal(code, 0, stderr);
    assert.equal(stderr.match(/must be an integer from 1 to 65535/g)?.length, 2, stderr);
    assert.equal((await loadConfig(configPathIn(home)))?.port, 8080);
    assert.ok(stdout.includes(`Config saved to ${configPathIn(home)}`), stdout);
  });
});

test("cli - help describes what status, stats and mock actually do", async () => {
  await withHome(async (home) => {
    const { code, stdout } = await runCli(["--help"], home);
    assert.equal(code, 0);
    assert.match(stdout, /cora status +Show whether Cora is running: its PID, port and latest BPM/);
    assert.match(stdout, /cora stats +.*total commits, .*current daily streak, average BPM/);
    assert.match(stdout, /capped at 100x/);
    assert.doesNotMatch(stdout, /queue depth|longest streak|1440/);
  });
});

test("cli - <command> --help prints that command's usage instead of running it", async () => {
  await withHome(async (home) => {
    for (const command of ["init", "start", "stop", "status", "stats", "replay", "mock"]) {
      const { code, stdout, stderr } = await runCli([command, "--help"], home);
      assert.equal(code, 0, `${command}: ${stderr}`);
      assert.equal(stderr, "");
      assert.match(stdout, new RegExp(`^Usage: cora ${command}\\b`), command);
    }
    const { stdout } = await runCli(["mock", "-h"], home);
    assert.match(stdout, /--speed <n>/);
  });
});

test("cli - unknown arguments and missing values are usage errors", async () => {
  await withHome(async (home) => {
    for (const [args, error] of [
      [["status", "--bogus"], /Unknown option '--bogus'/],
      [["stop", "now"], /Unexpected argument 'now'/],
      [["mock", "--from"], /Option '--from <value>' argument missing/],
      [["mock", "--speed"], /Option '--speed <value>' argument missing/],
      [["mock", "60", "70"], /Unexpected argument '70'/],
      [["mock", "--to", "2026-01-01"], /--to needs --from/],
      [["nope"], /Unknown command 'nope'/],
    ] as const) {
      const { code, stdout, stderr } = await runCli([...args], home);
      assert.equal(code, 1, args.join(" "));
      assert.equal(stdout, "");
      assert.match(stderr, /^cora: [^\n]*\n$/, args.join(" "));
      assert.match(stderr, error);
    }
  });
});
