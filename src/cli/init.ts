import { loadConfig, saveConfig, generateApiKey, type CoraConfig } from "../config/mod.ts";

function prompt(message: string, defaultValue?: string): string {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const input = globalThis.prompt(`${message}${suffix}:`);
  return input?.trim() || defaultValue || "";
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

  console.log("\n✓ Config saved to ~/.config/cora/config.json");
  console.log("\n— iOS Shortcut Setup —");
  console.log(`  Endpoint: http://<your-ip>:${port}/beat`);
  console.log(`  API Key:  ${apiKey}`);
  console.log(`  Header:   Authorization: Bearer ${apiKey}`);
  console.log(`\n  POST body: {"timestamp": "...", "bpm": 72, "rr_intervals": [830]}`);
}
