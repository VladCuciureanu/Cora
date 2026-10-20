import { loadConfig, saveConfig, generateApiKey, type CoraConfig } from "../config/mod.ts";
import { networkInterfaces } from "node:os";
import { createInterface, type Interface } from "node:readline";
import QRCode from "qrcode";

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

export async function initCommand(): Promise<void> {
  const existing = await loadConfig();
  if (existing) {
    const overwrite = await prompt("Config already exists. Overwrite? (y/N)", "N");
    if (overwrite.toLowerCase() !== "y") {
      closePrompt();
      console.log("Aborted.");
      return;
    }
  }

  console.log("♥ Cora setup\n");

  const githubPat = await prompt("GitHub Personal Access Token (repo scope)");
  if (!githubPat) {
    console.error("PAT is required.");
    process.exit(1);
  }

  const repoUrl = await prompt("Private repo URL (e.g. https://github.com/user/cora-heartbeat)");
  if (!repoUrl) {
    console.error("Repo URL is required.");
    process.exit(1);
  }

  const portStr = await prompt("HTTP server port", "7331");
  closePrompt();
  const port = parseInt(portStr, 10) || 7331;

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

  console.log("\n✓ Config saved to ~/.config/cora/config.json");
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
