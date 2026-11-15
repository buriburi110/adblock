import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(rootDirectory, "sites", "soop.js"), "utf8");
const endpoint = "https://api.m.sooplive.com/station/video/a/view";
const fixtureUrl = "https://vod.sooplive.com/codex-soop-fixture";
const fixturePayload = {
  result: 1,
  data: {
    title: "SOOP player regression fixture",
    adballoon: { enabled: true, url: "https://reqde.sooplive.com/api/v1/recommend" },
    files: [{ file: "https://media.example/main.m3u8", duration: 1800 }],
    streaming: { token: "fixture-only", quality: "original" },
    subscribed: false,
    active_subscription: false,
    preroll_showyn: "Y",
    midroll_showyn: "Y",
    midroll_point_second: [600, 1200],
    nested: { adballoon: "must remain" },
  },
  adballoon: "top-level field must remain",
};
const expectedPayload = structuredClone(fixturePayload);
delete expectedPayload.data.adballoon;
const fixtureText = JSON.stringify(fixturePayload);
const normalized = (value) => JSON.parse(JSON.stringify(value));
let passed = 0;

async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

// The mock keeps native-shaped prototype accessors, exceptions, and cached JSON
// identity. It intentionally does not know anything about SOOP or pruning.
function createHarness({ hostname = "vod.sooplive.com" } = {}) {
  class FakeXMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.responseType = "";
      this.responseURL = "";
      this._text = "";
      this._json = null;
      this._other = null;
      this._listeners = new Map();
      this.openCalls = [];
    }

    open(method, url, ...rest) {
      this.openCalls.push([method, url, ...rest]);
      this.method = method;
      this.requestUrl = String(url);
      this.readyState = 1;
      this.status = 0;
      this.responseURL = "";
      this._text = "";
      this._json = null;
    }

    send(body) {
      this.requestBody = body;
    }

    addEventListener(type, listener) {
      const listeners = this._listeners.get(type) ?? [];
      listeners.push(listener);
      this._listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this._listeners.set(type, (this._listeners.get(type) ?? []).filter((entry) => entry !== listener));
    }

    getResponseHeader(name) {
      return name.toLowerCase() === "content-type" ? "application/json" : null;
    }

    getAllResponseHeaders() {
      return "content-type: application/json\r\n";
    }

    get responseText() {
      if (this.responseType !== "" && this.responseType !== "text") {
        throw new DOMException("responseText is unavailable for this responseType", "InvalidStateError");
      }
      return this.readyState < 3 ? "" : this._text;
    }

    get response() {
      if (this.responseType === "" || this.responseType === "text") {
        return this.readyState < 3 ? "" : this._text;
      }
      if (this.readyState !== 4) return null;
      return this.responseType === "json" ? this._json : this._other;
    }

    complete(text, { status = 200, responseURL = this.requestUrl, readyState = 4, other = null } = {}) {
      this._text = text;
      try { this._json = JSON.parse(text); } catch { this._json = null; }
      this._other = other;
      this.status = status;
      this.responseURL = responseURL;
      this.readyState = readyState;
      for (const listener of this._listeners.get("readystatechange") ?? []) listener.call(this, { target: this });
      this.onreadystatechange?.({ target: this });
      if (readyState === 4) {
        for (const listener of this._listeners.get("load") ?? []) listener.call(this, { target: this });
        this.onload?.({ target: this });
      }
    }
  }
  Object.assign(FakeXMLHttpRequest, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });
  Object.assign(FakeXMLHttpRequest.prototype, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });

  let fetchResult;
  let fetchError;
  let filteringState = null;
  const fetchCalls = [];
  const nativeFetch = function (...args) {
    fetchCalls.push({ receiver: this, args });
    return fetchError ? Promise.reject(fetchError) : Promise.resolve(fetchResult);
  };
  const location = new URL(`https://${hostname}/player/206062537`);
  const context = {
    console, URL, Request, Response, Headers, DOMException, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, structuredClone, location,
    document: {
      baseURI: location.href, location,
      documentElement: {
        getAttribute(name) { return name === "data-lae-player" ? filteringState : null; },
      },
    },
    XMLHttpRequest: FakeXMLHttpRequest,
    fetch: nativeFetch,
  };
  context.window = context;
  context.self = context;
  const sandbox = vm.createContext(context);
  const nativeOpen = FakeXMLHttpRequest.prototype.open;
  const nativeResponse = Object.getOwnPropertyDescriptor(FakeXMLHttpRequest.prototype, "response").get;
  const nativeResponseText = Object.getOwnPropertyDescriptor(FakeXMLHttpRequest.prototype, "responseText").get;
  const install = () => vm.runInContext(source, sandbox, { filename: "sites/soop.js" });
  install();
  return {
    context, install, fetchCalls, nativeFetch, nativeOpen, nativeResponse, nativeResponseText,
    setFetchResponse(response) { fetchResult = response; fetchError = undefined; },
    setFetchError(error) { fetchError = error; },
    setFilteringState(state) { filteringState = state; },
    xhr(url = endpoint, responseType = "") {
      const xhr = new context.XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.responseType = responseType;
      return xhr;
    },
  };
}

function fixtureResponse(text = fixtureText, options = {}) {
  const response = new Response(text, {
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    headers: { "content-type": "application/json", "x-fixture": "preserved", ...options.headers },
  });
  Object.defineProperties(response, {
    url: { value: options.url ?? endpoint, configurable: true },
    type: { value: options.type ?? "cors", configurable: true },
    redirected: { value: options.redirected ?? false, configurable: true },
  });
  return response;
}

await test("XHR text removes only data.adballoon and preserves media/subscription fields", () => {
  for (const type of ["", "text"]) {
    const harness = createHarness();
    const xhr = harness.xhr(`${endpoint}?nTitleNo=fixture`, type);
    xhr.send("nTitleNo=fixture");
    xhr.complete(fixtureText);
    assert.deepEqual(JSON.parse(xhr.responseText), expectedPayload);
    assert.deepEqual(JSON.parse(xhr.response), expectedPayload);
    assert.equal(xhr.response, xhr.responseText);
    assert.equal(xhr.requestBody, "nTitleNo=fixture");
    assert.deepEqual(xhr.openCalls[0], ["POST", `${endpoint}?nTitleNo=fixture`, true]);
  }
});

await test("XHR JSON caches the modified object without mutating the original", () => {
  const harness = createHarness();
  const xhr = harness.xhr(endpoint, "json");
  xhr.complete(fixtureText);
  const original = xhr._json;
  assert.deepEqual(normalized(xhr.response), expectedPayload);
  assert.equal(xhr.response, xhr.response);
  assert.notEqual(xhr.response, original);
  assert.deepEqual(original, fixturePayload);
  assert.throws(() => xhr.responseText, { name: "InvalidStateError" });
});

await test("XHR open reuse resets the previous transformed response", () => {
  const harness = createHarness();
  const xhr = harness.xhr(endpoint, "json");
  xhr.complete(fixtureText);
  const first = xhr.response;
  xhr.open("GET", endpoint, true);
  const secondPayload = structuredClone(fixturePayload);
  secondPayload.data.title = "A different VOD";
  xhr.complete(JSON.stringify(secondPayload));
  assert.equal(xhr.response.data.title, "A different VOD");
  assert.equal(Object.hasOwn(xhr.response.data, "adballoon"), false);
  assert.notEqual(xhr.response, first);
  xhr.open("GET", "https://api.m.sooplive.com/station/video/a/other", true);
  xhr.complete(fixtureText);
  assert.deepEqual(normalized(xhr.response), fixturePayload);
});

await test("XHR incomplete, failed, malformed, and non-JSON responses pass through", () => {
  const harness = createHarness();
  for (const status of [0, 400, 403, 404, 500]) {
    const xhr = harness.xhr();
    xhr.complete(fixtureText, { status });
    assert.equal(xhr.responseText, fixtureText);
  }
  const loading = harness.xhr();
  loading.complete(fixtureText, { readyState: 3 });
  assert.equal(loading.responseText, fixtureText);
  loading.complete(fixtureText);
  assert.deepEqual(JSON.parse(loading.responseText), expectedPayload);
  for (const body of ["not JSON", "{", "null", "[]", "123", '{"data":null}', '{"data":"unchanged"}', '{ "data": { "title": "keep whitespace" } }']) {
    const xhr = harness.xhr();
    xhr.complete(body);
    assert.equal(xhr.responseText, body);
  }
  for (const responseType of ["arraybuffer", "blob", "document"]) {
    const other = { opaqueNativeValue: responseType };
    const xhr = harness.xhr(endpoint, responseType);
    xhr.complete(fixtureText, { other });
    assert.equal(xhr.response, other);
  }
});

await test("XHR and fetch exact endpoint boundary prevents unrelated mutations", async () => {
  const urls = [
    "http://api.m.sooplive.com/station/video/a/view",
    "https://api.m.sooplive.com.evil.example/station/video/a/view",
    "https://api.m.sooplive.com:444/station/video/a/view",
    "https://evil.example/station/video/a/view",
    "https://api.m.sooplive.com/station/video/a/view/extra",
    "https://api.m.sooplive.com/station/video/a/viewer",
    "https://api.m.sooplive.com/station/video/a/other?redirect=/station/video/a/view",
    "https://vod.sooplive.com/station/video/a/view",
    "/station/video/a/view",
  ];
  const harness = createHarness();
  for (const url of urls) {
    const xhr = harness.xhr(url);
    xhr.complete(fixtureText);
    assert.equal(xhr.responseText, fixtureText, url);
    const response = fixtureResponse(fixtureText, { url: new URL(url, fixtureUrl).href });
    harness.setFetchResponse(response);
    assert.equal(await harness.context.fetch(url), response, url);
    assert.equal(response.bodyUsed, false, url);
  }
});

await test("Unrelated page hosts do not install either hook", () => {
  for (const hostname of ["www.sooplive.com", "play.sooplive.com", "youtube.com", "vod.sooplive.com.evil.example"]) {
    const harness = createHarness({ hostname });
    assert.equal(harness.context.fetch, harness.nativeFetch, hostname);
    assert.equal(harness.context.XMLHttpRequest.prototype.open, harness.nativeOpen, hostname);
    assert.equal(Object.getOwnPropertyDescriptor(harness.context.XMLHttpRequest.prototype, "response").get, harness.nativeResponse, hostname);
  }
});

await test("Repeated installation is idempotent", () => {
  const harness = createHarness();
  const fetch = harness.context.fetch;
  const xhrConstructor = harness.context.XMLHttpRequest;
  const open = xhrConstructor.prototype.open;
  const response = Object.getOwnPropertyDescriptor(xhrConstructor.prototype, "response").get;
  harness.install();
  assert.equal(harness.context.fetch, fetch);
  assert.equal(harness.context.XMLHttpRequest, xhrConstructor);
  assert.equal(xhrConstructor.prototype.open, open);
  assert.equal(Object.getOwnPropertyDescriptor(xhrConstructor.prototype, "response").get, response);
});

await test("XHR redirects away from the metadata endpoint are not rewritten", () => {
  const harness = createHarness();
  for (const responseType of ["text", "json"]) {
    const xhr = harness.xhr(endpoint, responseType);
    xhr.complete(fixtureText, { responseURL: "https://api.m.sooplive.com/station/video/a/other" });
    if (responseType === "json") assert.equal(xhr.response, xhr._json);
    else assert.equal(xhr.responseText, fixtureText);
  }
});

await test("fetch removes only the ad field and retains response metadata and clone behavior", async () => {
  const harness = createHarness();
  const original = fixtureResponse(fixtureText, { redirected: true, status: 201, statusText: "Created" });
  harness.setFetchResponse(original);
  const response = await harness.context.fetch(endpoint, { method: "POST", body: "fixture" });
  assert.notEqual(response, original);
  assert.equal(original.bodyUsed, false);
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.headers.get("x-fixture"), "preserved");
  assert.equal(response.url, endpoint);
  assert.equal(response.type, "cors");
  assert.equal(response.redirected, true);
  const clone = response.clone();
  assert.equal(clone.url, response.url);
  assert.equal(clone.type, response.type);
  assert.equal(clone.redirected, response.redirected);
  assert.deepEqual(await response.json(), expectedPayload);
  assert.deepEqual(JSON.parse(await clone.text()), expectedPayload);
  assert.deepEqual(harness.fetchCalls[0].args, [endpoint, { method: "POST", body: "fixture" }]);
});

await test("fetch supports Request and URL inputs without changing request options", async () => {
  const harness = createHarness();
  for (const input of [new Request(`${endpoint}?fixture=request`, { method: "POST", body: "payload" }), new URL(`${endpoint}?fixture=url`)]) {
    harness.setFetchResponse(fixtureResponse());
    const response = await harness.context.fetch(input);
    assert.deepEqual(await response.json(), expectedPayload);
    assert.equal(harness.fetchCalls.at(-1).args[0], input);
  }
});

await test("fetch failure paths preserve native errors and untouched responses", async () => {
  const harness = createHarness();
  const networkError = new TypeError("fixture network failure");
  harness.setFetchError(networkError);
  await assert.rejects(harness.context.fetch(endpoint), (error) => error === networkError);
  for (const [body, options] of [
    ["invalid JSON", {}], ["null", {}], ['{"data":null}', {}], ['{ "data": { "title": "original formatting" } }', {}],
    [fixtureText, { status: 500, statusText: "Server Error" }],
    [fixtureText, { url: "https://api.m.sooplive.com/station/video/a/different", redirected: true }],
  ]) {
    const original = fixtureResponse(body, options);
    harness.setFetchResponse(original);
    assert.equal(await harness.context.fetch(endpoint), original);
    assert.equal(original.bodyUsed, false);
    assert.equal(await original.text(), body);
  }
  const consumed = fixtureResponse();
  await consumed.text();
  harness.setFetchResponse(consumed);
  assert.equal(await harness.context.fetch(endpoint), consumed);
});

await test("Only an own data.adballoon property is targeted, including false/null values", async () => {
  const harness = createHarness();
  for (const adballoon of [null, false, 0, "", [], {}]) {
    const text = JSON.stringify({ data: { adballoon, retained: 1 } });
    const xhr = harness.xhr(endpoint, "json");
    xhr.complete(text);
    assert.deepEqual(normalized(xhr.response), { data: { retained: 1 } });
    harness.setFetchResponse(fixtureResponse(text));
    assert.deepEqual(await (await harness.context.fetch(endpoint)).json(), { data: { retained: 1 } });
  }
});

await test("Existing XHR responses obey OFF immediately and reuse their ON cache after re-enable", () => {
  const harness = createHarness();
  for (const responseType of ["text", "json"]) {
    harness.setFilteringState("on");
    const xhr = harness.xhr(endpoint, responseType);
    xhr.complete(fixtureText);
    const rewritten = xhr.response;
    assert.deepEqual(responseType === "json" ? normalized(rewritten) : JSON.parse(rewritten), expectedPayload);
    harness.setFilteringState("off");
    assert.equal(xhr.response, responseType === "json" ? xhr._json : fixtureText);
    if (responseType === "text") assert.equal(xhr.responseText, fixtureText);
    else assert.throws(() => xhr.responseText, { name: "InvalidStateError" });
    harness.setFilteringState("on");
    assert.equal(xhr.response, rewritten);
    if (responseType === "text") assert.equal(xhr.responseText, rewritten);
  }
  harness.setFilteringState("off");
  const initiallyOff = harness.xhr(endpoint, "json");
  initiallyOff.complete(fixtureText);
  assert.equal(initiallyOff.response, initiallyOff._json);
  harness.setFilteringState("on");
  assert.deepEqual(normalized(initiallyOff.response), expectedPayload);
});

await test("fetch honors OFF at request completion and while cloned JSON is still being read", async () => {
  const harness = createHarness();
  const alreadyOff = fixtureResponse();
  harness.setFilteringState("off");
  harness.setFetchResponse(alreadyOff);
  assert.equal(await harness.context.fetch(endpoint), alreadyOff);
  assert.equal(alreadyOff.bodyUsed, false);

  harness.setFilteringState("on");
  let releaseNetwork;
  harness.setFetchResponse(new Promise((resolve) => { releaseNetwork = resolve; }));
  const pendingNetwork = harness.context.fetch(endpoint);
  harness.setFilteringState("off");
  const networkResponse = fixtureResponse();
  releaseNetwork(networkResponse);
  assert.equal(await pendingNetwork, networkResponse);
  assert.equal(networkResponse.bodyUsed, false);

  harness.setFilteringState("on");
  let releaseText;
  let signalCloneStarted;
  const cloneStarted = new Promise((resolve) => { signalCloneStarted = resolve; });
  const textPending = new Promise((resolve) => { releaseText = resolve; });
  const readingResponse = fixtureResponse();
  Object.defineProperty(readingResponse, "clone", { value: () => ({
    text() { signalCloneStarted(); return textPending; },
  }) });
  harness.setFetchResponse(readingResponse);
  const pendingRead = harness.context.fetch(endpoint);
  await cloneStarted;
  harness.setFilteringState("off");
  releaseText(fixtureText);
  assert.equal(await pendingRead, readingResponse);
  assert.equal(readingResponse.bodyUsed, false);

  harness.setFilteringState("on");
  harness.setFetchResponse(fixtureResponse());
  assert.deepEqual(await (await harness.context.fetch(endpoint)).json(), expectedPayload);
});

async function chromeIntegration() {
  const { chromium } = require("playwright");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const profileDirectory = fs.mkdtempSync(path.join(temporaryRoot, "light-adblock-soop-check-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      headless: false,
      args: [
        `--disable-extensions-except=${rootDirectory}`, `--load-extension=${rootDirectory}`,
        "--window-position=-32000,-32000", "--window-size=800,600",
      ],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    // Every page and data request is fulfilled locally; the fixture never contacts
    // SOOP and cannot depend on an account, a live campaign, or the site's uptime.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === fixtureUrl) {
        await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><script>
window.__runSoopFixture = async () => {
  const endpoint = ${JSON.stringify(endpoint)};
  const xhrData = (responseType) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint + '?fixture=' + responseType);
    xhr.responseType = responseType;
    xhr.onload = () => resolve(responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText));
    xhr.onerror = reject;
    xhr.send('fixture=1');
  });
  const [xhrText, xhrJson, fetched, other] = await Promise.all([
    xhrData('text'), xhrData('json'),
    fetch(endpoint + '?fixture=fetch').then(response => response.json()),
    fetch(endpoint + '/other').then(response => response.json()),
  ]);
  return { xhrText, xhrJson, fetched, other };
};
window.__soopFixture = window.__runSoopFixture();
</script></head><body>Offline SOOP integration fixture</body></html>` });
      } else if (url.hostname === "api.m.sooplive.com") {
        await route.fulfill({ status: 200, contentType: "application/json", headers: {
          "access-control-allow-origin": "https://vod.sooplive.com",
          "access-control-allow-methods": "GET,POST,OPTIONS",
        }, body: fixtureText });
      } else {
        await route.abort();
      }
    });

    const syncSettings = async (settings) => {
      await worker.evaluate(async (value) => {
        await chrome.storage.local.set(value);
        // The background's storage listener serializes registration and ruleset
        // updates. Wait for the specific observable state rather than a fixed nap.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const scripts = await chrome.scripting.getRegisteredContentScripts();
          const soop = scripts.find((script) => script.js?.includes("sites/soop.js"));
          const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
          const expectedExcluded = value.disabledSites.includes("vod.sooplive.com");
          const registrationMatches = value.enabled
            ? soop && soop.world === "MAIN" && soop.runAt === "document_start" &&
              Boolean(soop.excludeMatches?.includes("https://vod.sooplive.com/*")) === expectedExcluded
            : !soop;
          if (registrationMatches && enabledRulesets.includes("soop") === value.enabled) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("SOOP settings did not synchronize");
      }, settings);
    };
    const inspectFixture = async () => {
      await page.goto(fixtureUrl, { waitUntil: "load" });
      return page.evaluate(() => window.__soopFixture);
    };
    const inspectExistingDocument = async (expectedState) => {
      await page.waitForFunction((value) => document.documentElement.getAttribute("data-lae-player") === value, expectedState);
      return page.evaluate(() => window.__runSoopFixture());
    };
    const inspectRules = async (expectedEnabled) => {
      const outcomes = await worker.evaluate(async () => {
        const adRequests = [
          ["https://reqde.sooplive.com/api/v1/recommend", "xmlhttprequest"],
          ["https://adballoon.sooplive.com/api/fixture", "xmlhttprequest"],
          ["https://deapi.sooplive.com/api/v1/recommend", "xmlhttprequest"],
          ["https://bjapi.sooplive.com/api/ad/fixture", "xmlhttprequest"],
          ["https://live.sooplive.com/api/get_ad.php?type=vod", "xmlhttprequest"],
          ["https://img-display.sooplive.com/creatives/fixture.png", "image"],
          ["https://res.sooplive.com/script/da/af_da_block.js", "script"],
          ["https://res.sooplive.com/script/da/ad_check.js", "script"],
          ["https://static.sooplive.com/asset/service/ad/fixture.js", "script"],
        ];
        const preservedRequests = [
          ["https://api.m.sooplive.com/station/video/a/view", "xmlhttprequest"],
          ["https://static.sooplive.com/asset/app/vodplayer/core/vodplayer-core-3.1.38.min.js", "script"],
          ["https://static.sooplive.com/asset/app/vodplayer/view/static/js/main.fixture.js", "script"],
          ["https://vod-player.sooplive.com/main/fixture.m3u8", "media"],
          ["https://live.sooplive.com/api/get_station_status.php", "xmlhttprequest"],
        ];
        const match = async ([url, type], initiator = "https://vod.sooplive.com") => {
          const result = await chrome.declarativeNetRequest.testMatchOutcome({ url, type, initiator, tabId: -1 });
          return result.matchedRules.some((rule) => rule.rulesetId === "soop");
        };
        return {
          ads: await Promise.all(adRequests.map((request) => match(request))),
          preserved: await Promise.all(preservedRequests.map((request) => match(request))),
          otherInitiator: await Promise.all(adRequests.map((request) => match(request, "https://unrelated.example"))),
          navigations: await Promise.all(adRequests.map(([url]) => match([url, "main_frame"]))),
        };
      });
      assert.equal(outcomes.ads.every((matched) => matched === expectedEnabled), true, JSON.stringify(outcomes));
      assert.equal([...outcomes.preserved, ...outcomes.otherInitiator, ...outcomes.navigations].every((matched) => !matched), true, JSON.stringify(outcomes));
    };
    await syncSettings({ enabled: true, disabledSites: [] });
    await inspectRules(true);
    const enabled = await inspectFixture();
    for (const key of ["xhrText", "xhrJson", "fetched"]) assert.deepEqual(enabled[key], expectedPayload, key);
    assert.deepEqual(enabled.other, fixturePayload);
    // SOOP's supplemental rules must work independently of which general list
    // is selected. Real registration-failure recovery is covered in smoke tests.
    await worker.evaluate(() => chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: ["easylist"], enableRulesetIds: ["ads"],
    }));
    await inspectRules(true);
    const fallback = await inspectFixture();
    for (const key of ["xhrText", "xhrJson", "fetched"]) assert.deepEqual(fallback[key], expectedPayload, key);
    await syncSettings({ enabled: true, disabledSites: ["vod.sooplive.com"] });
    const existingExcluded = await inspectExistingDocument("off");
    for (const payload of Object.values(existingExcluded)) assert.deepEqual(payload, fixturePayload);
    await syncSettings({ enabled: true, disabledSites: [] });
    const existingRestored = await inspectExistingDocument("on");
    for (const key of ["xhrText", "xhrJson", "fetched"]) assert.deepEqual(existingRestored[key], expectedPayload, key);
    await syncSettings({ enabled: false, disabledSites: [] });
    const existingDisabled = await inspectExistingDocument("off");
    for (const payload of Object.values(existingDisabled)) assert.deepEqual(payload, fixturePayload);
    await syncSettings({ enabled: true, disabledSites: [] });
    const existingReenabled = await inspectExistingDocument("on");
    for (const key of ["xhrText", "xhrJson", "fetched"]) assert.deepEqual(existingReenabled[key], expectedPayload, key);
    await syncSettings({ enabled: true, disabledSites: ["vod.sooplive.com"] });
    const excluded = await inspectFixture();
    for (const payload of Object.values(excluded)) assert.deepEqual(payload, fixturePayload);
    await syncSettings({ enabled: false, disabledSites: [] });
    await inspectRules(false);
    const disabled = await inspectFixture();
    for (const payload of Object.values(disabled)) assert.deepEqual(payload, fixturePayload);
    await syncSettings({ enabled: true, disabledSites: [] });
    const restored = await inspectFixture();
    for (const key of ["xhrText", "xhrJson", "fetched"]) assert.deepEqual(restored[key], expectedPayload, key);
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  } finally {
    await context?.close();
    const resolved = path.resolve(profileDirectory);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith("light-adblock-soop-check-")) {
      throw new Error("Refusing to remove an unexpected temporary profile path");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (process.argv.includes("--chrome")) {
  await test("Installed Chromium extension: document_start XHR/fetch hooks, site exclusion, global OFF, and re-enable", chromeIntegration);
}
console.log(`SOOP 검사 완료: ${passed}개 그룹 통과${process.argv.includes("--chrome") ? " (Chromium 포함)" : " (--chrome으로 실제 확장 통합 검사 추가)"}`);
