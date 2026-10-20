import type { BaselineData, EventData } from "../git/mod.ts";

export interface BeatSample {
  timestamp: string;
  bpm: number;
  rrIntervals: number[];
}

export type BeatListener = {
  onBaseline: (data: BaselineData) => void | Promise<void>;
  onEvent: (data: EventData) => void | Promise<void>;
};

/** How many recent BPM readings the rolling average covers. */
const ROLLING_WINDOW = 30;
/** Readings needed in the rolling window before spikes/drops are detected. */
const MIN_ROLLING_SAMPLES = 5;

/**
 * Classify `bpm` against the rolling average of `rollingBpms`: a "spike" or
 * "drop" when it deviates by at least `thresholdPercent`, otherwise null.
 */
export function detectDeviation(
  rollingBpms: readonly number[],
  bpm: number,
  thresholdPercent: number,
): "spike" | "drop" | null {
  if (rollingBpms.length < MIN_ROLLING_SAMPLES) return null;
  const avg = rollingBpms.reduce((a, b) => a + b, 0) / rollingBpms.length;
  const deviation = Math.abs(bpm - avg) / avg * 100;
  if (deviation >= thresholdPercent) return bpm > avg ? "spike" : "drop";
  return null;
}

/** Append `bpm` to the rolling window, dropping the oldest reading when full. */
export function pushRolling(rollingBpms: number[], bpm: number): void {
  rollingBpms.push(bpm);
  if (rollingBpms.length > ROLLING_WINDOW) rollingBpms.shift();
}

/** Aggregate a window of samples into a baseline stamped with the last sample's time. */
export function summarizeWindow(samples: readonly { timestamp: string; bpm: number }[]): BaselineData | null {
  if (samples.length === 0) return null;
  const bpms = samples.map((s) => s.bpm);
  return {
    timestamp: samples[samples.length - 1].timestamp,
    avgBpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
    minBpm: Math.min(...bpms),
    maxBpm: Math.max(...bpms),
    beatCount: samples.length,
  };
}

export class BeatBuffer {
  private samples: BeatSample[] = [];
  private rollingBpms: number[] = [];
  private listener: BeatListener | null = null;
  private windowMs: number;
  private thresholdPercent: number;
  private lastSampleTime = 0;
  private gapThresholdMs = 60_000;

  constructor(windowMs: number, thresholdPercent: number) {
    this.windowMs = windowMs;
    this.thresholdPercent = thresholdPercent;
  }

  setListener(listener: BeatListener): void {
    this.listener = listener;
  }

  async addSample(sample: BeatSample): Promise<void> {
    const now = Date.parse(sample.timestamp);

    // Detect reconnect after gap
    if (this.lastSampleTime > 0 && now - this.lastSampleTime > this.gapThresholdMs) {
      await this.listener?.onEvent({
        timestamp: sample.timestamp,
        bpm: sample.bpm,
        kind: "reconnect",
      });
    }
    this.lastSampleTime = now;

    // Detect spike/drop against rolling average
    const kind = detectDeviation(this.rollingBpms, sample.bpm, this.thresholdPercent);
    if (kind) {
      await this.listener?.onEvent({ timestamp: sample.timestamp, bpm: sample.bpm, kind });
    }

    pushRolling(this.rollingBpms, sample.bpm);

    this.samples.push(sample);
  }

  async flushWindow(): Promise<void> {
    const baseline = summarizeWindow(this.samples);
    if (!baseline) return;

    this.samples = [];
    await this.listener?.onBaseline(baseline);
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  get currentBpm(): number | null {
    if (this.rollingBpms.length === 0) return null;
    return this.rollingBpms[this.rollingBpms.length - 1];
  }
}
