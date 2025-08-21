import type { BeatBuffer, BeatSample } from "../beats/mod.ts";

interface BeatPayload {
  timestamp: string;
  bpm: number;
  rr_intervals?: number[];
}

export class IngestionServer {
  private buffer: BeatBuffer;
  private apiKey: string;
  private port: number;
  private seenTimestamps = new Set<string>();
  private controller: AbortController | null = null;

  constructor(buffer: BeatBuffer, apiKey: string, port: number) {
    this.buffer = buffer;
    this.apiKey = apiKey;
    this.port = port;
  }

  start(): void {
    this.controller = new AbortController();
    Deno.serve(
      { port: this.port, signal: this.controller.signal, onListen: ({ hostname, port }) => {
        console.log(`♥ Listening on http://${hostname}:${port}`);
      }},
      (req) => this.handle(req),
    );
  }

  stop(): void {
    this.controller?.abort();
  }

  private async handle(req: Request): Promise<Response> {
    if (req.method === "GET" && new URL(req.url).pathname === "/health") {
      return Response.json({ status: "alive", bpm: this.buffer.currentBpm });
    }

    if (req.method !== "POST" || new URL(req.url).pathname !== "/beat") {
      return new Response("Not found", { status: 404 });
    }

    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${this.apiKey}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: BeatPayload;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body.timestamp || typeof body.bpm !== "number") {
      return Response.json({ error: "Missing timestamp or bpm" }, { status: 400 });
    }

    // Deduplicate
    if (this.seenTimestamps.has(body.timestamp)) {
      return Response.json({ status: "duplicate" }, { status: 200 });
    }
    this.seenTimestamps.add(body.timestamp);

    // Prune dedup set (keep last 10k)
    if (this.seenTimestamps.size > 10_000) {
      const iter = this.seenTimestamps.values();
      for (let i = 0; i < 5_000; i++) {
        const v = iter.next().value;
        if (v) this.seenTimestamps.delete(v);
      }
    }

    const sample: BeatSample = {
      timestamp: body.timestamp,
      bpm: body.bpm,
      rrIntervals: body.rr_intervals ?? [],
    };

    await this.buffer.addSample(sample);
    return Response.json({ status: "ok" });
  }
}
