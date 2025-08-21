/**
 * Realistic mock heart rate simulator.
 *
 * Models a 24-hour circadian rhythm with:
 * - Sleep phase (23:00–06:30): resting HR 48–58 bpm, slow sinusoidal drift
 * - Wake transition (06:30–07:30): gradual ramp from sleep to resting
 * - Daytime resting (07:30–22:30): baseline 62–75 bpm with occasional activity
 * - Wind-down (22:30–23:00): gradual descent toward sleep HR
 *
 * Activity bursts (exercise, stress, stairs) are randomly scheduled
 * during waking hours with realistic ramp-up, plateau, and recovery curves.
 *
 * All times are computed in the system's local timezone.
 */

interface ActivityBurst {
  startMinute: number; // minute-of-day when burst begins
  durationMin: number; // how long the burst lasts
  peakBpm: number;     // peak HR during burst
  rampMin: number;     // minutes to reach peak
}

export class MockHeart {
  private baseRestingHr: number;
  private activities: ActivityBurst[];
  private noiseState = 0;
  private timezone: string;

  constructor(opts?: { restingHr?: number; timezone?: string; seed?: number }) {
    this.baseRestingHr = opts?.restingHr ?? 68;
    this.timezone = opts?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (opts?.seed !== undefined) this.noiseState = opts.seed;
    this.activities = this.planDayActivities();
  }

  /** Get the simulated BPM for a given timestamp. */
  bpmAt(date: Date): number {
    const minuteOfDay = this.getLocalMinuteOfDay(date);
    const baseHr = this.circadianBase(minuteOfDay);
    const activityBoost = this.activityContribution(minuteOfDay);
    const noise = this.hrNoise(date.getTime());

    return Math.round(Math.max(40, Math.min(200, baseHr + activityBoost + noise)));
  }

  /** Circadian baseline HR based on time of day. */
  private circadianBase(minuteOfDay: number): number {
    const sleepHr = this.baseRestingHr - 15;  // ~53 for default 68
    const dayHr = this.baseRestingHr;

    // Sleep: 23:00 (1380) to 06:30 (390)
    if (minuteOfDay >= 1380 || minuteOfDay < 390) {
      // Deep sleep sinusoidal variation (±4 bpm over ~90 min sleep cycles)
      const sleepPhase = minuteOfDay >= 1380
        ? (minuteOfDay - 1380)
        : (minuteOfDay + 60); // normalize to continuous
      const cyclePos = (sleepPhase % 90) / 90;
      const cycleMod = Math.sin(cyclePos * Math.PI * 2) * 4;
      return sleepHr + cycleMod;
    }

    // Wake transition: 06:30 (390) to 07:30 (450)
    if (minuteOfDay < 450) {
      const t = (minuteOfDay - 390) / 60; // 0..1
      const eased = t * t * (3 - 2 * t); // smoothstep
      return sleepHr + (dayHr - sleepHr) * eased;
    }

    // Wind-down: 22:30 (1350) to 23:00 (1380)
    if (minuteOfDay >= 1350) {
      const t = (minuteOfDay - 1350) / 30; // 0..1
      const eased = t * t * (3 - 2 * t);
      return dayHr + (sleepHr - dayHr) * eased;
    }

    // Daytime: gentle drift ±3 bpm over the day (ultradian rhythm)
    const dayProgress = (minuteOfDay - 450) / (1350 - 450); // 0..1
    const ultradianWave = Math.sin(dayProgress * Math.PI * 4) * 3;
    // Slight post-lunch dip around 13:00–14:00 (780–840)
    const lunchDip = minuteOfDay >= 780 && minuteOfDay <= 840
      ? -3 * Math.sin(((minuteOfDay - 780) / 60) * Math.PI)
      : 0;
    return dayHr + ultradianWave + lunchDip;
  }

  /** Contribution from scheduled activity bursts. */
  private activityContribution(minuteOfDay: number): number {
    let total = 0;
    for (const act of this.activities) {
      const elapsed = minuteOfDay - act.startMinute;
      if (elapsed < 0 || elapsed > act.durationMin + act.rampMin) continue;

      const boost = act.peakBpm - this.baseRestingHr;

      if (elapsed < act.rampMin) {
        // Ramp up (exponential ease-in)
        const t = elapsed / act.rampMin;
        total += boost * (1 - Math.exp(-3 * t));
      } else if (elapsed < act.durationMin) {
        // Plateau with slight variation
        const plateauNoise = Math.sin(elapsed * 0.5) * 3;
        total += boost + plateauNoise;
      } else {
        // Recovery (exponential decay, ~2 min to half)
        const recoveryElapsed = elapsed - act.durationMin;
        total += boost * Math.exp(-recoveryElapsed / 2);
      }
    }
    return total;
  }

  /** Semi-random HR noise (±2 bpm), deterministic from timestamp. */
  private hrNoise(ms: number): number {
    // Simple hash-based noise for reproducibility
    const x = Math.sin(ms * 0.001 + this.noiseState) * 10000;
    return (x - Math.floor(x)) * 4 - 2; // range: -2 to +2
  }

  /** Plan 3–6 random activity bursts for a day. */
  private planDayActivities(): ActivityBurst[] {
    const activities: ActivityBurst[] = [];
    const count = 3 + Math.floor(Math.random() * 4); // 3–6 bursts

    for (let i = 0; i < count; i++) {
      const kind = Math.random();
      if (kind < 0.3) {
        // Light activity: walking, stairs (HR 85–100, 2–5 min)
        activities.push({
          startMinute: 480 + Math.floor(Math.random() * 780), // 08:00–21:00
          durationMin: 2 + Math.floor(Math.random() * 4),
          peakBpm: 85 + Math.floor(Math.random() * 16),
          rampMin: 1,
        });
      } else if (kind < 0.7) {
        // Moderate activity: brisk walk, cycling (HR 110–140, 10–30 min)
        activities.push({
          startMinute: 480 + Math.floor(Math.random() * 720), // 08:00–20:00
          durationMin: 10 + Math.floor(Math.random() * 21),
          peakBpm: 110 + Math.floor(Math.random() * 31),
          rampMin: 3,
        });
      } else {
        // Intense: running, HIIT (HR 150–185, 15–45 min)
        activities.push({
          startMinute: 360 + Math.floor(Math.random() * 720), // 06:00–18:00
          durationMin: 15 + Math.floor(Math.random() * 31),
          peakBpm: 150 + Math.floor(Math.random() * 36),
          rampMin: 5,
        });
      }
    }

    // Sort by start time
    activities.sort((a, b) => a.startMinute - b.startMinute);

    // Remove overlaps
    const filtered: ActivityBurst[] = [];
    for (const act of activities) {
      const last = filtered[filtered.length - 1];
      if (!last || act.startMinute > last.startMinute + last.durationMin + last.rampMin + 10) {
        filtered.push(act);
      }
    }

    return filtered;
  }

  /** Get minute-of-day in local timezone. */
  private getLocalMinuteOfDay(date: Date): number {
    const local = new Date(date.toLocaleString("en-US", { timeZone: this.timezone }));
    return local.getHours() * 60 + local.getMinutes();
  }

  /** Replan activities (call at midnight or for a new day). */
  replanDay(): void {
    this.activities = this.planDayActivities();
  }

  /** Get the current activity plan (for debugging). */
  getActivityPlan(): ActivityBurst[] {
    return [...this.activities];
  }
}
