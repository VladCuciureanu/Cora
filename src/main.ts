#!/usr/bin/env node
import { parseArgs } from "node:util";
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
  --help, -h         Show this help message; cora <command> --help shows a command's options
  --version, -v      Show version
`.trim();

const VERSION = "0.1.0";

interface Command {
  usage: string;
  /** Options besides --help; all take a value. */
  options?: string[];
  /** How many positional arguments the command takes. */
  maxPositionals?: number;
  run: (values: Record<string, string | undefined>, positionals: string[]) => Promise<void>;
}

const commands: Record<string, Command> = {
  init: {
    usage: `
Usage: cora init

Prompt for a GitHub PAT, the repo URL and the server port, generate an API key,
save ~/.config/cora/config.json and print the phone setup (with a QR code).`,
    run: () => initCommand(),
  },
  start: {
    usage: `
Usage: cora start

Clone the beats repo if needed, replay queued beats, then listen for beats on
the configured port and commit them until stopped.`,
    run: () => startCommand(),
  },
  stop: {
    usage: `
Usage: cora stop

Send SIGTERM to the running instance, which commits and pushes pending beats
before exiting. Exits 1 if Cora is not running.`,
    run: () => stopCommand(),
  },
  status: {
    usage: `
Usage: cora status

Show whether Cora is running and, if so, its PID, port and latest BPM.`,
    run: () => statusCommand(),
  },
  stats: {
    usage: `
Usage: cora stats

Show total commits, first and last beat, the current daily streak and the
average BPM from the beats repo.`,
    run: () => statsCommand(),
  },
  replay: {
    usage: `
Usage: cora replay

Commit beats that were queued while commits were failing. Beats that fail
again stay queued.`,
    run: () => replayCommand(),
  },
  mock: {
    usage: `
Usage: cora mock [speed] [--speed <n>]
       cora mock --from <date> [--to <date>]

Simulate a heart and commit its beats.

Live mode (no --from) runs until stopped, at <speed> simulated seconds per
real second (default 1; 60 = 1 hour/min). Speed is capped at 100x.

Options:
  --speed <n>    Same as the [speed] argument
  --from <date>  Backfill from this date instead of running live
  --to <date>    End of the backfill (default: now); needs --from
  --help, -h     Show this help message`,
    options: ["speed", "from", "to"],
    maxPositionals: 1,
    run: ({ speed, from, to }, [positionalSpeed]) =>
      mockCommand({ speed: speed ?? positionalSpeed, from, to }),
  },
};

/** Parse a command's arguments strictly: unknown options and missing values are errors. */
function parseCommandArgs(name: string, command: Command, args: string[]) {
  const options: Record<string, { type: "string" } | { type: "boolean"; short: string }> = {
    help: { type: "boolean", short: "h" },
  };
  for (const option of command.options ?? []) options[option] = { type: "string" };
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    // Keep only Node's first sentence, e.g. "Unknown option '--x'"
    throw new Error(`${(e as Error).message.split(". ")[0]}. See "cora ${name} --help".`);
  }
  const extra = parsed.positionals[command.maxPositionals ?? 0];
  if (extra !== undefined) {
    throw new Error(`Unexpected argument '${extra}'. See "cora ${name} --help".`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);

  if (!name || name === "--help" || name === "-h") {
    console.log(HELP);
    return;
  }

  if (name === "--version" || name === "-v") {
    console.log(`cora v${VERSION}`);
    return;
  }

  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) throw new Error(`Unknown command '${name}'. See "cora --help".`);

  const { values, positionals } = parseCommandArgs(name, command, args);
  if (values.help) {
    console.log(command.usage.trim());
    return;
  }
  await command.run(values as Record<string, string | undefined>, positionals);
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
