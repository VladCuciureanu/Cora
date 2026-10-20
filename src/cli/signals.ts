/**
 * Run `shutdown` on the first SIGINT or SIGTERM. A second one while it runs
 * (say, a shutdown stuck in git) exits at once with code 130.
 */
export function onShutdownSignal(shutdown: () => Promise<void>): void {
  let stopping = false;
  const handler = () => {
    if (stopping) {
      console.error("cora: forced exit");
      process.exit(130);
    }
    stopping = true;
    void shutdown();
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
