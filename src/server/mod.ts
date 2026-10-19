import { createServer, type IncomingMessage, type Server } from "node:http";
import type { BeatBuffer, BeatSample } from "../beats/mod.ts";

/** Adapt a node:http request to a Web-standard Request so the handler stays fetch-style. */
async function toWebRequest(req: IncomingMessage, hostname: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const method = req.method ?? "GET";
  return new Request(`http://${req.headers.host ?? hostname}${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

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
  private server: Server | null = null;

  constructor(buffer: BeatBuffer, apiKey: string, port: number) {
    this.buffer = buffer;
    this.apiKey = apiKey;
    this.port = port;
  }

  start(): void {
    const hostname = "0.0.0.0";
    this.server = createServer(async (incoming, outgoing) => {
      try {
        const res = await this.handle(await toWebRequest(incoming, hostname));
        outgoing.writeHead(res.status, Object.fromEntries(res.headers));
        outgoing.end(Buffer.from(await res.arrayBuffer()));
      } catch (e) {
        console.error(e);
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end("Internal Server Error");
      }
    });
    this.server.listen(this.port, hostname, () => {
      console.log(`♥ Listening on http://${hostname}:${this.port}`);
    });
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections();
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
