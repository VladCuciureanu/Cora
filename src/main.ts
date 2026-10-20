#!/usr/bin/env node
import { initCommand } from "./cli/init.ts";
import { mockCommand } from "./cli/mock.ts";
import { replayCommand } from "./cli/replay.ts";
import { startCommand } from "./cli/start.ts";
import { statsCommand } from "./cli/stats.ts";
import { statusCommand } from "./cli/status.ts";
import { stopCommand } from "./cli/stop.ts";

const HELP = `
cora — your heartbeat on GitHub

Usage:
  cora init          Interactive setup: GitHub PAT, repo URL, port; generates an API key
  cora start         Listen for beats and commit them
  cora stop          Stop the running instance; it commits and pushes pending beats first
  cora status        Show whether Cora is running: its PID, port and latest BPM
  cora stats         Lifetime stats: total commits, first/last beat, current daily streak, average BPM
  cora replay        Commit beats queued while commits were failing
  cora mock [speed]  Simulate a heart live (speed: 1 = real time, 60 = 1 hour/min; capped at 100x)
  cora mock --from 2025-01-01 [--to 2025-06-01]  Backfill past dates

Options:
  --help, -h         Show this help message
  --version, -v      Show version
`.trim();

const VERSION = "0.1.0";

const commands: Record<string, () => Promise<void>> = {
  init: initCommand,
  start: startCommand,
  stop: stopCommand,
  status: statusCommand,
  stats: statsCommand,
  replay: replayCommand,
  mock: mockCommand,
};

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(`cora v${VERSION}`);
    return;
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "cora --help" for usage.');
    process.exitCode = 1;
    return;
  }

  await handler();
}

/** Collapse an error to a single line, e.g. git's multi-line stderr. */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\s*\n\s*/g, " ");
}

main().catch((error: unknown) => {
  console.error(`cora: ${oneLine(error)}`);
  process.exitCode = 1;
});
