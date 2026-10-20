import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type CoraConfig, loadConfig, saveConfig } from "../../src/config.ts";
import { git } from "../../src/git.ts";

const MAIN = join(import.meta.dirname, "..", "..", "src", "main.ts");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI in a child process with its home (and so its config dir) at
 * `home`. A run that has not exited after 20 s is killed (code null).
 */
function runCli(
  args: string[],
  home: string,
  input = "",
  env: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on("close", () => clearTimeout(timer));
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

test("cli - --version prints the package.json version", async () => {
  await withHome(async (home) => {
    const manifest = JSON.parse(await readFile(join(MAIN, "..", "..", "package.json"), "utf8"));
    const { code, stdout } = await runCli(["--version"], home);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), `cora v${manifest.version}`);
  });
});

test("cli - a backfill that fails after the repo is cloned exits 1 promptly", async () => {
  await withHome(async (home) => {
    const remote = join(home, "remote.git");
    await git(["init", "--bare", remote], home);
    await saveConfig(configFor(home, { repoUrl: remote }), configPathIn(home));
    const started = Date.now();
    const { code, stderr } = await runCli(
      ["mock", "--from", "2025-02-01", "--to", "2025-02-01T01:00:00Z"],
      home,
      "",
      // An ident git fast-import rejects, so the import fails after a good clone
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.email", GIT_CONFIG_VALUE_0: "bad<x" },
    );
    assert.equal(code, 1, stderr);
    assert.match(stderr, /^cora: git fast-import failed: .*\n$/);
    assert.ok(Date.now() - started < 10_000, "took too long to exit");
  });
});

/** A `git` for PATH that hangs on `commit` and passes everything else to the real git. */
async function gitHangingOnCommit(home: string): Promise<string> {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = commit ]; then exec sleep 30; fi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("cli - a later second signal forces mock to exit while its shutdown hangs", {
  skip: process.platform === "win32" && "POSIX signals can't be delivered on Windows",
}, async () => {
  await withHome(async (home) => {
    const remote = join(home, "remote.git");
    await git(["init", "--bare", remote], home);
    // a commit interval of one sample: the first tick commits, and hangs
    const config = configFor(home, { repoUrl: remote, commitIntervalMs: 5000 });
    await saveConfig(config, configPathIn(home));
    const bin = await gitHangingOnCommit(home);

    const child = spawn(process.execPath, [MAIN, "mock", "100"], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    const exited = once(child, "exit");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const output = () => `stdout: ${stdout}\nstderr: ${stderr}`;
    const waitFor = async (pattern: RegExp) => {
      while (!pattern.test(stdout)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          assert.fail(`exited before ${pattern}\n${output()}`);
        }
        await delay(20);
      }
    };
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      await waitFor(/Mock heart started/);
      // let the first tick (due after 50 ms) get stuck in its commit
      await delay(500);
      child.kill("SIGINT");
      await waitFor(/Stopping mock heart/);
      // past the window in which a repeat of the first signal is ignored
      await delay(1500);
      const signalled = Date.now();
      child.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 143, output());
      assert.ok(Date.now() - signalled < 3000, "took too long to exit");
      assert.match(stderr, /^cora: forced exit\n$/m);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  });
});
