type ShutdownSignal = "SIGINT" | "SIGTERM";

/** Exit codes for a forced exit: 128 + the signal number, as a shell reports it. */
const FORCED_EXIT_CODES: Record<ShutdownSignal, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * One Ctrl+C can reach the process twice (the terminal signals the process
 * group and npm or `node --watch` forwards it), so repeats this soon after the
 * first signal are ignored.
 */
const REPEAT_WINDOW_MS = 1000;

export interface SignalDeps {
  now?: () => number;
  exit?: (code: number) => void;
  error?: (message: string) => void;
  on?: (signal: ShutdownSignal, handler: () => void) => void;
}

/**
 * Run `shutdown` on the first SIGINT or SIGTERM. A signal more than a second
 * later, while it is still running (say, stuck in git), exits at once with
 * 130 (SIGINT) or 143 (SIGTERM).
 */
export function onShutdownSignal(
  shutdown: () => Promise<void>,
  {
    now = Date.now,
    exit = (code) => process.exit(code),
    error = (message) => console.error(message),
    on = (signal, handler) => process.on(signal, handler),
  }: SignalDeps = {},
): void {
  let firstAt: number | undefined;
  const handle = (signal: ShutdownSignal) => {
    if (firstAt === undefined) {
      firstAt = now();
      void shutdown();
      return;
    }
    if (now() - firstAt < REPEAT_WINDOW_MS) return;
    error("cora: forced exit");
    exit(FORCED_EXIT_CODES[signal]);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) on(signal, () => handle(signal));
}
