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
    if (this.rollingBpms.length >= 5) {
      const avg = this.rollingBpms.reduce((a, b) => a + b, 0) / this.rollingBpms.length;
      const deviation = Math.abs(sample.bpm - avg) / avg * 100;
      if (deviation >= this.thresholdPercent) {
        await this.listener?.onEvent({
          timestamp: sample.timestamp,
          bpm: sample.bpm,
          kind: sample.bpm > avg ? "spike" : "drop",
        });
      }
    }

    // Update rolling average (keep last 30 samples)
    this.rollingBpms.push(sample.bpm);
    if (this.rollingBpms.length > 30) this.rollingBpms.shift();

    this.samples.push(sample);
  }

  async flushWindow(): Promise<void> {
    if (this.samples.length === 0) return;

    const bpms = this.samples.map((s) => s.bpm);
    const baseline: BaselineData = {
      timestamp: new Date().toISOString(),
      avgBpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
      minBpm: Math.min(...bpms),
      maxBpm: Math.max(...bpms),
      beatCount: this.samples.length,
    };

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
