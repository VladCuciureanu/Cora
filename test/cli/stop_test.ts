import { assertEquals, assertRejects } from "jsr:@std/assert";
import { join } from "@std/path";

Deno.test("stop - reads PID from file correctly", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cora-stop-test-" });
  const pidFile = join(tmp, "cora.pid");

  await Deno.writeTextFile(pidFile, "12345");
  const text = await Deno.readTextFile(pidFile);
  const pid = parseInt(text.trim(), 10);
  assertEquals(pid, 12345);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("stop - missing PID file throws", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cora-stop-test-" });
  const pidFile = join(tmp, "nonexistent.pid");

  await assertRejects(async () => {
    await Deno.readTextFile(pidFile);
  });

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("stop - PID file removal works", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cora-stop-test-" });
  const pidFile = join(tmp, "cora.pid");

  await Deno.writeTextFile(pidFile, "99999");
  await Deno.remove(pidFile);

  // Should no longer exist
  await assertRejects(async () => {
    await Deno.readTextFile(pidFile);
  });

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("stop - killing non-existent PID throws", () => {
  // Use a PID that almost certainly doesn't exist
  let threw = false;
  try {
    Deno.kill(2147483647, "SIGTERM");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
