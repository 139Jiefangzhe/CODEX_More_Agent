const DEFAULT_BASE_URL = "https://datahub.renniting.cn/apis/v1";
const DEFAULT_SIG_METHOD = "HMAC-SHA1";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_COUNT = 1;

const REQUIRED_STATIC_STRING_FIELDS = [
  "fullname",
  "abbrname",
  "recordno",
  "address",
  "contact",
  "phone",
  "isname",
  "issn",
  "muname",
  "musn",
  "ationname",
];

const REQUIRED_STATIC_INTEGER_FIELDS = [
  "type",
  "street",
  "space",
  "dsspace",
  "bizspace",
  "nespace",
  "fastpile",
  "slowpile",
  "numexit",
  "numentry",
  "exspace",
  "smartlevel",
];

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

function assertNumber(value, name, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "number" || Number.isNaN(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a number between ${min} and ${max}`);
  }
}

function normalizeBaseUrl(baseUrl) {
  const parsed = new URL(baseUrl || DEFAULT_BASE_URL);
  if (parsed.protocol !== "https:") {
    throw new Error("Westcity baseUrl must use HTTPS");
  }

  return parsed.toString().replace(/\/$/, "");
}

function parseTimeoutMs(config) {
  const timeoutMs = config.timeoutMs;
  const timeoutSeconds = config.timeoutSeconds;

  if (timeoutMs !== undefined && timeoutSeconds !== undefined && timeoutMs !== timeoutSeconds * 1000) {
    throw new Error("config.timeoutMs and config.timeoutSeconds conflict");
  }

  if (timeoutMs !== undefined) {
    return timeoutMs;
  }

  if (timeoutSeconds !== undefined) {
    return timeoutSeconds * 1000;
  }

  return DEFAULT_TIMEOUT_MS;
}

export function validateClientConfig(config) {
  assertPlainObject(config, "config");

  const baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
  const appKey = String(config.appKey || "").trim();
  const appSecret = String(config.appSecret || "").trim();
  const dataKey = String(config.dataKey || "").trim();
  const appUuid = String(config.appUuid || "").trim();
  const sigMethod = config.sigMethod || DEFAULT_SIG_METHOD;
  const timeoutMs = parseTimeoutMs(config);
  const retryCount = config.retryCount ?? DEFAULT_RETRY_COUNT;
  const maxFreeBerth = config.maxFreeBerth;

  assertNonEmptyString(appKey, "config.appKey");
  assertNonEmptyString(appSecret, "config.appSecret");
  assertNonEmptyString(dataKey, "config.dataKey");
  assertNonEmptyString(appUuid, "config.appUuid");
  assertNonEmptyString(sigMethod, "config.sigMethod");
  assertInteger(timeoutMs, "config.timeoutMs", { min: 1, max: 60000 });
  assertInteger(retryCount, "config.retryCount", { min: 0, max: 5 });

  if (config.parkingId && String(config.parkingId).trim() !== appKey) {
    throw new Error("parkingId must equal appKey according to the Westcity API");
  }

  if (maxFreeBerth !== undefined) {
    assertInteger(maxFreeBerth, "config.maxFreeBerth", { min: 0, max: 1000000 });
  }

  return {
    baseUrl,
    appKey,
    appSecret,
    dataKey,
    appUuid,
    sigMethod,
    timeoutMs,
    retryCount,
    parkingId: appKey,
    maxFreeBerth,
  };
}

export function validateStaticParkingData(rawData, { appKey } = {}) {
  assertPlainObject(rawData, "static parking data");

  const data = { ...rawData };
  if (data.id === undefined) {
    data.id = appKey;
  }

  if (appKey) {
    assertNonEmptyString(data.id, "staticParkingData.id");
    if (data.id !== appKey) {
      throw new Error("staticParkingData.id must equal appKey");
    }
  }

  for (const field of REQUIRED_STATIC_STRING_FIELDS) {
    assertNonEmptyString(data[field], `staticParkingData.${field}`);
  }

  for (const field of REQUIRED_STATIC_INTEGER_FIELDS) {
    assertInteger(data[field], `staticParkingData.${field}`, { min: 0, max: 1000000000 });
  }

  assertInteger(data.updatetime, "staticParkingData.updatetime", {
    min: 1,
    max: 4102444800,
  });
  assertNumber(data.lat, "staticParkingData.lat", { min: -90, max: 90 });
  assertNumber(data.lng, "staticParkingData.lng", { min: -180, max: 180 });

  return data;
}

export function validateOperationData(rawData, { maxFreeBerth } = {}) {
  assertPlainObject(rawData, "operation data");

  const data = { ...rawData };
  const max = maxFreeBerth ?? 1000000;

  assertInteger(data.dotime, "operationData.dotime", { min: 1, max: 4102444800 });
  assertInteger(data.freeberth, "operationData.freeberth", { min: 0, max });
  assertInteger(data.in, "operationData.in", { min: 0, max: 1000000000 });
  assertInteger(data.out, "operationData.out", { min: 0, max: 1000000000 });

  return data;
}

export function loadConfigFromEnv(env = process.env) {
  return validateClientConfig({
    baseUrl: env.WESTCITY_BASE_URL,
    appKey: env.WESTCITY_APP_KEY,
    appSecret: env.WESTCITY_APP_SECRET,
    dataKey: env.WESTCITY_DATA_KEY,
    appUuid: env.WESTCITY_APP_UUID,
    sigMethod: env.WESTCITY_SIG_METHOD,
    timeoutMs: env.WESTCITY_TIMEOUT_MS ? Number(env.WESTCITY_TIMEOUT_MS) : undefined,
    timeoutSeconds: env.WESTCITY_TIMEOUT_SECONDS ? Number(env.WESTCITY_TIMEOUT_SECONDS) : undefined,
    retryCount: env.WESTCITY_RETRY_COUNT ? Number(env.WESTCITY_RETRY_COUNT) : undefined,
    maxFreeBerth: env.WESTCITY_MAX_FREE_BERTH ? Number(env.WESTCITY_MAX_FREE_BERTH) : undefined,
  });
}
