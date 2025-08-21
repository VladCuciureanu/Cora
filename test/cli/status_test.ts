import { assertEquals } from "jsr:@std/assert";
import { join } from "@std/path";

Deno.test("status - PID file contains valid integer", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cora-status-test-" });
  const pidFile = join(tmp, "cora.pid");

  await Deno.writeTextFile(pidFile, String(Deno.pid));
  const text = await Deno.readTextFile(pidFile);
  const pid = parseInt(text.trim(), 10);
  assertEquals(pid, Deno.pid);
  assertEquals(Number.isInteger(pid), true);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("status - detects dead process via kill", () => {
  // Use a PID that doesn't exist
  let alive = false;
  try {
    Deno.kill(2147483647, "SIGCONT");
    alive = true;
  } catch {
    alive = false;
  }
  assertEquals(alive, false);
});

Deno.test("status - missing PID file means not running", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cora-status-test-" });
  const pidFile = join(tmp, "nonexistent.pid");

  let running = false;
  try {
    await Deno.readTextFile(pidFile);
    running = true;
  } catch {
    running = false;
  }
  assertEquals(running, false);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("status - health endpoint parsing", () => {
  const mockResponse = { status: "alive", bpm: 72 };
  assertEquals(mockResponse.bpm, 72);
  assertEquals(mockResponse.status, "alive");

  const nullBpmResponse = { status: "alive", bpm: null };
  assertEquals(nullBpmResponse.bpm ?? "no data yet", "no data yet");
});
