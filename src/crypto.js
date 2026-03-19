import { createCipheriv, createHmac } from "node:crypto";

const SIG_METHOD_TO_ALGORITHM = {
  "HMAC-SHA1": "sha1",
  "HMAC-SHA256": "sha256",
};

export function normalizePlatformBase64(value) {
  return value.replace(/=/g, "").replace(/\+/g, "*").replace(/\//g, "-");
}

export function buildSignature({
  appKey,
  appUuid,
  reqUuid,
  sigMethod,
  timestamp,
  appSecret,
}) {
  const algorithm = SIG_METHOD_TO_ALGORITHM[sigMethod];
  if (!algorithm) {
    throw new Error(`Unsupported signature method: ${sigMethod}`);
  }

  const rawString =
    `app_key=${appKey}` +
    `&app_uuid=${appUuid}` +
    `&req_uuid=${reqUuid}` +
    `&sig_method=${sigMethod}` +
    `&timestamp=${timestamp}`;

  const digest = createHmac(algorithm, appSecret).update(rawString).digest("base64");
  return normalizePlatformBase64(digest);
}

export function encryptBusinessPayload(payload, dataKey) {
  const keyBuffer = Buffer.from(dataKey, "utf8");
  if (![16, 24, 32].includes(keyBuffer.length)) {
    throw new Error("dataKey must be 16, 24, or 32 bytes for AES-ECB");
  }

  const cipher = createCipheriv(`aes-${keyBuffer.length * 8}-ecb`, keyBuffer, null);
  cipher.setAutoPadding(true);

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]).toString("base64");

  return normalizePlatformBase64(encrypted);
}
