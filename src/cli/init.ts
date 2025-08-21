import { loadConfig, saveConfig, generateApiKey, type CoraConfig } from "../config/mod.ts";
import { generateQrCode, renderToUnicode } from "@openjs/denoqr";

function prompt(message: string, defaultValue?: string): string {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const input = globalThis.prompt(`${message}${suffix}:`);
  return input?.trim() || defaultValue || "";
}

function getLocalIp(): string | null {
  try {
    const ifaces = Deno.networkInterfaces();
    for (const iface of ifaces) {
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
    const overwrite = prompt("Config already exists. Overwrite? (y/N)", "N");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  console.log("♥ Cora setup\n");

  const githubPat = prompt("GitHub Personal Access Token (repo scope)");
  if (!githubPat) {
    console.error("PAT is required.");
    Deno.exit(1);
  }

  const repoUrl = prompt("Private repo URL (e.g. https://github.com/user/cora-heartbeat)");
  if (!repoUrl) {
    console.error("Repo URL is required.");
    Deno.exit(1);
  }

  const portStr = prompt("HTTP server port", "7331");
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
  const modules = generateQrCode(qrPayload, { ecc: "L" });
  const qrString = renderToUnicode(modules);

  console.log("\n— Scan with your phone to copy setup info —\n");
  console.log(qrString);
}
