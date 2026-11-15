import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(rootDirectory, "sites", "chzzk.js"), "utf8");
const detailUrl = "https://api.chzzk.naver.com/service/v3/channels/fixture/live-detail";
const statusUrl = "https://api.chzzk.naver.com/polling/v3/channels/fixture/live-status";
const adUrl = "https://api.chzzk.naver.com/service/v1/seoraksan?pgType=CHZZK_LIVE&pgId=fixture";
const fixtureUrl = "https://chzzk.naver.com/codex-chzzk-fixture";
const normalized = (value) => JSON.parse(JSON.stringify(value));
const envelope = (content) => ({ code: 200, message: null, content });
const polling = (playableStatus = "FORCE_LOW_RESOLUTION", trafficThrottling = 3200000) => ({
  status: "STARTED", playableStatus, trafficThrottling, callPeriodMilliSecond: 10000,
  liveId: 987654, chatChannelId: "real-chat-id", opaque: { retained: true },
});
const fixturePayload = envelope({
  liveId: 987654, liveTitle: "Offline Chzzk fixture", adult: false, paid: false,
  livePollingStatusJson: JSON.stringify(polling()), skipPreRollAd: false,
  livePlaybackJson: "{}", token: "fixture-token-must-remain",
});
const expectedPayload = structuredClone(fixturePayload);
expectedPayload.content.livePollingStatusJson = JSON.stringify(polling("PLAYABLE", -1));
expectedPayload.content.skipPreRollAd = true;
const fixtureText = JSON.stringify(fixturePayload);
const directAdPayload = envelope({
  playerAdDisplayResponse: { preRoll: true, midRoll: true, postRoll: true, partner: "retained" },
  liveId: 987654, entitlement: { paid: false },
});
const expectedAdPayload = structuredClone(directAdPayload);
for (const flag of ["preRoll", "midRoll", "postRoll"]) expectedAdPayload.content.playerAdDisplayResponse[flag] = false;
// Public player metadata inspected on 2026-10-03. HTTPS HLS manifests carry all
// quality tracks; the 720/1080 tracks advertise P2P URLs instead of their own path.
const playbackDescriptor = {
  meta: { liveId: 987654, paidLive: false, p2p: true, playbackAuthType: "NONE" },
  serviceMeta: { contentType: "VIDEO" },
  live: { start: "2026-10-03T00:00:00Z", open: true, timeMachine: false, status: "STARTED" },
  api: { status: statusUrl },
  media: ["HLS", "LLHLS"].map((mediaId) => ({
    mediaId, protocol: "HLS", ...(mediaId === "LLHLS" ? { latency: "lowLatency" } : {}),
    path: `https://nvelop-livecloud.pstatic.net/fixture/${mediaId}/playlist.m3u8?token=preserved`,
    p2pPath: `p2p://fixture/${mediaId}`, p2pPathUrlEncoding: `p2p%3A%2F%2Ffixture%2F${mediaId}`,
    encodingTrack: [
      { encodingTrackId: "audioOnly", audioOnly: true, path: `https://nvelop-livecloud.pstatic.net/fixture/${mediaId}/audio.m3u8` },
      { encodingTrackId: "360p", videoWidth: 640, videoHeight: 360, videoBitRate: 1000000 },
      { encodingTrackId: "720p", videoWidth: 1280, videoHeight: 720, videoBitRate: 3200000, p2pPath: "p2p://fixture/720", p2pPathUrlEncoding: "p2p%3A%2F%2Ffixture%2F720" },
      { encodingTrackId: "1080p", videoWidth: 1920, videoHeight: 1080, videoBitRate: 8000000, p2pPath: "p2p://fixture/1080", p2pPathUrlEncoding: "p2p%3A%2F%2Ffixture%2F1080" },
    ],
  })),
  thumbnail: { path: "https://thumbnail.example/fixture.jpg" }, multiview: [],
};
const expectedPlaybackDescriptor = structuredClone(playbackDescriptor);
for (const media of expectedPlaybackDescriptor.media) {
  for (const node of [media, ...media.encodingTrack]) {
    delete node.p2pPath;
    delete node.p2pPathUrlEncoding;
  }
}
const playbackCheckNames = [
  "candidates", "descriptorRejected", "entitlementRejected", "mediaShapeRejected",
  "mediaUrlRejected", "mediaHostRejected", "noP2pPaths", "partiallyPatched", "fullyPatched",
];
const expectedPlaybackChecks = (values = {}) => ({
  ...Object.fromEntries(playbackCheckNames.map((name) => [name, 0])), ...values,
});
const tunnelPolicy = { code: 200, message: null, content: { livePlaybackJson: { liveId: true, chatChannelId: true } } };
const expectedTunnelPolicy = { code: 200, message: null, content: { livePlaybackJson: { liveId: false, chatChannelId: false } } };
const waterfallPayload = {
  requestId: "fixture-request-id",
  head: { version: "0.0.1", description: "Naver SSP Waterfall List" },
  eventTracking: { requested: "fixture-tracking-must-remain" },
  adUnit: "fixture-video-unit", randomNumber: 123456, adDivId: "fixture-ad-container",
  videoSkipMin: 5, videoSkipAfter: 5,
  ads: ["GOOGLE_IMA", "EMPTY"].map((renderType) => ({
    renderType, creativeType: "VIDEO", encrypted: "fixture-ciphertext",
    connectionType: "fixture-connection", adProviderName: "fixture-provider", layoutType: "fixture-layout",
    eventTracking: { impression: "fixture-impression-never-publish" },
    adInfo: { placement: "fixture-placement" },
    ...(renderType === "GOOGLE_IMA" ? { adProviderType: "fixture-provider-type" } : {}),
  })),
};
const expectedWaterfallPayload = { ...structuredClone(waterfallPayload), ads: [] };
// GOOGLE_IMA/EMPTY were observed in live responses. GV and the minimal fields
// come from the official SDK renderer/validateAd code, not an observed GV fill.
const sdkMinimalWaterfallAds = ["GV", "GOOGLE_IMA", "EMPTY"].map((renderType) => ({
  renderType, creativeType: "VIDEO", adInfo: { fixture: "renderer-metadata" },
}));
const tunnelAad = new Uint8Array([0, 22, ...new TextEncoder().encode("gfp-tunnel-response-v1"), ...Array.from({ length: 16 }, (_, i) => i + 1)]);
const encodedBuffer = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).buffer;
const decodedBuffer = (value) => JSON.parse(new TextDecoder().decode(value));
const tunnelAlgorithm = (additionalData = tunnelAad) => ({ name: "AES-GCM", iv: new Uint8Array(12), tagLength: 128, additionalData });
let passed = 0;

async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function createHarness({ hostname = "chzzk.naver.com", rootAvailable = true, lockedHooks = [] } = {}) {
  class FakeXMLHttpRequest {
    constructor() {
      Object.assign(this, { readyState: 0, status: 0, responseType: "", responseURL: "", _text: "", _json: null, _other: null });
      this.openCalls = [];
      this._listeners = new Map();
    }
    open(method, url, ...rest) {
      this.openCalls.push([method, url, ...rest]);
      this.requestUrl = String(url);
      Object.assign(this, { readyState: 1, status: 0, responseURL: "", _text: "", _json: null });
    }
    send(body) { this.requestBody = body; }
    addEventListener(type, listener) {
      this._listeners.set(type, [...(this._listeners.get(type) ?? []), listener]);
    }
    removeEventListener(type, listener) {
      this._listeners.set(type, (this._listeners.get(type) ?? []).filter((entry) => entry !== listener));
    }
    getResponseHeader(name) { return name.toLowerCase() === "content-type" ? "application/json" : null; }
    getAllResponseHeaders() { return "content-type: application/json\r\n"; }
    get responseText() {
      if (this.responseType !== "" && this.responseType !== "text") throw new DOMException("Invalid responseType", "InvalidStateError");
      return this.readyState < 3 ? "" : this._text;
    }
    get response() {
      if (this.responseType === "" || this.responseType === "text") return this.readyState < 3 ? "" : this._text;
      if (this.readyState !== 4) return null;
      return this.responseType === "json" ? this._json : this._other;
    }
    complete(text, { status = 200, responseURL = this.requestUrl, readyState = 4, other = null } = {}) {
      this._text = text;
      try { this._json = JSON.parse(text); } catch { this._json = null; }
      Object.assign(this, { status, responseURL, readyState, _other: other });
      for (const listener of this._listeners.get("readystatechange") ?? []) listener.call(this, { target: this });
      this.onreadystatechange?.({ target: this });
      if (readyState === 4) {
        for (const listener of this._listeners.get("load") ?? []) listener.call(this, { target: this });
        this.onload?.({ target: this });
      }
    }
  }
  Object.assign(FakeXMLHttpRequest.prototype, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });
  Object.assign(FakeXMLHttpRequest, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });
  let fetchResult;
  let fetchError;
  let filteringState = null;
  let decryptResult;
  let decryptError;
  let cryptoBackend;
  const attributes = new Map();
  const documentListeners = new Map();
  const observers = new Set();
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) { this.target = target; this.options = options; observers.add(this); }
    disconnect() { observers.delete(this); }
    takeRecords() { return []; }
  }
  function notifyMutation(record) {
    for (const observer of [...observers]) {
      if (record.type === "childList" && !observer.options?.childList) continue;
      if (record.type === "attributes" && (!observer.options?.attributes ||
        (observer.options.attributeFilter && !observer.options.attributeFilter.includes(record.attributeName)))) continue;
      queueMicrotask(() => { if (observers.has(observer)) observer.callback([record], observer); });
    }
  }
  const rootElement = {
    getAttribute(name) { return name === "data-lae-player" ? filteringState : attributes.get(name) ?? null; },
    setAttribute(name, value) {
      if (name === "data-lae-player") filteringState = String(value);
      else attributes.set(name, String(value));
      notifyMutation({ type: "attributes", target: rootElement, attributeName: name });
    },
  };
  const decryptCalls = [];
  const nativeDecrypt = function (...args) {
    const operation = cryptoBackend
      ? Reflect.apply(cryptoBackend.decrypt, cryptoBackend, args)
      : decryptError ? Promise.reject(decryptError) : Promise.resolve(decryptResult);
    decryptCalls.push({ receiver: this, args, operation });
    return operation;
  };
  const fetchCalls = [];
  const nativeFetch = function (...args) {
    fetchCalls.push({ receiver: this, args });
    return fetchError ? Promise.reject(fetchError) : Promise.resolve(fetchResult);
  };
  const location = new URL(`https://${hostname}/live/fixture`);
  const context = {
    console, URL, Request, Response, Headers, DOMException, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, queueMicrotask, structuredClone, Event, location,
    MutationObserver: FakeMutationObserver, XMLHttpRequest: FakeXMLHttpRequest, fetch: nativeFetch,
    crypto: { subtle: { decrypt: nativeDecrypt } },
    document: {
      location, baseURI: location.href, documentElement: rootAvailable ? rootElement : null,
      addEventListener(type, listener) { documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]); },
      removeEventListener(type, listener) { documentListeners.set(type, (documentListeners.get(type) ?? []).filter((item) => item !== listener)); },
      dispatchEvent(event) { for (const listener of documentListeners.get(event.type) ?? []) listener(event); },
    },
  };
  context.window = context;
  context.self = context;
  const sandbox = vm.createContext(context);
  const nativeOpen = FakeXMLHttpRequest.prototype.open;
  const nativeResponse = Object.getOwnPropertyDescriptor(FakeXMLHttpRequest.prototype, "response").get;
  const nativeParse = vm.runInContext("JSON.parse", sandbox);
  if (lockedHooks.includes("fetch")) Object.defineProperty(context, "fetch", { value: nativeFetch, writable: false });
  if (lockedHooks.includes("decrypt")) Object.defineProperty(context.crypto.subtle, "decrypt", { value: nativeDecrypt, writable: false });
  if (lockedHooks.includes("jsonParse")) vm.runInContext("Object.defineProperty(JSON, 'parse', { writable: false })", sandbox);
  if (lockedHooks.includes("xhr")) {
    Object.defineProperty(FakeXMLHttpRequest.prototype, "open", { value: nativeOpen, writable: false });
    for (const property of ["response", "responseText"]) {
      Object.defineProperty(FakeXMLHttpRequest.prototype, property, {
        ...Object.getOwnPropertyDescriptor(FakeXMLHttpRequest.prototype, property), configurable: false,
      });
    }
  }
  const install = () => vm.runInContext(source, sandbox, { filename: "sites/chzzk.js" });
  install();
  return {
    context, install, nativeFetch, nativeOpen, nativeResponse, nativeParse, nativeDecrypt, fetchCalls, decryptCalls,
    parse(...args) { return vm.runInContext("JSON.parse", sandbox)(...args); },
    currentParse() { return vm.runInContext("JSON.parse", sandbox); },
    setFetchResponse(response) { fetchResult = response; fetchError = undefined; },
    setFetchError(error) { fetchError = error; },
    setFilteringState(state) {
      filteringState = state;
      context.document.dispatchEvent(new Event("lae-player-state"));
    },
    showRoot() {
      context.document.documentElement = rootElement;
      notifyMutation({ type: "childList", target: context.document, addedNodes: [rootElement] });
    },
    diagnosticText() { return attributes.get("data-lae-chzzk-diagnostics") ?? null; },
    setDecryptResult(result) { decryptResult = result; decryptError = undefined; cryptoBackend = undefined; },
    setDecryptError(error) { decryptError = error; cryptoBackend = undefined; },
    setCryptoBackend(backend) { cryptoBackend = backend; },
    xhr(url = detailUrl, responseType = "") {
      const xhr = new context.XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = responseType;
      return xhr;
    },
  };
}

function fixtureResponse(text = fixtureText, options = {}) {
  const response = new Response(text, {
    status: options.status ?? 200, statusText: options.statusText ?? "OK",
    headers: { "content-type": "application/json", "x-fixture": "retained", ...options.headers },
  });
  Object.defineProperties(response, {
    url: { value: options.url ?? detailUrl, configurable: true },
    type: { value: options.type ?? "cors", configurable: true },
    redirected: { value: options.redirected ?? false, configurable: true },
  });
  return response;
}

async function diagnostics(harness, predicate = () => true) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const text = harness.diagnosticText();
    if (text) {
      const value = JSON.parse(text);
      if (predicate(value)) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Chzzk DOM diagnostics did not reach the expected state");
}

async function assertTransform(payload, expected, url = detailUrl) {
  const harness = createHarness();
  const text = JSON.stringify(payload);
  for (const type of ["", "text", "json"]) {
    const xhr = harness.xhr(url, type);
    xhr.complete(text);
    assert.deepEqual(type === "json" ? normalized(xhr.response) : JSON.parse(xhr.response), expected, `${url} ${type}`);
    if (type !== "json") assert.equal(xhr.response, xhr.responseText);
  }
  harness.setFetchResponse(fixtureResponse(text, { url }));
  assert.deepEqual(await (await harness.context.fetch(url)).json(), expected, `${url} fetch`);
}

await test("XHR text/JSON and fetch remove the known quality cap but retain all unrelated fields", async () => {
  await assertTransform(fixturePayload, expectedPayload);
  await assertTransform(fixturePayload, expectedPayload, statusUrl);
});

await test("Authentication, age, paid, unknown statuses and invalid cap types are never normalized", async () => {
  for (const playableStatus of ["LOGIN_REQUIRED", "AGE_RESTRICTED", "PAID", "SUBSCRIPTION_REQUIRED", "FORBIDDEN", "NOT_PLAYABLE", "NEW_SERVER_STATUS", null, 1, true]) {
    const payload = envelope({ livePollingStatusJson: JSON.stringify(polling(playableStatus)) });
    await assertTransform(payload, payload);
  }
  for (const body of [null, [], "value", 12, true]) {
    const payload = envelope({ livePollingStatusJson: JSON.stringify(body) });
    await assertTransform(payload, payload);
  }
  for (const value of ["3200000", null, false, {}, []]) {
    const payload = envelope({ livePollingStatusJson: JSON.stringify(polling("PLAYABLE", value)) });
    await assertTransform(payload, payload);
  }
});

await test("Advertisement changes affect recognized booleans only and never real live/chat IDs", async () => {
  await assertTransform(directAdPayload, expectedAdPayload, adUrl);
  const disguised = envelope({ livePlaybackJson: { liveId: true, chatChannelId: true, contentId: "retained" } });
  const expected = structuredClone(disguised);
  expected.content.livePlaybackJson.liveId = false;
  expected.content.livePlaybackJson.chatChannelId = false;
  await assertTransform(disguised, expected, adUrl);
  for (const content of [
    { livePlaybackJson: { liveId: 987654, chatChannelId: "real-chat-id", token: "retained" } },
    { livePlaybackJson: JSON.stringify({ liveId: 987654, chatChannelId: "real-chat-id" }) },
    { playerAdDisplayResponse: { preRoll: "true", midRoll: 1, postRoll: null } },
    { playerAdDisplayResponse: {} },
    { skipPreRollAd: "false" },
  ]) {
    const payload = envelope(content);
    await assertTransform(payload, payload, adUrl);
  }
  const realData = envelope({ liveId: 987654, chatChannelId: "real-chat-id", skipPreRollAd: "false" });
  await assertTransform(realData, realData);
});

await test("XHR preserves original objects, cached identity, request arguments, and native read errors", () => {
  const harness = createHarness();
  const xhr = harness.xhr(detailUrl, "json");
  xhr.send("unchanged-body");
  xhr.complete(fixtureText);
  const first = xhr.response;
  assert.deepEqual(normalized(first), expectedPayload);
  assert.equal(xhr.response, first);
  assert.notEqual(first, xhr._json);
  assert.deepEqual(xhr._json, fixturePayload);
  assert.equal(xhr.requestBody, "unchanged-body");
  assert.deepEqual(xhr.openCalls[0], ["GET", detailUrl, true]);
  assert.throws(() => xhr.responseText, { name: "InvalidStateError" });
  xhr.open("GET", detailUrl, true);
  const changed = structuredClone(fixturePayload);
  changed.content.liveTitle = "Second stream";
  xhr.complete(JSON.stringify(changed));
  assert.notEqual(xhr.response, first);
  assert.equal(xhr.response.content.liveTitle, "Second stream");
  xhr.open("GET", "https://api.chzzk.naver.com/service/v1/channels/fixture", true);
  xhr.complete(fixtureText);
  assert.equal(xhr.response, xhr._json);
});

await test("Malformed/primitive JSON, HTTP failures, and non-JSON XHR bodies pass through", async () => {
  const harness = createHarness();
  for (const text of ["invalid JSON", "{", "null", "[]", "123", '{"content":null}', '{"content":"original"}', '{ "content": {} }', '{"content":{"livePollingStatusJson":"{"}}']) {
    const xhr = harness.xhr();
    xhr.complete(text);
    assert.equal(xhr.responseText, text);
    const response = fixtureResponse(text);
    harness.setFetchResponse(response);
    assert.equal(await harness.context.fetch(detailUrl), response);
    assert.equal(response.bodyUsed, false);
  }
  for (const status of [0, 400, 401, 403, 404, 500]) {
    const xhr = harness.xhr();
    xhr.complete(fixtureText, { status });
    assert.equal(xhr.responseText, fixtureText);
    if (status !== 0) {
      const response = fixtureResponse(fixtureText, { status });
      harness.setFetchResponse(response);
      assert.equal(await harness.context.fetch(detailUrl), response);
    }
  }
  const loading = harness.xhr();
  loading.complete(fixtureText, { readyState: 3 });
  assert.equal(loading.responseText, fixtureText);
  loading.complete(fixtureText);
  assert.deepEqual(JSON.parse(loading.responseText), expectedPayload);
  for (const responseType of ["arraybuffer", "blob", "document"]) {
    const other = { native: responseType };
    const xhr = harness.xhr(detailUrl, responseType);
    xhr.complete(fixtureText, { other });
    assert.equal(xhr.response, other);
  }
});

await test("Exact page, protocol, API host, endpoint and redirect scopes prevent unrelated rewrites", async () => {
  const harness = createHarness();
  for (const url of [
    detailUrl.replace("https:", "http:"), detailUrl.replace("api.chzzk.naver.com", "api.chzzk.naver.com.evil.example"),
    detailUrl.replace("api.chzzk.naver.com", "api.chzzk.naver.com:444"), detailUrl.replace("api.chzzk.naver.com", "chzzk.naver.com"),
    `${detailUrl}/extra`, `${detailUrl}-other`, "https://api.chzzk.naver.com/other/live-detail",
    "https://api.chzzk.naver.com/service/v3/channels/fixture/live-other?redirect=live-detail",
    "https://api.chzzk.naver.com/other/seoraksan", "/service/v3/channels/fixture/live-detail",
  ]) {
    const xhr = harness.xhr(url);
    xhr.complete(fixtureText);
    assert.equal(xhr.responseText, fixtureText, url);
    const response = fixtureResponse(fixtureText, { url: new URL(url, fixtureUrl).href });
    harness.setFetchResponse(response);
    assert.equal(await harness.context.fetch(url), response, url);
  }
  const redirectedUrl = "https://api.chzzk.naver.com/service/v1/channels/fixture";
  const xhr = harness.xhr();
  xhr.complete(fixtureText, { responseURL: redirectedUrl });
  assert.equal(xhr.responseText, fixtureText);
  const response = fixtureResponse(fixtureText, { url: redirectedUrl, redirected: true });
  harness.setFetchResponse(response);
  assert.equal(await harness.context.fetch(detailUrl), response);
  for (const hostname of ["api.chzzk.naver.com", "www.youtube.com", "vod.sooplive.com", "chzzk.naver.com.evil.example"]) {
    const other = createHarness({ hostname });
    assert.equal(other.context.fetch, other.nativeFetch, hostname);
    assert.equal(other.context.XMLHttpRequest.prototype.open, other.nativeOpen, hostname);
  }
});

await test("fetch retains status, headers, URL/type/redirect metadata, clone and native consumption semantics", async () => {
  const harness = createHarness();
  const original = fixtureResponse(fixtureText, { status: 201, statusText: "Created", redirected: true });
  harness.setFetchResponse(original);
  const options = { method: "POST", body: "keep", credentials: "include" };
  const response = await harness.context.fetch(detailUrl, options);
  assert.notEqual(response, original);
  assert.equal(original.bodyUsed, false);
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.deepEqual([...response.headers], [...original.headers]);
  const clone = response.clone();
  const secondClone = clone.clone();
  for (const item of [response, clone, secondClone]) {
    assert.equal(item.url, detailUrl);
    assert.equal(item.type, "cors");
    assert.equal(item.redirected, true);
    assert.deepEqual(await item.json(), expectedPayload);
    assert.equal(item.bodyUsed, true);
    await assert.rejects(item.text(), TypeError);
    assert.throws(() => item.clone(), TypeError);
  }
  assert.equal(harness.fetchCalls[0].args[1], options);
  for (const input of [new URL(detailUrl), new Request(detailUrl)]) {
    harness.setFetchResponse(fixtureResponse());
    assert.deepEqual(await (await harness.context.fetch(input)).json(), expectedPayload);
    assert.equal(harness.fetchCalls.at(-1).args[0], input);
  }
  const failure = new TypeError("fixture network failure");
  harness.setFetchError(failure);
  await assert.rejects(harness.context.fetch(detailUrl), (error) => error === failure);
  const consumed = fixtureResponse();
  await consumed.text();
  harness.setFetchResponse(consumed);
  assert.equal(await harness.context.fetch(detailUrl), consumed);
});

await test("Repeated installation and OFF/ON switches preserve native functions and cached XHR identity", async () => {
  const harness = createHarness();
  const patchedFetch = harness.context.fetch;
  const patchedOpen = harness.context.XMLHttpRequest.prototype.open;
  const patchedGetter = Object.getOwnPropertyDescriptor(harness.context.XMLHttpRequest.prototype, "response").get;
  harness.install();
  assert.equal(harness.context.fetch, patchedFetch);
  assert.equal(harness.context.XMLHttpRequest.prototype.open, patchedOpen);
  assert.equal(Object.getOwnPropertyDescriptor(harness.context.XMLHttpRequest.prototype, "response").get, patchedGetter);
  for (const type of ["text", "json"]) {
    harness.setFilteringState("on");
    const xhr = harness.xhr(detailUrl, type);
    xhr.complete(fixtureText);
    const active = xhr.response;
    harness.setFilteringState("off");
    assert.equal(xhr.response, type === "json" ? xhr._json : fixtureText);
    harness.setFilteringState("on");
    assert.equal(xhr.response, active);
  }
  harness.setFilteringState("off");
  const response = fixtureResponse();
  harness.setFetchResponse(response);
  assert.equal(await harness.context.fetch(detailUrl), response);
});

await test("In-flight fetch respects OFF both before headers arrive and during cloned body reads", async () => {
  const harness = createHarness();
  let releaseNetwork;
  harness.setFetchResponse(new Promise((resolve) => { releaseNetwork = resolve; }));
  const pendingNetwork = harness.context.fetch(detailUrl);
  harness.setFilteringState("off");
  const networkResponse = fixtureResponse();
  releaseNetwork(networkResponse);
  assert.equal(await pendingNetwork, networkResponse);
  assert.equal(networkResponse.bodyUsed, false);
  harness.setFilteringState("on");
  let releaseText;
  let cloneStarted;
  const signal = new Promise((resolve) => { cloneStarted = resolve; });
  const pendingText = new Promise((resolve) => { releaseText = resolve; });
  const bodyResponse = fixtureResponse();
  Object.defineProperty(bodyResponse, "clone", { value: () => ({ text() { cloneStarted(); return pendingText; } }) });
  harness.setFetchResponse(bodyResponse);
  const pendingRead = harness.context.fetch(detailUrl);
  await signal;
  harness.setFilteringState("off");
  releaseText(fixtureText);
  assert.equal(await pendingRead, bodyResponse);
  assert.equal(bodyResponse.bodyUsed, false);
});

await test("Decoded public HLS/LLHLS descriptors keep 1080p tracks, HTTPS paths and entitlements", () => {
  const harness = createHarness();
  const result = normalized(harness.parse(JSON.stringify(playbackDescriptor)));
  assert.deepEqual(result, expectedPlaybackDescriptor);
  assert.equal(result.media.length, 2);
  for (const media of result.media) {
    assert.deepEqual(media.encodingTrack.map((track) => track.encodingTrackId), ["audioOnly", "360p", "720p", "1080p"]);
    assert.equal(media.encodingTrack.at(-1).videoHeight, 1080);
    assert.equal(media.encodingTrack.at(-1).videoBitRate, 8000000);
    assert.match(media.path, /^https:\/\/nvelop-livecloud\.pstatic\.net\//);
    assert.equal(Object.hasOwn(media.encodingTrack.at(-1), "path"), false);
  }
  assert.equal(result.meta.liveId, playbackDescriptor.meta.liveId);
  assert.equal(result.meta.paidLive, false);
  assert.equal(result.meta.playbackAuthType, "NONE");
  const wrapper = envelope({ livePlaybackJson: JSON.stringify(playbackDescriptor), access: "unchanged" });
  // Envelopes remain exact; only the subsequent player parse of the descriptor
  // is eligible. This also covers the site's encrypted metadata transport.
  assert.deepEqual(normalized(harness.parse(JSON.stringify(wrapper))), wrapper);
  const decoded = harness.parse(wrapper.content.livePlaybackJson);
  assert.deepEqual(normalized(decoded), expectedPlaybackDescriptor);
  for (const hostname of ["nvelop-livecloud.pstatic.net", "ex-nlive-streaming.navercdn.com", "livecloud.pstatic.net", "fcdn-livecloud.pstatic.net"]) {
    const descriptor = structuredClone(playbackDescriptor);
    const expected = structuredClone(expectedPlaybackDescriptor);
    for (const value of [descriptor, expected]) {
      for (const media of value.media) {
        media.path = media.path.replace("nvelop-livecloud.pstatic.net", hostname);
        media.encodingTrack[0].path = media.encodingTrack[0].path.replace("nvelop-livecloud.pstatic.net", hostname);
      }
    }
    assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), expected, hostname);
  }
});

await test("Descriptor matching excludes restricted, non-live, unrelated and unsafe-media JSON", () => {
  const harness = createHarness();
  const protectedDescriptors = [];
  for (const [key, value] of [
    ["paidLive", true], ["paidLive", "false"],
    ["playbackAuthType", "LOGIN"], ["playbackAuthType", "AGE_VERIFICATION"],
    ["playbackAuthType", "SUBSCRIPTION"], ["playbackAuthType", "UNKNOWN"],
  ]) {
    const descriptor = structuredClone(playbackDescriptor);
    descriptor.meta[key] = value;
    protectedDescriptors.push(descriptor);
  }
  for (const status of ["ENDED", "CLOSED", "UNKNOWN", null]) {
    const descriptor = structuredClone(playbackDescriptor);
    descriptor.live.status = status;
    protectedDescriptors.push(descriptor);
  }
  for (const key of ["meta", "serviceMeta", "live", "media"]) {
    const descriptor = structuredClone(playbackDescriptor);
    delete descriptor[key];
    protectedDescriptors.push(descriptor);
  }
  for (const descriptor of protectedDescriptors) {
    assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), descriptor);
  }
  for (const path of [
    "p2p://fixture/only", "javascript:alert(1)",
    "http://nvelop-livecloud.pstatic.net/fixture/playlist.m3u8", "http://ex-nlive-streaming.navercdn.com/fixture/playlist.m3u8",
    "http://livecloud.pstatic.net/fixture/playlist.m3u8",
    "http://fcdn-livecloud.pstatic.net/fixture/playlist.m3u8",
    "https://nvelop-livecloud.pstatic.net.evil.example/fixture/playlist.m3u8", "https://ex-nlive-streaming.navercdn.com.evil.example/fixture/playlist.m3u8",
    "https://livecloud.pstatic.net.evil.example/fixture/playlist.m3u8",
    "https://fcdn-livecloud.pstatic.net.evil.example/fixture/playlist.m3u8",
    "https://nvelop-livecloud.pstatic.net:444/fixture/playlist.m3u8", "https://ex-nlive-streaming.navercdn.com:444/fixture/playlist.m3u8",
    "https://livecloud.pstatic.net:444/fixture/playlist.m3u8",
    "https://fcdn-livecloud.pstatic.net:444/fixture/playlist.m3u8",
    "https://user@fcdn-livecloud.pstatic.net/fixture/playlist.m3u8",
    "https://user:secret@fcdn-livecloud.pstatic.net/fixture/playlist.m3u8",
    "https://other.example/playlist.m3u8",
  ]) {
    const descriptor = structuredClone(playbackDescriptor);
    for (const media of descriptor.media) media.path = path;
    assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), descriptor);
  }
  const unrelated = { meta: { p2p: true }, media: [{ p2pPath: "keep" }], auth: "unchanged" };
  assert.deepEqual(normalized(harness.parse(JSON.stringify(unrelated))), unrelated);
});

await test("Known to newly observed FCDN to known playback routing stays fully patched without host failures", async () => {
  // On 2026-10-04 the reported small channel supplied this fourth exact host.
  // Both HLS/LLHLS passed the public/free/live descriptor guards; only the prior
  // host allowlist rejected them. URLs here are synthetic and contain no tokens.
  const harness = createHarness();
  const hosts = ["nvelop-livecloud.pstatic.net", "fcdn-livecloud.pstatic.net", "livecloud.pstatic.net"];
  for (const [index, hostname] of hosts.entries()) {
    const descriptor = structuredClone(playbackDescriptor);
    const expected = structuredClone(expectedPlaybackDescriptor);
    for (const value of [descriptor, expected]) {
      for (const media of value.media) {
        media.path = media.path.replace("nvelop-livecloud.pstatic.net", hostname);
        media.encodingTrack[0].path = media.encodingTrack[0].path.replace("nvelop-livecloud.pstatic.net", hostname);
      }
    }
    assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), expected, hostname);
    const stats = await diagnostics(harness);
    assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({ candidates: index + 1, fullyPatched: index + 1 }));
    assert.equal(stats.counts.publicPlaybacks, index + 1);
    assert.doesNotMatch(harness.diagnosticText(), /fcdn-livecloud|pstatic|https?:/);
  }
});

await test("Playback checks distinguish rejected descriptors and entitlements without changing them", async () => {
  const invalidDescriptors = [envelope({ livePlaybackJson: playbackDescriptor })];
  for (const update of [
    (value) => { value.serviceMeta.contentType = "AUDIO"; },
    (value) => { value.live.status = "ENDED"; },
    (value) => { value.media = {}; value.p2pPath = "fixture-marker-retained"; },
    (value) => { delete value.serviceMeta; },
  ]) {
    const value = structuredClone(playbackDescriptor);
    update(value);
    invalidDescriptors.push(value);
  }
  for (const value of invalidDescriptors) {
    const harness = createHarness();
    assert.deepEqual(normalized(harness.parse(JSON.stringify(value))), value);
    const stats = await diagnostics(harness);
    assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({ candidates: 1, descriptorRejected: 1 }));
    assert.equal(stats.counts.publicPlaybacks, 0);
  }
  for (const [key, value] of [
    ["paidLive", undefined], ["paidLive", null], ["paidLive", true], ["paidLive", "false"],
    ["playbackAuthType", null], ["playbackAuthType", "LOGIN"],
    ["playbackAuthType", "AGE_VERIFICATION"], ["playbackAuthType", "SUBSCRIPTION"],
    ["playbackAuthType", "UNKNOWN"],
  ]) {
    const descriptor = structuredClone(playbackDescriptor);
    if (value === undefined) delete descriptor.meta[key];
    else descriptor.meta[key] = value;
    const harness = createHarness();
    assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), descriptor);
    const stats = await diagnostics(harness);
    assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({ candidates: 1, entitlementRejected: 1 }), `${key}:${value}`);
    assert.equal(stats.counts.publicPlaybacks, 0);
  }
  const missingAuth = structuredClone(playbackDescriptor);
  delete missingAuth.meta.playbackAuthType;
  const harness = createHarness();
  assert.deepEqual(normalized(harness.parse(JSON.stringify(missingAuth))), missingAuth);
  assert.deepEqual((await diagnostics(harness)).playbackChecks, expectedPlaybackChecks(), "missing raw auth marker is outside the candidate prefilter");
});

await test("Mixed playback media preserve rejected siblings and report partial patches once per reason", async () => {
  const known = structuredClone(playbackDescriptor.media[0]);
  const expectedKnown = structuredClone(expectedPlaybackDescriptor.media[0]);
  const unknown = structuredClone(playbackDescriptor.media[1]);
  unknown.path = "https://unobserved-cdn.example/fixture/live.m3u8?private-fixture-query-never-publish";
  for (const reversed of [false, true]) {
    const harness = createHarness();
    const descriptor = structuredClone(playbackDescriptor);
    descriptor.media = reversed ? [unknown, known] : [known, unknown];
    const expected = structuredClone(descriptor);
    expected.media[reversed ? 1 : 0] = expectedKnown;
    assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), expected);
    const stats = await diagnostics(harness);
    assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({ candidates: 1, mediaHostRejected: 1, partiallyPatched: 1 }));
    assert.equal(stats.counts.publicPlaybacks, 1);
    assert.doesNotMatch(harness.diagnosticText(), /unobserved-cdn|private-fixture|https?:/);
  }
  const insecure = structuredClone(unknown);
  insecure.path = "http://nvelop-livecloud.pstatic.net/fixture/live.m3u8";
  const malformed = structuredClone(known);
  malformed.encodingTrack = null;
  const descriptor = structuredClone(playbackDescriptor);
  descriptor.media = [null, malformed, known, unknown, structuredClone(unknown), insecure, structuredClone(insecure)];
  const expected = structuredClone(descriptor);
  expected.media[2] = expectedKnown;
  const harness = createHarness();
  assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), expected);
  const stats = await diagnostics(harness);
  assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({
    candidates: 1, mediaShapeRejected: 1, mediaUrlRejected: 1, mediaHostRejected: 1, partiallyPatched: 1,
  }), "each media rejection category counts once per descriptor, not once per sibling");
  assert.equal(stats.counts.publicPlaybacks, 1);
  const unchanged = structuredClone(playbackDescriptor);
  unchanged.media = [expectedKnown, unknown];
  const unchangedHarness = createHarness();
  assert.deepEqual(normalized(unchangedHarness.parse(JSON.stringify(unchanged))), unchanged);
  const unchangedStats = await diagnostics(unchangedHarness);
  assert.deepEqual(unchangedStats.playbackChecks, expectedPlaybackChecks({ candidates: 1, mediaHostRejected: 1, noP2pPaths: 1 }));
  assert.equal(unchangedStats.counts.publicPlaybacks, 0, "an already P2P-free known branch cannot mask an unmodified unknown sibling as success");
});

await test("Playback checks separate malformed URLs, unknown hosts, unchanged P2P values and full patches", async () => {
  for (const [path, reason] of [
    ["not a URL", "mediaUrlRejected"],
    ["http://nvelop-livecloud.pstatic.net/fixture/live.m3u8", "mediaUrlRejected"],
    ["https://nvelop-livecloud.pstatic.net:444/fixture/live.m3u8", "mediaUrlRejected"],
    ["https://user@nvelop-livecloud.pstatic.net/fixture/live.m3u8", "mediaUrlRejected"],
    ["https://user:secret@nvelop-livecloud.pstatic.net/fixture/live.m3u8", "mediaUrlRejected"],
    ["https://nvelop-livecloud.pstatic.net/fixture/live.mp4", "mediaUrlRejected"],
    ["http://fcdn-livecloud.pstatic.net/fixture/live.m3u8", "mediaUrlRejected"],
    ["https://fcdn-livecloud.pstatic.net:444/fixture/live.m3u8", "mediaUrlRejected"],
    ["https://user@fcdn-livecloud.pstatic.net/fixture/live.m3u8", "mediaUrlRejected"],
    ["https://user:secret@fcdn-livecloud.pstatic.net/fixture/live.m3u8", "mediaUrlRejected"],
    ["https://fcdn-livecloud.pstatic.net.evil.example/fixture/live.m3u8", "mediaHostRejected"],
    ["https://unknown.example/fixture/live.m3u8", "mediaHostRejected"],
  ]) {
    const harness = createHarness();
    const descriptor = structuredClone(playbackDescriptor);
    for (const media of descriptor.media) media.path = path;
    assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), descriptor);
    const stats = await diagnostics(harness);
    assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({ candidates: 1, [reason]: 1 }), path);
    assert.equal(stats.counts.publicPlaybacks, 0);
  }
  const harness = createHarness();
  const unchanged = structuredClone(expectedPlaybackDescriptor);
  unchanged.media[0].p2pPath = null;
  unchanged.media[0].p2pPathUrlEncoding = false;
  unchanged.media[1].encodingTrack.at(-1).p2pPath = { preserve: true };
  unchanged.media[1].encodingTrack.at(-1).p2pPathUrlEncoding = 123;
  assert.deepEqual(normalized(harness.parse(JSON.stringify(unchanged))), unchanged);
  let stats = await diagnostics(harness);
  assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({ candidates: 1, noP2pPaths: 1 }));
  assert.equal(stats.counts.publicPlaybacks, 0);
  const descriptor = structuredClone(playbackDescriptor);
  descriptor.media[1].path = "https://livecloud.pstatic.net/fixture/playlist.m3u8?private-fixture-token-never-publish";
  const expected = structuredClone(expectedPlaybackDescriptor);
  expected.media[1].path = descriptor.media[1].path;
  assert.deepEqual(normalized(harness.parse(JSON.stringify(descriptor))), expected);
  stats = await diagnostics(harness);
  assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({ candidates: 2, noP2pPaths: 1, fullyPatched: 1 }));
  assert.equal(stats.counts.publicPlaybacks, 1);
  assert.doesNotMatch(harness.diagnosticText(), /private-fixture|https?:|pstatic/);
});

await test("Playback check counters skip OFF, revivers, invalid JSON and absent raw markers", async () => {
  const harness = createHarness();
  const text = JSON.stringify(playbackDescriptor);
  harness.setFilteringState("off");
  assert.deepEqual(normalized(harness.parse(text)), playbackDescriptor);
  harness.setFilteringState("on");
  assert.deepEqual(normalized(harness.parse(text, (key, value) => value)), playbackDescriptor);
  assert.deepEqual(normalized(harness.parse(text, null)), playbackDescriptor);
  assert.throws(() => harness.parse('{"p2pPath":"x","playbackAuthType":"NONE",'), { name: "SyntaxError" });
  assert.deepEqual(normalized(harness.parse(JSON.stringify(expectedPlaybackDescriptor))), expectedPlaybackDescriptor);
  assert.deepEqual((await diagnostics(harness)).playbackChecks, expectedPlaybackChecks());
  assert.deepEqual(normalized(harness.parse(text, undefined)), expectedPlaybackDescriptor);
  const stats = await diagnostics(harness);
  assert.deepEqual(stats.playbackChecks, expectedPlaybackChecks({ candidates: 1, fullyPatched: 1 }));
  assert.equal(stats.counts.publicPlaybacks, 1);
});

await test("JSON.parse retains native reviver/errors, realm isolation, idempotence and OFF behavior", () => {
  const harness = createHarness();
  const text = JSON.stringify(playbackDescriptor);
  const patchedParse = harness.currentParse();
  harness.install();
  assert.equal(harness.currentParse(), patchedParse);
  assert.deepEqual(JSON.parse(text), playbackDescriptor, "the test host JSON.parse must remain native");
  const visits = [];
  const revived = harness.parse(text, function (key, value) {
    visits.push(key);
    return key === "liveId" ? 123456 : value;
  });
  const expected = structuredClone(playbackDescriptor);
  expected.meta.liveId = 123456;
  assert.deepEqual(normalized(revived), expected);
  assert.equal(visits.at(-1), "");
  assert.throws(() => harness.parse("{"), { name: "SyntaxError" });
  const error = new Error("reviver must propagate");
  assert.throws(() => harness.parse(text, () => { throw error; }), (caught) => caught === error);
  harness.setFilteringState("off");
  assert.deepEqual(normalized(harness.parse(text)), playbackDescriptor);
  harness.setFilteringState("on");
  assert.deepEqual(normalized(harness.parse(text)), expectedPlaybackDescriptor);
});

await test("Real AES-GCM ciphertext decrypts normally and changes only the exact tunnel ad policy", async () => {
  const harness = createHarness();
  harness.setCryptoBackend(webcrypto.subtle);
  // Disposable deterministic fixture key/IV; never site credentials or traffic.
  const key = await webcrypto.subtle.importKey("raw", new Uint8Array(16).fill(17), "AES-GCM", false, ["encrypt", "decrypt"]);
  const algorithm = tunnelAlgorithm();
  const ciphertext = await webcrypto.subtle.encrypt(algorithm, key, encodedBuffer(tunnelPolicy));
  const decrypted = await harness.context.crypto.subtle.decrypt(algorithm, key, ciphertext);
  assert.deepEqual(decodedBuffer(decrypted), expectedTunnelPolicy);
  assert.deepEqual(decodedBuffer(await webcrypto.subtle.decrypt(algorithm, key, ciphertext)), tunnelPolicy);
  assert.equal(harness.decryptCalls[0].args[0], algorithm);
  assert.equal(harness.decryptCalls[0].args[1], key);
  assert.equal(harness.decryptCalls[0].args[2], ciphertext);
  assert.equal(harness.decryptCalls[0].receiver, harness.context.crypto.subtle);
  const corrupted = new Uint8Array(ciphertext.slice(0));
  corrupted[0] ^= 1;
  await assert.rejects(harness.context.crypto.subtle.decrypt(algorithm, key, corrupted), { name: "OperationError" });
});

await test("Tunnel AAD matching is exact, supports BufferSource offsets and leaves other algorithms untouched", async () => {
  const harness = createHarness();
  const original = encodedBuffer(tunnelPolicy);
  const wrongPrefix = tunnelAad.slice();
  wrongPrefix[2] ^= 1;
  const wrongLengthBytes = tunnelAad.slice();
  wrongLengthBytes[1] = 21;
  const algorithms = [
    "AES-GCM", { name: "AES-CBC", additionalData: tunnelAad }, { name: "aes-gcm", additionalData: tunnelAad },
    { name: "AES-GCM" }, tunnelAlgorithm(wrongPrefix), tunnelAlgorithm(wrongLengthBytes),
    tunnelAlgorithm(tunnelAad.slice(0, -1)), tunnelAlgorithm(new Uint8Array([...tunnelAad, 1])),
    tunnelAlgorithm(new TextEncoder().encode("gfp-tunnel-response-v1")), tunnelAlgorithm("not a BufferSource"),
  ];
  let getterCalls = 0;
  const getterAlgorithm = { name: "AES-GCM" };
  Object.defineProperty(getterAlgorithm, "additionalData", { get() { getterCalls += 1; return tunnelAad; } });
  algorithms.push(getterAlgorithm);
  for (const algorithm of algorithms) {
    harness.setDecryptResult(original);
    const operation = harness.context.crypto.subtle.decrypt(algorithm, {}, new Uint8Array());
    assert.equal(operation, harness.decryptCalls.at(-1).operation, "nonmatching calls retain the native promise");
    assert.equal(await operation, original);
  }
  assert.equal(getterCalls, 0, "classification must not invoke user algorithm accessors");
  const padded = new Uint8Array(56).fill(255);
  padded.set(tunnelAad, 7);
  for (const aad of [tunnelAad.buffer.slice(0), new Uint8Array(padded.buffer, 7, 40), new DataView(padded.buffer, 7, 40)]) {
    harness.setDecryptResult(original);
    assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(aad), {}, new Uint8Array())), expectedTunnelPolicy);
  }
});

await test("Unknown/auth/error/real-ID tunnel JSON and false/false policies preserve the original buffer", async () => {
  const harness = createHarness();
  const payloads = [null, [], true, 123, "value", expectedTunnelPolicy];
  for (const [key, value] of [["code", 403], ["code", "200"], ["message", "Authentication required"], ["auth", "paid"]]) {
    const payload = structuredClone(tunnelPolicy);
    payload[key] = value;
    payloads.push(payload);
  }
  for (const policy of [
    { liveId: 987654, chatChannelId: "real-chat-id" }, { liveId: true, chatChannelId: "real-chat-id" },
    { liveId: "true", chatChannelId: "true" }, { liveId: 1, chatChannelId: 1 },
    { liveId: null, chatChannelId: null }, { liveId: true },
    { liveId: true, chatChannelId: true, authorization: "must remain" },
  ]) payloads.push({ code: 200, message: null, content: { livePlaybackJson: policy } });
  payloads.push(
    { code: 200, content: tunnelPolicy.content },
    { ...tunnelPolicy, content: { ...tunnelPolicy.content, entitlement: "paid" } },
    { code: 200, message: null, content: { livePlaybackJson: JSON.stringify(tunnelPolicy.content.livePlaybackJson) } },
    { code: 200, message: null, content: { livePlaybackJson: playbackDescriptor } },
  );
  for (const payload of payloads) {
    const original = encodedBuffer(JSON.stringify(payload));
    harness.setDecryptResult(original);
    assert.equal(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array()), original);
  }
  for (const policy of [{ liveId: true, chatChannelId: false }, { liveId: false, chatChannelId: true }]) {
    harness.setDecryptResult(encodedBuffer({ code: 200, message: null, content: { livePlaybackJson: policy } }));
    assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array())), expectedTunnelPolicy);
  }
});

await test("Malformed, binary, empty and oversized decrypted payloads are not decoded or rewritten", async () => {
  const harness = createHarness();
  const originalValues = [
    new ArrayBuffer(0), new Uint8Array([0xff, 0xfe, 0x80]).buffer,
    encodedBuffer("{"), encodedBuffer("not JSON"),
    encodedBuffer(`${" ".repeat(65536)}${JSON.stringify(tunnelPolicy)}`),
  ];
  for (const original of originalValues) {
    harness.setDecryptResult(original);
    assert.equal(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array()), original);
  }
});

await test("Tunnel hooks are idempotent, keep native rejections, and respect OFF before and during decrypt", async () => {
  const harness = createHarness();
  const decrypt = harness.context.crypto.subtle.decrypt;
  harness.install();
  assert.equal(harness.context.crypto.subtle.decrypt, decrypt);
  const failure = new DOMException("fixture native rejection", "OperationError");
  harness.setDecryptError(failure);
  await assert.rejects(harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array()), (error) => error === failure);
  const original = encodedBuffer(tunnelPolicy);
  harness.setFilteringState("off");
  harness.setDecryptResult(original);
  const initiallyOff = harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array());
  assert.equal(initiallyOff, harness.decryptCalls.at(-1).operation);
  assert.equal(await initiallyOff, original);
  harness.setFilteringState("on");
  let release;
  harness.setDecryptResult(new Promise((resolve) => { release = resolve; }));
  const pending = harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array());
  harness.setFilteringState("off");
  release(original);
  assert.equal(await pending, original);
  harness.setFilteringState("on");
  harness.setDecryptResult(original);
  assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array())), expectedTunnelPolicy);
  for (const hostname of ["vod.sooplive.com", "www.youtube.com", "chzzk.naver.com.evil.example"]) {
    const other = createHarness({ hostname });
    assert.equal(other.context.crypto.subtle.decrypt, other.nativeDecrypt);
  }
});

await test("Recognized SSP video waterfalls remove only the ads queue and preserve every metadata field", async () => {
  const harness = createHarness();
  const candidates = [
    waterfallPayload.ads, waterfallPayload.ads.slice(0, 1), waterfallPayload.ads.slice(1),
    ...sdkMinimalWaterfallAds.map((ad) => [ad]), sdkMinimalWaterfallAds,
  ];
  for (const ads of candidates) {
    const payload = { ...structuredClone(waterfallPayload), ads };
    const original = encodedBuffer(payload);
    harness.setDecryptResult(original);
    const result = await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array());
    assert.notEqual(result, original);
    assert.deepEqual(decodedBuffer(result), { ...payload, ads: [] });
    assert.deepEqual(decodedBuffer(original), payload);
  }
  const stats = await diagnostics(harness, (value) => value.counts.waterfalls === candidates.length);
  assert.equal(stats.counts.adPolicies, 0);
  harness.setDecryptResult(encodedBuffer(tunnelPolicy));
  assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array())), expectedTunnelPolicy);
  assert.equal((await diagnostics(harness, (value) => value.counts.adPolicies === 1)).counts.waterfalls, candidates.length);
});

await test("Unrecognized, empty, authenticated, error and schema-changed ad lists retain buffer identity", async () => {
  const harness = createHarness();
  const payloads = [
    { ads: waterfallPayload.ads }, expectedWaterfallPayload,
    { ...waterfallPayload, auth: { requiresLogin: true } },
    { ...waterfallPayload, code: 403 },
    { code: 200, message: null, content: { ads: waterfallPayload.ads } },
  ];
  for (const value of [
    { version: "0.0.2", description: "Naver SSP Waterfall List" },
    { version: "0.0.1", description: "Another video list" },
    { version: "0.0.1", description: "Naver SSP Waterfall List", error: "AUTH_REQUIRED" },
    null, [], "Naver SSP Waterfall List",
  ]) payloads.push({ ...structuredClone(waterfallPayload), head: value });
  for (const key of Object.keys(waterfallPayload)) {
    const missing = structuredClone(waterfallPayload);
    delete missing[key];
    payloads.push(missing);
  }
  for (const [key, value] of [
    ["requestId", 123], ["eventTracking", []], ["adUnit", false], ["randomNumber", "123"],
    ["adDivId", {}], ["videoSkipMin", "5"], ["videoSkipAfter", null], ["ads", {}],
  ]) payloads.push({ ...structuredClone(waterfallPayload), [key]: value });
  for (const [key, value] of [
    ["renderType", "UNKNOWN_PROVIDER"], ["creativeType", "DISPLAY"], ["creativeType", "BANNER"],
    ["adInfo", null], ["adInfo", []], ["adInfo", "unknown"],
  ]) {
    const payload = structuredClone(waterfallPayload);
    payload.ads[0][key] = value;
    payloads.push(payload);
  }
  payloads.push({ ...structuredClone(waterfallPayload), ads: [null] });
  for (const payload of payloads) {
    const original = encodedBuffer(payload);
    harness.setDecryptResult(original);
    assert.equal(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array()), original);
  }
  assert.equal((await diagnostics(harness)).counts.waterfalls, 0);
});

await test("Native encrypted SSP waterfall handling respects AAD, size and OFF in-flight boundaries", async () => {
  const harness = createHarness();
  harness.setCryptoBackend(webcrypto.subtle);
  const key = await webcrypto.subtle.importKey("raw", new Uint8Array(16).fill(23), "AES-GCM", false, ["encrypt", "decrypt"]);
  const algorithm = tunnelAlgorithm();
  const ciphertext = await webcrypto.subtle.encrypt(algorithm, key, encodedBuffer(waterfallPayload));
  assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(algorithm, key, ciphertext)), expectedWaterfallPayload);
  const minimalMixed = { ...structuredClone(waterfallPayload), ads: sdkMinimalWaterfallAds };
  const mixedCiphertext = await webcrypto.subtle.encrypt(algorithm, key, encodedBuffer(minimalMixed));
  assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(algorithm, key, mixedCiphertext)), expectedWaterfallPayload);
  harness.setFilteringState("off");
  assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(algorithm, key, ciphertext)), waterfallPayload);
  harness.setFilteringState("on");
  const original = encodedBuffer(waterfallPayload);
  const wrongAad = tunnelAad.slice();
  wrongAad[3] ^= 1;
  harness.setDecryptResult(original);
  assert.equal(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(wrongAad), {}, new Uint8Array()), original);
  const oversized = encodedBuffer(`${" ".repeat(65536)}${JSON.stringify(waterfallPayload)}`);
  harness.setDecryptResult(oversized);
  assert.equal(await harness.context.crypto.subtle.decrypt(algorithm, {}, new Uint8Array()), oversized);
  let release;
  harness.setDecryptResult(new Promise((resolve) => { release = resolve; }));
  const pending = harness.context.crypto.subtle.decrypt(algorithm, {}, new Uint8Array());
  harness.setFilteringState("off");
  release(original);
  assert.equal(await pending, original);
  harness.setFilteringState("on");
  harness.setDecryptResult(original);
  assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(algorithm, {}, new Uint8Array())), expectedWaterfallPayload);
  const stats = await diagnostics(harness, (value) => value.counts.waterfalls === 3);
  assert.equal(stats.counts.adPolicies, 0);
});

await test("DOM diagnostics identify the executed revision and verify real hook installation", async () => {
  const harness = createHarness();
  const initial = await diagnostics(harness);
  assert.equal(initial.schema, 2);
  assert.equal(initial.revision, "1.9.3");
  assert.deepEqual(initial.installed, { xhr: true, fetch: true, parser: true, tunnel: true });
  assert.deepEqual(initial.active, initial.installed);
  for (const value of Object.values(initial.counts)) assert.equal(value, 0);
  assert.deepEqual(initial.playbackChecks, expectedPlaybackChecks());
  const serialized = harness.diagnosticText();
  harness.install();
  assert.equal(harness.diagnosticText(), serialized, "repeat injection must not reset document diagnostics");
  harness.context.fetch = harness.nativeFetch;
  harness.setFilteringState("off");
  const replaced = await diagnostics(harness, (value) => value.active.fetch === false);
  assert.equal(replaced.installed.fetch, true, "successful installation and later overwrite are distinct");

  const locked = createHarness({ lockedHooks: ["fetch", "xhr", "jsonParse", "decrypt"] });
  const failed = await diagnostics(locked);
  assert.equal(locked.context[Symbol.for("lae.chzzk.response.v2")], true);
  assert.deepEqual(failed.installed, { xhr: false, fetch: false, parser: false, tunnel: false });
  assert.deepEqual(failed.active, failed.installed);
  assert.equal(locked.context.fetch, locked.nativeFetch);
  assert.equal(locked.context.crypto.subtle.decrypt, locked.nativeDecrypt);
  assert.equal(locked.currentParse(), locked.nativeParse);
});

await test("Diagnostics survive document_start without a root and count only completed changes", async () => {
  const harness = createHarness({ rootAvailable: false });
  assert.equal(harness.diagnosticText(), null);
  harness.setDecryptResult(encodedBuffer(tunnelPolicy));
  assert.deepEqual(decodedBuffer(await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array())), expectedTunnelPolicy);
  harness.showRoot();
  const first = await diagnostics(harness, (value) => value.counts.adPolicies === 1);
  assert.equal(first.installed.tunnel, true);
  harness.parse(JSON.stringify(playbackDescriptor));
  const xhr = harness.xhr();
  xhr.complete(fixtureText);
  assert.deepEqual(JSON.parse(xhr.responseText), expectedPayload);
  const changed = await diagnostics(harness, (value) => value.counts.publicPlaybacks >= 1 && value.counts.apiPatches >= 1);
  harness.setFilteringState("off");
  harness.parse(JSON.stringify(playbackDescriptor));
  harness.setDecryptResult(encodedBuffer(tunnelPolicy));
  await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array());
  const afterOff = await diagnostics(harness);
  assert.deepEqual(afterOff.counts, changed.counts);
  assert.deepEqual(afterOff.playbackChecks, changed.playbackChecks);
  harness.setFilteringState("on");
  harness.setDecryptResult(encodedBuffer(expectedTunnelPolicy));
  await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), {}, new Uint8Array());
  assert.deepEqual((await diagnostics(harness)).counts, changed.counts, "already-disabled policy is not a patch");
});

await test("Diagnostic DOM contains fixed booleans and bounded counts, never response or credential data", async () => {
  const harness = createHarness();
  const sensitive = structuredClone(fixturePayload);
  sensitive.content.token = "private-fixture-token-never-publish";
  sensitive.content.cookie = "private-fixture-cookie-never-publish";
  sensitive.content.liveTitle = "private-fixture-title-never-publish";
  const xhr = harness.xhr(`${detailUrl}?signed=private-fixture-query-never-publish`);
  xhr.complete(JSON.stringify(sensitive));
  void xhr.responseText;
  harness.setDecryptResult(encodedBuffer(tunnelPolicy));
  await harness.context.crypto.subtle.decrypt(tunnelAlgorithm(), { keyMaterial: "private-fixture-key-never-publish" }, new Uint8Array([37, 48, 59]));
  const value = await diagnostics(harness, (result) => result.counts.apiPatches >= 1 && result.counts.adPolicies >= 1);
  assert.deepEqual(Object.keys(value).sort(), ["active", "counts", "installed", "playbackChecks", "revision", "schema"]);
  for (const flags of [value.installed, value.active]) {
    assert.deepEqual(Object.keys(flags).sort(), ["fetch", "parser", "tunnel", "xhr"]);
    for (const flag of Object.values(flags)) assert.equal(typeof flag, "boolean");
  }
  for (const count of Object.values(value.counts)) assert.ok(Number.isInteger(count) && count >= 0 && count <= 1000000);
  assert.deepEqual(Object.keys(value.playbackChecks).sort(), [...playbackCheckNames].sort());
  for (const count of Object.values(value.playbackChecks)) assert.ok(Number.isInteger(count) && count >= 0 && count <= 1000000);
  assert.doesNotMatch(harness.diagnosticText(), /private-fixture|https?:|api\.chzzk|gfp-tunnel|liveId|chatChannelId|token|cookie|keyMaterial/i);
  for (const hostname of ["vod.sooplive.com", "www.youtube.com", "chzzk.naver.com.evil.example"]) {
    const unrelated = createHarness({ hostname });
    assert.equal(unrelated.diagnosticText(), null);
  }
});

async function chromeIntegration() {
  const { chromium } = require("playwright");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const profileDirectory = fs.mkdtempSync(path.join(temporaryRoot, "light-adblock-chzzk-check-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: false,
      args: [`--disable-extensions-except=${rootDirectory}`, `--load-extension=${rootDirectory}`, "--window-position=-32000,-32000", "--window-size=800,600"],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 15000 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    // All requests are fulfilled locally. No account, broadcast or real ad is used.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === fixtureUrl) {
        await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><script>
window.__runChzzkFixture = async () => {
  const detail = ${JSON.stringify(detailUrl)};
  const xhrData = (responseType) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', detail + '?fixture=' + responseType);
    xhr.responseType = responseType;
    xhr.onload = () => resolve(responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText));
    xhr.onerror = reject;
    xhr.send();
  });
  const [xhrText, xhrJson, fetched, ads, other] = await Promise.all([
    xhrData('text'), xhrData('json'), fetch(detail).then(r => r.json()),
    fetch(${JSON.stringify(adUrl)}).then(r => r.json()), fetch(detail + '/other').then(r => r.json()),
  ]);
  const decoded = JSON.parse(${JSON.stringify(JSON.stringify(playbackDescriptor))});
  const key = await crypto.subtle.importKey('raw', new Uint8Array(16).fill(17), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const algorithm = { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128, additionalData: new Uint8Array(${JSON.stringify([...tunnelAad])}) };
  const ciphertext = await crypto.subtle.encrypt(algorithm, key, new TextEncoder().encode(${JSON.stringify(JSON.stringify(tunnelPolicy))}));
  const decrypted = await crypto.subtle.decrypt(algorithm, key, ciphertext);
  const tunnel = JSON.parse(new TextDecoder().decode(decrypted));
  const waterfallCiphertext = await crypto.subtle.encrypt(algorithm, key, new TextEncoder().encode(${JSON.stringify(JSON.stringify(waterfallPayload))}));
  const waterfall = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(algorithm, key, waterfallCiphertext)));
  const minimalWaterfallCiphertext = await crypto.subtle.encrypt(algorithm, key, new TextEncoder().encode(${JSON.stringify(JSON.stringify({ ...waterfallPayload, ads: sdkMinimalWaterfallAds }))}));
  const minimalWaterfall = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(algorithm, key, minimalWaterfallCiphertext)));
  const diagnosticsText = document.documentElement.getAttribute('data-lae-chzzk-diagnostics');
  const diagnostics = diagnosticsText ? JSON.parse(diagnosticsText) : null;
  return { xhrText, xhrJson, fetched, ads, other, decoded, tunnel, waterfall, minimalWaterfall, diagnostics };
};
window.__chzzkFixture = window.__runChzzkFixture();
</script></head><body>Offline Chzzk integration fixture</body></html>` });
      } else if (url.hostname === "api.chzzk.naver.com") {
        await route.fulfill({ status: 200, contentType: "application/json", headers: {
          "access-control-allow-origin": "https://chzzk.naver.com", "access-control-allow-methods": "GET,POST,OPTIONS",
        }, body: JSON.stringify(url.pathname.endsWith("/seoraksan") ? directAdPayload : fixturePayload) });
      } else await route.abort();
    });
    async function syncSettings(settings) {
      await worker.evaluate(async (value) => {
        await chrome.storage.local.set(value);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const scripts = await chrome.scripting.getRegisteredContentScripts();
          const script = scripts.find((item) => item.js?.includes("sites/chzzk.js"));
          const excluded = value.disabledSites.includes("chzzk.naver.com");
          if (value.enabled ? script && script.world === "MAIN" && script.runAt === "document_start" &&
            Boolean(script.excludeMatches?.includes("https://chzzk.naver.com/*")) === excluded : !script) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Chzzk registration did not synchronize");
      }, settings);
    }
    function assertResults(result, enabled) {
      for (const key of ["xhrText", "xhrJson", "fetched"]) assert.deepEqual(result[key], enabled ? expectedPayload : fixturePayload, key);
      assert.deepEqual(result.ads, enabled ? expectedAdPayload : directAdPayload);
      assert.deepEqual(result.other, fixturePayload);
      assert.deepEqual(result.decoded, enabled ? expectedPlaybackDescriptor : playbackDescriptor);
      assert.deepEqual(result.tunnel, enabled ? expectedTunnelPolicy : tunnelPolicy);
      assert.deepEqual(result.waterfall, enabled ? expectedWaterfallPayload : waterfallPayload);
      assert.deepEqual(result.minimalWaterfall, enabled ? expectedWaterfallPayload : { ...waterfallPayload, ads: sdkMinimalWaterfallAds });
      if (enabled) {
        assert.equal(result.diagnostics.schema, 2);
        assert.equal(result.diagnostics.revision, "1.9.3");
        assert.deepEqual(result.diagnostics.installed, { xhr: true, fetch: true, parser: true, tunnel: true });
        assert.deepEqual(result.diagnostics.active, result.diagnostics.installed);
        for (const name of ["apiPatches", "publicPlaybacks", "adPolicies", "waterfalls"]) assert.ok(result.diagnostics.counts[name] >= 1);
        assert.deepEqual(Object.keys(result.diagnostics.playbackChecks).sort(), [...playbackCheckNames].sort());
        assert.ok(result.diagnostics.playbackChecks.candidates >= 1);
        assert.ok(result.diagnostics.playbackChecks.fullyPatched >= 1);
        for (const count of Object.values(result.diagnostics.playbackChecks)) assert.ok(Number.isInteger(count) && count >= 0 && count <= 1000000);
      }
    }
    await syncSettings({ enabled: true, disabledSites: [] });
    await page.goto(fixtureUrl, { waitUntil: "load" });
    assertResults(await page.evaluate(() => window.__chzzkFixture), true);
    for (const [settings, expectedEnabled] of [
      [{ enabled: true, disabledSites: ["chzzk.naver.com"] }, false],
      [{ enabled: true, disabledSites: [] }, true],
      [{ enabled: false, disabledSites: [] }, false],
      [{ enabled: true, disabledSites: [] }, true],
    ]) {
      await syncSettings(settings);
      await page.waitForFunction((state) => document.documentElement.getAttribute("data-lae-player") === state, expectedEnabled ? "on" : "off");
      assertResults(await page.evaluate(() => window.__runChzzkFixture()), expectedEnabled);
    }
    for (const settings of [{ enabled: true, disabledSites: ["chzzk.naver.com"] }, { enabled: false, disabledSites: [] }]) {
      await syncSettings(settings);
      await page.reload({ waitUntil: "load" });
      assertResults(await page.evaluate(() => window.__chzzkFixture), false);
    }
    await syncSettings({ enabled: true, disabledSites: [] });
    await page.reload({ waitUntil: "load" });
    assertResults(await page.evaluate(() => window.__chzzkFixture), true);
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  } finally {
    await context?.close();
    const resolved = path.resolve(profileDirectory);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith("light-adblock-chzzk-check-")) {
      throw new Error("Refusing to remove an unexpected temporary profile path");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (process.argv.includes("--chrome")) await test("Installed Chromium extension: native XHR/fetch, document_start, and existing-document OFF/ON", chromeIntegration);
console.log(`Chzzk 검사 완료: ${passed}개 그룹 통과${process.argv.includes("--chrome") ? " (Chromium 포함)" : " (--chrome으로 실제 확장 통합 검사 추가)"}`);
