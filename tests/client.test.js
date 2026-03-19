import test from "node:test";
import assert from "node:assert/strict";

import { WestcityParkingClient, WestcityRequestError } from "../src/client.js";
import { loadConfigFromEnv } from "../src/validators.js";

const TEST_CREDENTIALS = {
  appIdentifier: "parking-app-key",
  signingValue: "parking-app-secret",
  cipherSeed: "1234567890abcdef",
};

const baseConfig = {
  baseUrl: "https://datahub.renniting.cn/apis/v1",
  appKey: TEST_CREDENTIALS.appIdentifier,
  appSecret: TEST_CREDENTIALS.signingValue,
  dataKey: TEST_CREDENTIALS.cipherSeed,
  appUuid: "tea-trade-device-01",
  sigMethod: "HMAC-SHA1",
  timeoutMs: 2000,
  retryCount: 0,
  maxFreeBerth: 300,
};

const staticData = {
  fullname: "茶贸停车场",
  type: 1,
  abbrname: "茶贸停车场",
  recordno: "XCP-2025-0001",
  lat: 39.91737,
  lng: 116.378828,
  street: 1,
  address: "北京市西城区茶贸街道 1 号",
  contact: "张三",
  phone: "13900000000",
  space: 300,
  dsspace: 2,
  bizspace: 260,
  nespace: 10,
  fastpile: 2,
  slowpile: 4,
  numexit: 1,
  numentry: 2,
  exspace: 20,
  smartlevel: 0,
  isname: "邦道停车",
  issn: "911000000000000001",
  muname: "茶贸停车管理有限公司",
  musn: "911000000000000002",
  ationname: "茶贸充电运营有限公司",
  updatetime: 1697956021,
};

function createJsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

test("updateParkingStaticInfo sends PUT with json body", async () => {
  const calls = [];
  const client = new WestcityParkingClient(baseConfig, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return createJsonResponse({ code: "0", msg: "ok" });
    },
  });

  const response = await client.updateParkingStaticInfo(staticData);
  assert.equal(response.code, "0");
  assert.equal(calls.length, 1);

  const [{ url, options }] = calls;
  assert.match(url, /^https:\/\/datahub\.renniting\.cn\/apis\/v1\/parkings\/parking-app-key\?/);
  assert.equal(options.method, "PUT");
  assert.equal(options.headers["content-type"], "application/json");

  const parsedBody = JSON.parse(options.body);
  assert.equal(typeof parsedBody.data, "string");
  assert.ok(!parsedBody.data.includes("="));
});

test("updateParkingStaticInfo rejects missing ationname after real platform validation", async () => {
  const client = new WestcityParkingClient(baseConfig, {
    fetchImpl: async () => createJsonResponse({ code: "0", msg: "ok" }),
  });

  const invalidStaticData = { ...staticData };
  delete invalidStaticData.ationname;

  await assert.rejects(
    () => client.updateParkingStaticInfo(invalidStaticData),
    /staticParkingData\.ationname/,
  );
});

test("reportOperations sends form body and validates max berth", async () => {
  const calls = [];
  const client = new WestcityParkingClient(baseConfig, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return createJsonResponse({ code: "0", msg: "ok" }, { status: 201 });
    },
  });

  const response = await client.reportOperations({
    dotime: 1697942682,
    freeberth: 100,
    in: 50,
    out: 40,
  });

  assert.equal(response.code, "0");
  assert.equal(calls.length, 1);
  const [{ url, options }] = calls;
  assert.match(
    url,
    /^https:\/\/datahub\.renniting\.cn\/apis\/v1\/parkings\/parking-app-key\/operations\?/,
  );
  assert.equal(options.method, "POST");
  assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded");
  assert.match(options.body, /^data=/);
});

test("client rejects parkingId mismatch at configuration time", () => {
  assert.throws(
    () =>
      new WestcityParkingClient({
        ...baseConfig,
        parkingId: "different-id",
      }),
    /parkingId must equal appKey/,
  );
});

test("reportOperations rejects negative or oversized free berth", async () => {
  const client = new WestcityParkingClient(baseConfig, {
    fetchImpl: async () => createJsonResponse({ code: "0", msg: "ok" }, { status: 201 }),
  });

  await assert.rejects(
    () =>
      client.reportOperations({
        dotime: 1697942682,
        freeberth: 301,
        in: 1,
        out: 1,
      }),
    /operationData\.freeberth/,
  );
});

test("request errors redact signature in error details", async () => {
  const client = new WestcityParkingClient(baseConfig, {
    fetchImpl: async () => createJsonResponse({ code: "1024", msg: "invalid app key" }, { status: 400 }),
  });

  await assert.rejects(
    () => client.reportOperations({ dotime: 1697942682, freeberth: 10, in: 1, out: 1 }),
    (error) => {
      assert.ok(error instanceof WestcityRequestError);
      assert.equal(error.details.status, 400);
      assert.match(error.details.url, /signature=\*\*\*/);
      return true;
    },
  );
});

test("reportOperations rebuilds a signed url on retry", async () => {
  const calls = [];
  const client = new WestcityParkingClient(
    {
      ...baseConfig,
      retryCount: 1,
    },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        if (calls.length === 1) {
          return createJsonResponse({ code: "500", msg: "retry" }, { status: 500 });
        }
        return createJsonResponse({ code: "0", msg: "ok" }, { status: 201 });
      },
    },
  );

  const response = await client.reportOperations({
    dotime: 1697942682,
    freeberth: 100,
    in: 50,
    out: 40,
  });

  assert.equal(response.code, "0");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].url, calls[1].url);
});

test("loadConfigFromEnv supports timeout seconds and rejects conflicts", () => {
  const fromSeconds = loadConfigFromEnv({
    WESTCITY_BASE_URL: baseConfig.baseUrl,
    WESTCITY_APP_KEY: baseConfig.appKey,
    WESTCITY_APP_SECRET: baseConfig.appSecret,
    WESTCITY_DATA_KEY: baseConfig.dataKey,
    WESTCITY_APP_UUID: baseConfig.appUuid,
    WESTCITY_TIMEOUT_SECONDS: "2",
    WESTCITY_MAX_FREE_BERTH: "300",
  });

  assert.equal(fromSeconds.timeoutMs, 2000);

  assert.throws(
    () =>
      loadConfigFromEnv({
        WESTCITY_BASE_URL: baseConfig.baseUrl,
        WESTCITY_APP_KEY: baseConfig.appKey,
        WESTCITY_APP_SECRET: baseConfig.appSecret,
        WESTCITY_DATA_KEY: baseConfig.dataKey,
        WESTCITY_APP_UUID: baseConfig.appUuid,
        WESTCITY_TIMEOUT_MS: "1500",
        WESTCITY_TIMEOUT_SECONDS: "2",
        WESTCITY_MAX_FREE_BERTH: "300",
      }),
    /timeoutMs and config\.timeoutSeconds conflict|timeoutMs and timeoutSeconds conflict|config\.timeoutMs and config\.timeoutSeconds conflict/,
  );
});
