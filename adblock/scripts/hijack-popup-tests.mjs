import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// No target-site access: the default tests run the actual popup script in a VM.
// --chrome additionally renders local popup files with a mocked Chrome API.
// Every browser request is fulfilled locally or aborted; external DNS is disabled.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");
const fixtureHost = "video.example";
const selectors = [
  "status-card", "status-label", "status-title", "status-description", "blocked-count",
  "global-toggle", "site-toggle", "site-name", "hijack-toggle", "hijack-strict-toggle",
  "hijack-summary", "hijack-reasons", "hijack-allow-once", "hijack-restore",
];
let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

class FakeElement {
  constructor() {
    this.checked = false;
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
    this.attributes = new Map();
    this.focusCount = 0;
    const classes = new Set();
    this.classList = {
      toggle(name, active) { active ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
    };
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  closest(selector) { return selector === ".control-row" ? this.row : null; }
  focus() { this.focusCount += 1; }
}

async function settle() {
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve));
}

async function harness({ tabUrl = `https://${fixtureHost}/page`, settings = {}, responseOverride } = {}) {
  const elements = Object.fromEntries(selectors.map(id => [id, new FakeElement()]));
  for (const id of ["global-toggle", "site-toggle", "hijack-toggle", "hijack-strict-toggle"]) {
    elements[id].row = new FakeElement();
  }
  const mock = {
    settings: { enabled: true, disabledSites: [], hijackDisabledSites: [], hijackStrictSites: [], ...structuredClone(settings) },
    temporary: false, pageToken: "test-doc", reloads: [], writes: [], messages: [], intervals: [],
    failSets: 0, failStatuses: 0, failGetCall: -1, getCalls: 0,
    responseOverride, holdNextStatus: false, releaseHeld: null,
  };
  const status = () => mock.responseOverride ?? {
    ok: true,
    pageToken: mock.pageToken,
    active: mock.settings.enabled && !mock.settings.disabledSites.includes(fixtureHost) &&
      !mock.settings.hijackDisabledSites.includes(fixtureHost) && !mock.temporary,
    strict: mock.settings.hijackStrictSites.includes(fixtureHost),
    blockedCount: 3, overlayCount: 1, popupCount: 1, linkCount: 1,
    canAllowOnce: true, temporarilyAllowed: mock.temporary,
    reasonCodes: ["known-overlay", "ad-link", "strict-popup", "https://never-display.example/?token=private"],
  };
  const context = vm.createContext({
    URL, console,
    document: { querySelector(selector) { return elements[selector.slice(1)]; } },
    setInterval(callback) { mock.intervals.push(callback); return mock.intervals.length; },
    chrome: {
      storage: { local: {
        async get(defaults) {
          mock.getCalls += 1;
          if (mock.getCalls === mock.failGetCall) throw new Error("Synthetic read failure");
          return { ...defaults, ...structuredClone(mock.settings) };
        },
        async set(update) {
          mock.writes.push(structuredClone(update));
          if (mock.failSets > 0) { mock.failSets -= 1; throw new Error("Synthetic write failure"); }
          Object.assign(mock.settings, structuredClone(update));
        },
      } },
      runtime: { async sendMessage(message) {
        mock.messages.push(structuredClone(message));
        if (message.type === "sync-settings") return { ok: true };
        if (mock.failStatuses > 0) { mock.failStatuses -= 1; throw new Error("Synthetic receiver failure"); }
        if (["hijack-allow-once", "hijack-restore"].includes(message.type) &&
            message.expectedPageToken !== mock.pageToken) return { ok: false };
        if (message.type === "hijack-allow-once") mock.temporary = true;
        if (message.type === "hijack-restore") mock.temporary = false;
        if (mock.holdNextStatus && message.type === "hijack-status") {
          mock.holdNextStatus = false;
          const snapshot = structuredClone(status());
          return new Promise(resolve => { mock.releaseHeld = () => resolve(snapshot); });
        }
        return structuredClone(status());
      } },
      tabs: {
        async query() { return [{ id: 7, url: tabUrl }]; },
        async reload(tabId) { mock.reloads.push(tabId); },
        async sendMessage() { return { timeOrigin: 1 }; },
      },
      declarativeNetRequest: { async getMatchedRules() { return { rulesMatchedInfo: [] }; } },
    },
  });
  vm.runInContext(source, context, { filename: "popup/popup.js" });
  await settle();
  return {
    mock, elements,
    state() { return JSON.parse(vm.runInContext("JSON.stringify(state)", context)); },
    async toggle(id, checked) {
      const element = elements[id]; element.checked = checked;
      await element.listeners.get("change")({ currentTarget: element, target: element });
      await settle();
    },
    async click(id) { await elements[id].listeners.get("click")(); await settle(); },
    poll() { return mock.intervals[0](); },
  };
}

await test("Popup defaults to basic protection, keeps strict mode opt-in, and displays only fixed reason labels", async () => {
  const h = await harness();
  assert.equal(h.elements["hijack-toggle"].checked, true);
  assert.equal(h.elements["hijack-toggle"].disabled, false);
  assert.equal(h.elements["hijack-strict-toggle"].checked, false);
  assert.match(h.elements["hijack-reasons"].textContent, /확인된 클릭 덮개/);
  assert.doesNotMatch(h.elements["hijack-reasons"].textContent, /https:|private|token/);
  assert.equal(h.elements["hijack-allow-once"].disabled, false);
  assert.equal(h.elements["hijack-restore"].disabled, true);
});

await test("Independent site and strict settings preserve ad settings, other hosts, and the current tab", async () => {
  const h = await harness({ settings: { hijackDisabledSites: ["other.example"] } });
  await h.toggle("hijack-toggle", false);
  assert.deepEqual(h.mock.settings.hijackDisabledSites, ["other.example", fixtureHost]);
  assert.deepEqual(h.mock.settings.disabledSites, []);
  assert.equal(h.mock.settings.enabled, true);
  assert.equal(h.elements["hijack-strict-toggle"].disabled, true);
  await h.toggle("hijack-toggle", true);
  await h.toggle("hijack-strict-toggle", true);
  assert.deepEqual(h.mock.settings.hijackDisabledSites, ["other.example"]);
  assert.deepEqual(h.mock.settings.hijackStrictSites, [fixtureHost]);
  await h.toggle("hijack-strict-toggle", false);
  assert.deepEqual(h.mock.settings.hijackStrictSites, []);
  assert.deepEqual(h.mock.reloads, []);
  assert.ok(h.mock.writes.every(update => Object.keys(update).every(key => key.startsWith("hijack"))));
});

await test("Temporary page allowance and restore are reversible without persistent writes or automatic navigation", async () => {
  const h = await harness();
  await h.click("hijack-allow-once");
  assert.equal(h.mock.temporary, true);
  assert.match(h.elements["hijack-summary"].textContent, /이번 페이지에서 허용/);
  assert.equal(h.elements["hijack-strict-toggle"].disabled, true);
  assert.equal(h.elements["hijack-restore"].disabled, false);
  await h.click("hijack-restore");
  assert.equal(h.mock.temporary, false);
  assert.equal(h.elements["hijack-allow-once"].disabled, false);
  assert.deepEqual(h.mock.writes, []);
  assert.deepEqual(h.mock.reloads, []);
});

await test("Write or page-ack failure rolls back only the affected setting and reports the failure", async () => {
  for (const failStatus of [false, true]) {
    const h = await harness({ settings: { hijackStrictSites: ["other.example"] } });
    if (failStatus) h.mock.failStatuses = 1;
    else h.mock.failSets = 1;
    await h.toggle("hijack-toggle", false);
    assert.deepEqual(h.mock.settings.hijackDisabledSites, []);
    assert.deepEqual(h.mock.settings.hijackStrictSites, ["other.example"]);
    assert.deepEqual(h.mock.settings.disabledSites, []);
    assert.equal(h.mock.settings.enabled, true);
    assert.equal(h.elements["hijack-toggle"].checked, true);
    assert.match(h.elements["hijack-summary"].textContent, /이전 상태/);
    assert.ok(h.mock.writes.every(update => Object.keys(update).join() === "hijackDisabledSites"));
  }
});

await test("Rollback failures re-read actual settings or lock controls if the state cannot be established", async () => {
  for (const failRecoveryRead of [false, true]) {
    const h = await harness();
    h.mock.failSets = 2;
    if (failRecoveryRead) h.mock.failGetCall = h.mock.getCalls + 2;
    await h.toggle("hijack-toggle", false);
    assert.equal(h.elements["hijack-toggle"].disabled, failRecoveryRead);
    assert.match(h.elements["hijack-summary"].textContent, failRecoveryRead ? /확인할 수 없어요/ : /현재 저장된 설정/);
    assert.deepEqual(h.mock.settings.disabledSites, []);
    assert.equal(h.mock.settings.enabled, true);
  }
});

await test("Unsupported pages, master OFF, site OFF, and old receiver responses do not show active protection", async () => {
  for (const options of [
    { tabUrl: "chrome://settings" },
    { settings: { enabled: false } },
    { settings: { disabledSites: [fixtureHost] } },
    { responseOverride: { ok: true } },
    { responseOverride: { ok: true, active: true } },
    { responseOverride: { ok: false, active: true } },
  ]) {
    const h = await harness(options);
    assert.equal(h.elements["hijack-toggle"].disabled, true);
    assert.equal(h.elements["hijack-allow-once"].disabled, true);
    assert.equal(h.elements["hijack-restore"].disabled, true);
    assert.doesNotMatch(h.elements["hijack-summary"].textContent, /기본 보호 중/);
    if (options.tabUrl) assert.equal(h.mock.messages.some(message => message.type === "hijack-status"), false);
  }
});

await test("Invalid counters are bounded and malformed reasons never become page-supplied UI text", async () => {
  const h = await harness({ responseOverride: {
    ok: true, pageToken: "test-doc", active: true, blockedCount: Infinity, overlayCount: -5,
    popupCount: 2.8, linkCount: 99999999,
    reasonCodes: ["known-overlay", "known-overlay", "<img onerror=alert(1)>", "https://private.example/?secret=1"],
  } });
  const status = h.state().hijackStatus;
  assert.deepEqual([status.blockedCount, status.overlayCount, status.popupCount, status.linkCount], [0, 0, 2, 100000]);
  assert.deepEqual(status.reasonCodes, ["known-overlay"]);
  assert.doesNotMatch(h.elements["hijack-reasons"].textContent, /secret|https:|onerror/);
});

await test("Stale asynchronous status polling cannot overwrite a newer page allowance", async () => {
  const h = await harness();
  h.mock.holdNextStatus = true;
  const stalePoll = h.poll();
  await settle();
  assert.equal(typeof h.mock.releaseHeld, "function");
  await h.click("hijack-allow-once");
  h.mock.releaseHeld();
  await stalePoll;
  assert.equal(h.state().hijackStatus.temporarilyAllowed, true);
  assert.equal(h.elements["hijack-restore"].disabled, false);
  assert.match(h.elements["hijack-summary"].textContent, /이번 페이지에서 허용/);
});

await test("Partial action failure is reported without claiming a successful allowance or reloading", async () => {
  const h = await harness();
  h.mock.failStatuses = 1;
  await h.click("hijack-allow-once");
  assert.match(h.elements["hijack-summary"].textContent, /일부 프레임/);
  assert.equal(h.mock.temporary, false);
  assert.deepEqual(h.mock.reloads, []);
  assert.deepEqual(h.mock.writes, []);
});

await test("Page-scoped commands carry the opaque document token and fail safely after navigation", async () => {
  const h = await harness();
  h.mock.pageToken = "replacement-doc";
  await h.click("hijack-allow-once");
  const command = h.mock.messages.find(message => message.type === "hijack-allow-once");
  assert.equal(command.expectedPageToken, "test-doc");
  assert.equal(h.mock.temporary, false);
  assert.equal(h.state().hijackStatus.pageToken, "replacement-doc");
  assert.match(h.elements["hijack-summary"].textContent, /페이지가 바뀌었거나/);
  assert.deepEqual(h.mock.writes, []);
  assert.deepEqual(h.mock.reloads, []);
});

async function chromeTests() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: true,
    args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
  });
  let screenshotDirectory;
  try {
    const context = await browser.newContext({ viewport: { width: 340, height: 600 } });
    await context.addInitScript(() => {
      window.fixture = {
        settings: { enabled: true, disabledSites: [], hijackDisabledSites: [], hijackStrictSites: [] },
        temporary: false, reloads: 0, failSet: false,
      };
      const status = () => ({
        ok: true,
        pageToken: "test-doc",
        active: fixture.settings.enabled && !fixture.settings.disabledSites.includes("video.example") &&
          !fixture.settings.hijackDisabledSites.includes("video.example") && !fixture.temporary,
        strict: fixture.settings.hijackStrictSites.includes("video.example"),
        blockedCount: 3, overlayCount: 1, popupCount: 1, linkCount: 1,
        canAllowOnce: true, temporarilyAllowed: fixture.temporary,
        reasonCodes: ["known-overlay", "ad-link", "strict-popup"],
      });
      window.chrome = {
        storage: { local: {
          get: async defaults => ({ ...defaults, ...fixture.settings }),
          set: async update => {
            if (fixture.failSet) { fixture.failSet = false; throw new Error("Synthetic write failure"); }
            Object.assign(fixture.settings, update);
          },
        } },
        runtime: { sendMessage: async message => {
          if (message.type === "sync-settings") return { ok: true };
          if (["hijack-allow-once", "hijack-restore"].includes(message.type) &&
              message.expectedPageToken !== "test-doc") return { ok: false };
          if (message.type === "hijack-allow-once") fixture.temporary = true;
          if (message.type === "hijack-restore") fixture.temporary = false;
          return status();
        } },
        tabs: {
          query: async () => [{ id: 1, url: "https://video.example/page" }],
          reload: async () => { fixture.reloads += 1; },
          sendMessage: async () => ({ timeOrigin: 1 }),
        },
        declarativeNetRequest: { getMatchedRules: async () => ({ rulesMatchedInfo: [] }) },
      };
    });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      const files = { "/": "popup.html", "/popup.js": "popup.js", "/popup.css": "popup.css" };
      const file = files[url.pathname];
      if (url.hostname !== "popup-check.example" || !file) return route.abort();
      await route.fulfill({ status: 200,
        contentType: file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
        body: fs.readFileSync(path.join(root, "popup", file), "utf8"),
      });
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(String(error)));
    await page.goto("https://popup-check.example/");
    const ready = id => page.waitForFunction(id => !document.getElementById(id).disabled, id);
    await ready("hijack-toggle");
    if (process.argv.includes("--screenshots")) {
      screenshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "adblock-hijack-popup-tests-"));
      await page.screenshot({ path: path.join(screenshotDirectory, "collapsed.png"), fullPage: true });
    }
    await test("Chromium popup: independent settings and strict opt-in work through real controls without reload", async () => {
      await page.locator('label[for="hijack-toggle"]').click(); await ready("hijack-toggle");
      assert.deepEqual(await page.evaluate(() => fixture.settings.hijackDisabledSites), [fixtureHost]);
      assert.deepEqual(await page.evaluate(() => fixture.settings.disabledSites), []);
      await page.locator('label[for="hijack-toggle"]').click(); await ready("hijack-toggle");
      await page.locator("#hijack-options summary").click();
      await page.locator('label[for="hijack-strict-toggle"]').click(); await ready("hijack-strict-toggle");
      assert.deepEqual(await page.evaluate(() => fixture.settings.hijackStrictSites), [fixtureHost]);
      assert.equal(await page.evaluate(() => fixture.reloads), 0);
    });
    await test("Chromium popup: temporary allowance, restore, and failed write rollback remain visible and reversible", async () => {
      await page.locator("#hijack-allow-once").click(); await ready("hijack-restore");
      assert.equal(await page.evaluate(() => fixture.temporary), true);
      assert.equal(await page.locator("#hijack-strict-toggle").isDisabled(), true);
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "temporary.png"), fullPage: true });
      await page.locator("#hijack-restore").click(); await ready("hijack-allow-once");
      assert.equal(await page.evaluate(() => fixture.temporary), false);
      await page.evaluate(() => { fixture.failSet = true; });
      await page.locator('label[for="hijack-toggle"]').click(); await ready("hijack-toggle");
      assert.deepEqual(await page.evaluate(() => fixture.settings.hijackDisabledSites), []);
      assert.match(await page.locator("#hijack-summary").innerText(), /이전 상태/);
      assert.equal(await page.evaluate(() => fixture.settings.enabled), true);
      assert.equal(await page.evaluate(() => fixture.reloads), 0);
    });
    await test("Chromium popup: narrow layout has no horizontal overflow, scrolls expanded settings, and raises no script errors", async () => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 340), true);
      assert.ok(await page.locator("body").evaluate(node => node.getBoundingClientRect().height <= 600));
      await page.locator(".action-hint").scrollIntoViewIfNeeded();
      assert.equal(await page.locator(".action-hint").isVisible(), true);
      assert.deepEqual(pageErrors, []);
    });
  } finally {
    await browser.close();
  }
  if (screenshotDirectory) console.log(`Synthetic popup screenshots: ${screenshotDirectory}`);
}

if (process.argv.includes("--chrome")) await chromeTests();
console.log(`Hijack popup checks complete: ${passed} groups passed${process.argv.includes("--chrome") ? " (offline Chromium UI included)" : " (add --chrome for offline Chromium UI)"}`);
