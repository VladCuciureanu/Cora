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
  cora init          Interactive setup: GitHub PAT, repo, API key
  cora start         Begin listening for beats and committing
  cora stop          Graceful shutdown, flush queued beats
  cora status        Show connection state, beats/min, queue depth
  cora stats         Lifetime stats: total beats, longest streak, avg BPM
  cora replay        Replay queued beats from an offline period
  cora mock [speed]  Simulate heartbeat in real-time (speed: 1=realtime, 1440=1day/min)
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
