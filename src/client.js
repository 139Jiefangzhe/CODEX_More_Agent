import { randomUUID } from "node:crypto";

import { buildSignature, encryptBusinessPayload } from "./crypto.js";
import {
  loadConfigFromEnv,
  validateClientConfig,
  validateOperationData,
  validateStaticParkingData,
} from "./validators.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSignedUrl(pathname, config) {
  const timestamp = Math.floor(Date.now() / 1000);
  const reqUuid = randomUUID();
  const signature = buildSignature({
    appKey: config.appKey,
    appUuid: config.appUuid,
    reqUuid,
    sigMethod: config.sigMethod,
    timestamp,
    appSecret: config.appSecret,
  });

  const url = new URL(config.baseUrl + pathname);
  url.searchParams.set("app_key", config.appKey);
  url.searchParams.set("app_uuid", config.appUuid);
  url.searchParams.set("req_uuid", reqUuid);
  url.searchParams.set("sig_method", config.sigMethod);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("signature", signature);

  return url;
}

function sanitizeUrl(url) {
  const clone = new URL(url.toString());
  if (clone.searchParams.has("signature")) {
    clone.searchParams.set("signature", "***");
  }
  return clone.toString();
}

function buildRequestBody(payload, contentType, dataKey) {
  const data = encryptBusinessPayload(payload, dataKey);

  if (contentType === "application/json") {
    return JSON.stringify({ data });
  }

  if (contentType === "application/x-www-form-urlencoded") {
    return new URLSearchParams({ data }).toString();
  }

  throw new Error(`Unsupported content type: ${contentType}`);
}

async function executeRequest({ buildRequest, fetchImpl, timeoutMs, retryCount }) {
  let lastError;
  let lastUrl;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const { url, method, headers, body } = buildRequest();
    lastUrl = url;
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 500 && attempt < retryCount) {
        await sleep(200 * (attempt + 1));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount) {
        break;
      }
      await sleep(200 * (attempt + 1));
    }
  }

  if (lastError?.details === undefined && lastUrl) {
    lastError.details = {
      ...(lastError.details || {}),
      url: sanitizeUrl(lastUrl),
    };
  }
  throw lastError;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class WestcityRequestError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "WestcityRequestError";
    this.details = details;
  }
}

export class WestcityParkingClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetch implementation is required");
    }

    this.config = validateClientConfig(config);
    this.fetchImpl = fetchImpl;
  }

  async updateParkingStaticInfo(rawData) {
    const data = validateStaticParkingData(rawData, { appKey: this.config.appKey });
    return this.#request({
      method: "PUT",
      pathname: `/parkings/${this.config.parkingId}`,
      contentType: "application/json",
      payload: data,
    });
  }

  async reportOperations(rawData) {
    const data = validateOperationData(rawData, {
      maxFreeBerth: this.config.maxFreeBerth,
    });

    return this.#request({
      method: "POST",
      pathname: `/parkings/${this.config.parkingId}/operations`,
      contentType: "application/x-www-form-urlencoded",
      payload: data,
    });
  }

  async #request({ method, pathname, contentType, payload }) {
    const response = await executeRequest({
      buildRequest: () => {
        const url = buildSignedUrl(pathname, this.config);
        return {
          url,
          method,
          headers: {
            accept: "application/json",
            "content-type": contentType,
          },
          body: buildRequestBody(payload, contentType, this.config.dataKey),
        };
      },
      fetchImpl: this.fetchImpl,
      timeoutMs: this.config.timeoutMs,
      retryCount: this.config.retryCount,
    });

    const responseData = await parseResponse(response);

    if (!response.ok) {
      const failedUrl = response.url ? new URL(response.url) : buildSignedUrl(pathname, this.config);
      throw new WestcityRequestError(`Westcity API request failed with status ${response.status}`, {
        status: response.status,
        response: responseData,
        url: sanitizeUrl(failedUrl),
      });
    }

    return responseData;
  }
}

export function createClientFromEnv(env = process.env, options = {}) {
  return new WestcityParkingClient(loadConfigFromEnv(env), options);
}
