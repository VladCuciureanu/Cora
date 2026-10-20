import { networkInterfaces } from "node:os";
import { createInterface, type Interface } from "node:readline";
import QRCode from "qrcode";
import {
  type CoraConfig,
  configPath,
  generateApiKey,
  isValidPort,
  loadConfig,
  saveConfig,
} from "../config.ts";

// One shared line reader so piped stdin (several answers arriving at once) isn't dropped between prompts.
let rl: Interface | null = null;
let lines: AsyncIterator<string> | null = null;

async function prompt(message: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  process.stdout.write(`${message}${suffix}: `);
  rl ??= createInterface({ input: process.stdin });
  lines ??= rl[Symbol.asyncIterator]();
  const { value, done } = await lines.next();
  const input: string | null = done ? null : value;
  return input?.trim() || defaultValue || "";
}

function closePrompt(): void {
  rl?.close();
  rl = null;
  lines = null;
}

function getLocalIp(): string | null {
  try {
    const ifaces = Object.values(networkInterfaces()).flat();
    for (const iface of ifaces) {
      if (!iface) continue;
      if (iface.family === "IPv4" && !iface.address.startsWith("127.")) {
        return iface.address;
      }
    }
  } catch {
    // permission denied or unavailable
  }
  return null;
}

/** Ask for the server port until the answer is a valid one; a blank answer means 7331. */
async function askPort(): Promise<number> {
  for (;;) {
    const answer = await prompt("HTTP server port", "7331");
    const port = /^\d+$/.test(answer) ? Number(answer) : Number.NaN;
    if (isValidPort(port)) return port;
    console.error(`cora: invalid port "${answer}": must be an integer from 1 to 65535`);
  }
}

/** Ask for the setup answers; null when the user declines to overwrite an existing config. */
async function askSetup(): Promise<{ githubPat: string; repoUrl: string; port: number } | null> {
  // An invalid config exists too, and overwriting it is the fix
  const exists = await loadConfig().then(
    (config) => config !== null,
    () => true,
  );
  if (exists) {
    const overwrite = await prompt("Config already exists. Overwrite? (y/N)", "N");
    if (overwrite.toLowerCase() !== "y") return null;
  }

  console.log("♥ Cora setup\n");

  const githubPat = await prompt("GitHub Personal Access Token (repo scope)");
  if (!githubPat) throw new Error("PAT is required.");

  const repoUrl = await prompt("Private repo URL (e.g. https://github.com/user/cora-heartbeat)");
  if (!repoUrl) throw new Error("Repo URL is required.");

  return { githubPat, repoUrl, port: await askPort() };
}

export async function initCommand(): Promise<void> {
  let answers: Awaited<ReturnType<typeof askSetup>>;
  try {
    answers = await askSetup();
  } finally {
    closePrompt();
  }
  if (!answers) {
    console.log("Aborted.");
    return;
  }
  const { githubPat, repoUrl, port } = answers;

  const apiKey = generateApiKey();

  const config: CoraConfig = {
    githubPat,
    repoUrl,
    apiKey,
    commitIntervalMs: 5 * 60 * 1000,
    eventThresholdPercent: 20,
    port,
  };

  await saveConfig(config);

  const localIp = getLocalIp();
  const host = localIp ?? "<your-ip>";
  const endpoint = `http://${host}:${port}/beat`;

  console.log(`\n✓ Config saved to ${configPath()}`);
  console.log("\n— iOS Shortcut Setup —");
  console.log(`  Endpoint: ${endpoint}`);
  console.log(`  API Key:  ${apiKey}`);
  console.log(`  Header:   Authorization: Bearer ${apiKey}`);
  console.log(`\n  POST body: {"timestamp": "...", "bpm": 72, "rr_intervals": [830]}`);

  // QR code containing setup payload for easy phone scanning
  const qrPayload = JSON.stringify({ endpoint, key: apiKey });
  const qrString = await QRCode.toString(qrPayload, { type: "utf8", errorCorrectionLevel: "L" });

  console.log("\n— Scan with your phone to copy setup info —\n");
  console.log(qrString);
}
