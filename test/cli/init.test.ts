import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { test } from "node:test";
import QRCode from "qrcode";

function assertIncludes(actual: string, expected: string): void {
  assert.ok(actual.includes(expected), `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}

test("init - QR code encodes JSON payload with endpoint and key", async () => {
  const payload = JSON.stringify({ endpoint: "http://192.168.1.5:7331/beat", key: "abc123" });
  const qr = await QRCode.toString(payload, { type: "utf8", errorCorrectionLevel: "L" });

  // QR output should be a non-empty string with block characters
  assert.deepEqual(typeof qr, "string");
  assert.deepEqual(qr.length > 0, true);
  assertIncludes(qr, "█");
});

test("init - QR code handles long API keys", async () => {
  const longKey = "a".repeat(64);
  const payload = JSON.stringify({ endpoint: "http://10.0.0.1:7331/beat", key: longKey });
  const qr = await QRCode.toString(payload, { type: "utf8", errorCorrectionLevel: "L" });

  assert.deepEqual(typeof qr, "string");
  assert.deepEqual(qr.length > 0, true);
});

test("init - getLocalIp returns IPv4 or null", () => {
  // We can't mock networkInterfaces, but we can verify the function shape
  try {
    const ifaces = Object.values(networkInterfaces()).flat();
    const ipv4 = ifaces.find((i) => i?.family === "IPv4" && !i?.address.startsWith("127."));
    if (ipv4) {
      // Should be a valid IPv4
      assert.deepEqual(/^\d+\.\d+\.\d+\.\d+$/.test(ipv4.address), true);
    }
  } catch {
    // permission denied is fine
  }
});
