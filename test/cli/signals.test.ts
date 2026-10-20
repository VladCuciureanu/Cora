import assert from "node:assert/strict";
import { test } from "node:test";
import { onShutdownSignal } from "../../src/cli/signals.ts";

type Signal = "SIGINT" | "SIGTERM";

/** Install the handler with a fake clock, exit and process; returns a way to send signals. */
function setup() {
  let now = 0;
  const handlers = new Map<Signal, () => void>();
  const exits: number[] = [];
  const errors: string[] = [];
  let shutdowns = 0;
  onShutdownSignal(
    () => {
      shutdowns++;
      return new Promise<void>(() => {}); // a shutdown that hangs
    },
    {
      now: () => now,
      exit: (code) => {
        exits.push(code);
      },
      error: (message) => errors.push(message),
      on: (signal, handler) => handlers.set(signal, handler),
    },
  );
  return {
    send(signal: Signal, at: number) {
      now = at;
      const handler = handlers.get(signal);
      assert.ok(handler, `no ${signal} handler`);
      handler();
    },
    get shutdowns() {
      return shutdowns;
    },
    exits,
    errors,
  };
}

test("onShutdownSignal - a single signal starts one shutdown and does not exit", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const s = setup();
    s.send(signal, 1000);
    assert.equal(s.shutdowns, 1);
    assert.deepEqual(s.exits, []);
  }
});

test("onShutdownSignal - a repeat within a second (one Ctrl+C delivered twice) is ignored", () => {
  const s = setup();
  s.send("SIGINT", 1000);
  s.send("SIGINT", 1005);
  s.send("SIGTERM", 1999);
  assert.equal(s.shutdowns, 1);
  assert.deepEqual(s.exits, []);
  assert.deepEqual(s.errors, []);
});

test("onShutdownSignal - a later second signal forces exit with 128 + its number", () => {
  const int = setup();
  int.send("SIGINT", 1000);
  int.send("SIGINT", 2000);
  assert.deepEqual(int.exits, [130]);
  assert.deepEqual(int.errors, ["cora: forced exit"]);
  assert.equal(int.shutdowns, 1);

  const term = setup();
  term.send("SIGINT", 1000);
  term.send("SIGTERM", 5000);
  assert.deepEqual(term.exits, [143]);
});
