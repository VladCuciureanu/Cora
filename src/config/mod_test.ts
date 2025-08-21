import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { generateApiKey } from "./mod.ts";

Deno.test("generateApiKey - returns 64-char hex string", () => {
  const key = generateApiKey();
  assertEquals(key.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(key), true);
});

Deno.test("generateApiKey - generates unique keys", () => {
  const key1 = generateApiKey();
  const key2 = generateApiKey();
  assertNotEquals(key1, key2);
});
