import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { queuePath } from "../config/mod.ts";
import type { BaselineData, EventData } from "../git/mod.ts";

type QueueEntry =
  | { type: "baseline"; data: BaselineData }
  | { type: "event"; data: EventData };

export class OfflineQueue {
  private path: string;

  constructor(path?: string) {
    this.path = path ?? queuePath();
  }

  async enqueue(entry: QueueEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + "\n");
  }

  async drain(): Promise<QueueEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }

    const entries: QueueEntry[] = [];
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

  async size(): Promise<number> {
    try {
      const text = await readFile(this.path, "utf8");
      return text.split("\n").filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }
}
