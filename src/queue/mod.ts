import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";
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
    await ensureDir(dirname(this.path));
    await Deno.writeTextFile(this.path, JSON.stringify(entry) + "\n", { append: true });
  }

  async drain(): Promise<QueueEntry[]> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.path);
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
    await Deno.writeTextFile(this.path, "");
    return entries;
  }

  async size(): Promise<number> {
    try {
      const text = await Deno.readTextFile(this.path);
      return text.split("\n").filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }
}
