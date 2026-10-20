import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { statusCommand } from "../../src/cli/status.ts";
import { saveConfig } from "../../src/config/mod.ts";

/** PID of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

async function listen(body: unknown): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0);
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port };
}

/** Run statusCommand against a temp config/PID file and return what it logged. */
async function runStatus(t: TestContext, opts: { pid?: number; port?: number }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cora-status-test-"));
  try {
    const configPath = join(dir, "config.json");
    const pidFile = join(dir, "cora.pid");
    await saveConfig(
      {
        githubPat: "ghp_test",
        repoUrl: "https://github.com/test/repo",
        apiKey: "key",
        commitIntervalMs: 300_000,
        eventThresholdPercent: 20,
        port: opts.port ?? 7331,
      },
      configPath,
    );
    if (opts.pid !== undefined) await writeFile(pidFile, String(opts.pid));

    const log = t.mock.method(console, "log", () => {});
    await statusCommand({ configPath, pidFile });
    const output = log.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    log.mock.restore();
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("status - missing PID file means not running", async (t) => {
  assert.deepEqual(await runStatus(t, {}), "♥ Cora is not running.");
});

test("status - PID of an exited process means not running", async (t) => {
  assert.deepEqual(await runStatus(t, { pid: await deadPid() }), "♥ Cora is not running.");
});

test("status - running process reports BPM from the health endpoint", async (t) => {
  const { server, port } = await listen({ status: "alive", bpm: 72 });
  try {
    const output = await runStatus(t, { pid: process.pid, port });
    assert.deepEqual(output.split("\n"), [
      `♥ Cora is running (PID ${process.pid})`,
      `  Port: ${port}`,
      "  Current BPM: 72",
    ]);
  } finally {
    server.close();
  }
});

test("status - null BPM is shown as no data yet", async (t) => {
  const { server, port } = await listen({ status: "alive", bpm: null });
  try {
    const output = await runStatus(t, { pid: process.pid, port });
    assert.ok(output.endsWith("  Current BPM: no data yet"), output);
  } finally {
    server.close();
  }
});

test("status - unreachable health endpoint is reported", async (t) => {
  const { server, port } = await listen({});
  server.close();
  await once(server, "close");
  const output = await runStatus(t, { pid: process.pid, port });
  assert.ok(output.endsWith("  Could not reach health endpoint."), output);
});
