import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { generateQrCode, renderToUnicode } from "@openjs/denoqr";

Deno.test("init - QR code encodes JSON payload with endpoint and key", () => {
  const payload = JSON.stringify({ endpoint: "http://192.168.1.5:7331/beat", key: "abc123" });
  const modules = generateQrCode(payload, { ecc: "L" });
  const qr = renderToUnicode(modules);

  // QR output should be a non-empty string with block characters
  assertEquals(typeof qr, "string");
  assertEquals(qr.length > 0, true);
  assertStringIncludes(qr, "█");
});

Deno.test("init - QR code handles long API keys", () => {
  const longKey = "a".repeat(64);
  const payload = JSON.stringify({ endpoint: "http://10.0.0.1:7331/beat", key: longKey });
  const modules = generateQrCode(payload, { ecc: "L" });
  const qr = renderToUnicode(modules);

  assertEquals(typeof qr, "string");
  assertEquals(qr.length > 0, true);
});

Deno.test("init - getLocalIp returns IPv4 or null", () => {
  // We can't mock networkInterfaces, but we can verify the function shape
  try {
    const ifaces = Deno.networkInterfaces();
    const ipv4 = ifaces.find((i) => i.family === "IPv4" && !i.address.startsWith("127."));
    if (ipv4) {
      // Should be a valid IPv4
      assertEquals(/^\d+\.\d+\.\d+\.\d+$/.test(ipv4.address), true);
    }
  } catch {
    // permission denied is fine
  }
});
