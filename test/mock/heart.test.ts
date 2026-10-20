import assert from "node:assert/strict";
import { test } from "node:test";
import { MockHeart } from "../../src/mock/heart.ts";

function dateAt(hour: number, minute: number): Date {
  const d = new Date("2026-03-24T00:00:00");
  d.setHours(hour, minute, 0, 0);
  return d;
}

test("MockHeart - sleep HR is lower than daytime HR", () => {
  const heart = new MockHeart({ restingHr: 68, seed: 42 });

  const sleepBpm = heart.bpmAt(dateAt(3, 0)); // 03:00
  const dayBpm = heart.bpmAt(dateAt(12, 0)); // 12:00

  // Sleep HR should be notably lower
  assert.deepEqual(sleepBpm < 60, true, `Sleep BPM ${sleepBpm} should be < 60`);
  assert.deepEqual(dayBpm >= 60, true, `Day BPM ${dayBpm} should be >= 60`);
});

test("MockHeart - HR is within physiological range", () => {
  const heart = new MockHeart({ restingHr: 68, seed: 42 });

  // Sample every hour across a full day
  for (let h = 0; h < 24; h++) {
    const bpm = heart.bpmAt(dateAt(h, 0));
    assert.deepEqual(bpm >= 40, true, `BPM ${bpm} at ${h}:00 should be >= 40`);
    assert.deepEqual(bpm <= 200, true, `BPM ${bpm} at ${h}:00 should be <= 200`);
  }
});

test("MockHeart - wake transition ramps up", () => {
  const heart = new MockHeart({ restingHr: 68, seed: 42 });

  const before = heart.bpmAt(dateAt(6, 15)); // still sleeping
  const during = heart.bpmAt(dateAt(7, 0)); // mid-transition
  const after = heart.bpmAt(dateAt(7, 45)); // fully awake

  assert.deepEqual(during > before, true, `Mid-transition ${during} should be > sleep ${before}`);
  assert.deepEqual(after > during, true, `Awake ${after} should be > mid-transition ${during}`);
});

test("MockHeart - deterministic with same seed", () => {
  const heart1 = new MockHeart({ restingHr: 68, seed: 42 });
  const heart2 = new MockHeart({ restingHr: 68, seed: 42 });

  // Same seed = same activity plan and the same BPM at every point of the day
  assert.deepEqual(heart1.getActivityPlan(), heart2.getActivityPlan());
  for (let m = 0; m < 24 * 60; m += 5) {
    const date = dateAt(Math.floor(m / 60), m % 60);
    assert.equal(heart1.bpmAt(date), heart2.bpmAt(date), `BPM differs at minute ${m}`);
  }

  // ...and replanning stays in lockstep
  heart1.replanDay();
  heart2.replanDay();
  assert.deepEqual(heart1.getActivityPlan(), heart2.getActivityPlan());
});

test("MockHeart - activity plan has reasonable count", () => {
  const heart = new MockHeart({ restingHr: 68 });
  const plan = heart.getActivityPlan();

  assert.deepEqual(plan.length >= 1, true, "Should have at least 1 activity");
  assert.deepEqual(plan.length <= 6, true, "Should have at most 6 activities");
});

test("MockHeart - activity plan is sorted by start time", () => {
  const heart = new MockHeart({ restingHr: 68 });
  const plan = heart.getActivityPlan();

  for (let i = 1; i < plan.length; i++) {
    assert.deepEqual(
      plan[i].startMinute > plan[i - 1].startMinute,
      true,
      "Activities should be sorted by start time",
    );
  }
});

test("MockHeart - activities don't overlap", () => {
  const heart = new MockHeart({ restingHr: 68 });
  const plan = heart.getActivityPlan();

  for (let i = 1; i < plan.length; i++) {
    const prevEnd = plan[i - 1].startMinute + plan[i - 1].durationMin + plan[i - 1].rampMin;
    assert.deepEqual(
      plan[i].startMinute > prevEnd,
      true,
      `Activity at ${plan[i].startMinute} overlaps previous ending at ${prevEnd}`,
    );
  }
});

test("MockHeart - replanDay generates new activities", () => {
  const heart = new MockHeart({ restingHr: 68 });
  heart.replanDay();
  const plan2 = heart.getActivityPlan();

  // Plans may occasionally be identical but it's astronomically unlikely
  // Just verify both are valid
  assert.deepEqual(plan2.length >= 1, true);
  assert.deepEqual(plan2.length <= 6, true);
});

test("MockHeart - wind-down period transitions to sleep HR", () => {
  const heart = new MockHeart({ restingHr: 68, seed: 42 });

  const beforeWindDown = heart.bpmAt(dateAt(22, 0)); // still daytime
  const duringWindDown = heart.bpmAt(dateAt(22, 45)); // mid wind-down
  const sleep = heart.bpmAt(dateAt(23, 30)); // sleeping

  assert.deepEqual(
    beforeWindDown > duringWindDown,
    true,
    `Before wind-down ${beforeWindDown} should be > during ${duringWindDown}`,
  );
  assert.deepEqual(
    duringWindDown > sleep,
    true,
    `During wind-down ${duringWindDown} should be > sleep ${sleep}`,
  );
});
