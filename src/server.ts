import { createServer, type IncomingMessage, type Server } from "node:http";
import type { BeatBuffer, BeatSample } from "./beats.ts";

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

/** Accepted heart-rate range, in beats per minute. */
const MIN_BPM = 20;
const MAX_BPM = 300;

/** Why `body` is not a valid beat payload, or null if it is one. */
function payloadError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "Body must be a JSON object";
  const { timestamp, bpm } = body as Record<string, unknown>;
  if (!timestamp || bpm === undefined) return "Missing timestamp or bpm";
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    return "timestamp must be an ISO 8601 date-time";
  }
  if (typeof bpm !== "number" || !(bpm >= MIN_BPM && bpm <= MAX_BPM)) {
    return `bpm must be a number from ${MIN_BPM} to ${MAX_BPM}`;
  }
  return null;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
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
        if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ error: "Internal Server Error" }));
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
    const route = `${req.method} ${new URL(req.url).pathname}`;
    if (route === "GET /health") return Response.json({ status: "alive" });
    if (route !== "GET /status" && route !== "POST /beat") return jsonError(404, "Not found");

    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${this.apiKey}`) {
      return jsonError(401, "Unauthorized");
    }

    if (route === "GET /status") {
      return Response.json({ status: "alive", bpm: this.buffer.currentBpm });
    }

    let body: BeatPayload;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "Invalid JSON");
    }

    const error = payloadError(body);
    if (error) return jsonError(400, error);

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
