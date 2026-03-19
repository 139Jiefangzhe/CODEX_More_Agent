import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSignature,
  encryptBusinessPayload,
  normalizePlatformBase64,
} from "../src/crypto.js";

const TEST_CREDENTIALS = {
  appIdentifier: "parking-app-key",
  signingValue: "parking-app-secret",
  cipherSeed: "aes-test-key-001",
};

test("normalizePlatformBase64 removes padding and remaps symbols", () => {
  assert.equal(normalizePlatformBase64("ab+/="), "ab*-");
});

test("buildSignature follows the Westcity signing format", () => {
  const signature = buildSignature({
    appKey: TEST_CREDENTIALS.appIdentifier,
    appUuid: "tea-trade-device-01",
    reqUuid: "7ec04880-cd0b-402d-bd92-b4e582ddc09e",
    sigMethod: "HMAC-SHA1",
    timestamp: 1697942682,
    appSecret: TEST_CREDENTIALS.signingValue,
  });

  assert.equal(signature, "OEEw*7dK5A4tG0tOG4Wg-Y9jkrE");
});

test("encryptBusinessPayload returns Westcity-safe base64 text", () => {
  const encrypted = encryptBusinessPayload(
    {
      dotime: 1697942682,
      freeberth: 100,
      in: 50,
      out: 40,
    },
    TEST_CREDENTIALS.cipherSeed,
  );

  assert.equal(
    encrypted,
    "bvpLR3TermecQEvvvrmMHaCsUm9WefZoWKi1mWIA86AmC8a4et9*IUbKhT*FanykBKswJjOC8eGjXObG1wCPXA",
  );
});
