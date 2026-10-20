import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { queuePath } from "../config/mod.ts";
import type { CommitEntry } from "../git/mod.ts";

export class OfflineQueue {
  private path: string;

  constructor(path?: string) {
    this.path = path ?? queuePath();
  }

  async enqueue(entry: CommitEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + "\n");
  }

  async drain(): Promise<CommitEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }

    const entries: CommitEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    // Clear the queue file
    await writeFile(this.path, "");
    return entries;
  }

  /**
   * Drain the queue, passing each entry to `handler` in order. Entries whose
   * handler throws are put back at the front of the queue (in their original
   * order, ahead of anything enqueued meanwhile) so they are retried later.
   */
  async process(
    handler: (entry: CommitEntry) => Promise<void>,
  ): Promise<{ processed: number; failed: { entry: CommitEntry; error: unknown }[] }> {
    const entries = await this.drain();
    const failed: { entry: CommitEntry; error: unknown }[] = [];
    let processed = 0;
    for (const entry of entries) {
      try {
        await handler(entry);
        processed++;
      } catch (error) {
        failed.push({ entry, error });
      }
    }
    if (failed.length > 0) await this.requeueFront(failed.map((f) => f.entry));
    return { processed, failed };
  }

  private async requeueFront(entries: CommitEntry[]): Promise<void> {
    let rest = "";
    try {
      rest = await readFile(this.path, "utf8");
    } catch {
      // queue file missing — nothing enqueued meanwhile
    }
    const head = entries.map((e) => JSON.stringify(e) + "\n").join("");
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, head + rest);
  }

  async size(): Promise<number> {
    try {
      const text = await readFile(this.path, "utf8");
      return text.split("\n").filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }
}
