import { assertEquals } from "jsr:@std/assert";
import { join } from "@std/path";
import { calculateStreak, parseBpmsFromMessages, getStats } from "./stats.ts";
import { git } from "../git/mod.ts";

Deno.test("calculateStreak - consecutive days from today", () => {
  const today = new Date("2026-03-24T12:00:00Z");
  const dates = [
    "2026-03-22T10:00:00+00:00",
    "2026-03-23T10:00:00+00:00",
    "2026-03-24T10:00:00+00:00",
  ];
  assertEquals(calculateStreak(dates, today), 3);
});

Deno.test("calculateStreak - gap breaks streak", () => {
  const today = new Date("2026-03-24T12:00:00Z");
  const dates = [
    "2026-03-21T10:00:00+00:00",
    // gap on 2026-03-22
    "2026-03-23T10:00:00+00:00",
    "2026-03-24T10:00:00+00:00",
  ];
  assertEquals(calculateStreak(dates, today), 2);
});

Deno.test("calculateStreak - no commits today means 0", () => {
  const today = new Date("2026-03-24T12:00:00Z");
  const dates = [
    "2026-03-22T10:00:00+00:00",
    "2026-03-23T10:00:00+00:00",
  ];
  assertEquals(calculateStreak(dates, today), 0);
});

Deno.test("calculateStreak - empty dates returns 0", () => {
  assertEquals(calculateStreak([], new Date()), 0);
});

Deno.test("parseBpmsFromMessages - extracts BPM values", () => {
  const messages = [
    "♥ 72bpm @ 2026-03-24T12:00:00Z",
    "⚡ 140bpm spike @ 2026-03-24T12:01:00Z",
    "♥ 65bpm @ 2026-03-24T12:05:00Z",
  ];
  assertEquals(parseBpmsFromMessages(messages), [72, 140, 65]);
});

Deno.test("parseBpmsFromMessages - ignores non-bpm messages", () => {
  const messages = ["init", "some random commit", "♥ 80bpm @ ts"];
  assertEquals(parseBpmsFromMessages(messages), [80]);
});

Deno.test("parseBpmsFromMessages - empty returns empty", () => {
  assertEquals(parseBpmsFromMessages([]), []);
});

async function withTempRepo(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "cora-stats-test-" });
  await git(["init"], dir);
  await git(["config", "user.email", "test@test.com"], dir);
  await git(["config", "user.name", "Test"], dir);
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("getStats - computes stats from real git repo", async () => {
  await withTempRepo(async (dir) => {
    const today = new Date();
    const todayIso = today.toISOString();

    // Create commits with heartbeat-style messages
    for (const [bpm, i] of [[70, 0], [80, 1], [90, 2]] as const) {
      const ts = new Date(today.getTime() + i * 60_000).toISOString();
      await Deno.writeTextFile(join(dir, `f${i}.txt`), `${i}`);
      await git(["add", `f${i}.txt`], dir);
      await git(
        ["commit", "-m", `♥ ${bpm}bpm @ ${ts}`],
        dir,
        { GIT_AUTHOR_DATE: todayIso, GIT_COMMITTER_DATE: todayIso },
      );
    }

    const stats = await getStats(dir, today);
    assertEquals(stats!.totalCommits, 3);
    assertEquals(stats!.avgBpm, 80); // (70+80+90)/3
    assertEquals(stats!.streakDays, 1);
  });
});

Deno.test("getStats - returns null for empty repo", async () => {
  await withTempRepo(async (dir) => {
    // Create an empty commit so HEAD exists but no heartbeat format
    await Deno.writeTextFile(join(dir, "init.txt"), "");
    await git(["add", "init.txt"], dir);
    await git(["commit", "-m", "init"], dir);

    const stats = await getStats(dir);
    // Has commits but no bpm data
    assertEquals(stats!.totalCommits, 1);
    assertEquals(stats!.avgBpm, null);
  });
});
