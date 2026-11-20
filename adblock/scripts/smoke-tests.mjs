import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");

class FakeClassList {
  #names = new Set();

  toggle(name, force) {
    if (force) {
      this.#names.add(name);
    } else {
      this.#names.delete(name);
    }
  }

  contains(name) {
    return this.#names.has(name);
  }
}

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.checked = false;
    this.classList = new FakeClassList();
    this.disabled = false;
    this.focusCount = 0;
    this.listeners = new Map();
    this.row = null;
    this.textContent = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  closest(selector) {
    return selector === ".control-row" ? this.row : null;
  }

  focus() {
    this.focusCount += 1;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
  };
}

async function settle() {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createPopupHarness({
  tabUrl = "https://news.example/article",
} = {}) {
  const selectors = [
    "#status-card",
    "#status-label",
    "#status-title",
    "#status-description",
    "#blocked-count",
    "#global-toggle",
    "#site-toggle",
    "#site-name",
  ];
  const elements = Object.fromEntries(
    selectors.map((selector) => [selector, new FakeElement()]),
  );
  elements["#global-toggle"].row = new FakeElement();
  elements["#site-toggle"].row = new FakeElement();

  const settings = { enabled: true, disabledSites: [] };
  const reloads = [];
  let failNextReload = false;
  let failNextSync = false;

  const chrome = {
    declarativeNetRequest: {
      async getMatchedRules() {
        return {
          rulesMatchedInfo: [
            { rule: { ruleId: 1, rulesetId: "easylist" } },
            { rule: { ruleId: 1, rulesetId: "ads" } },
            { rule: { ruleId: 1, rulesetId: "soop" } },
            { rule: { ruleId: 900001, rulesetId: "_dynamic" } },
          ],
        };
      },
    },
    runtime: {
      async sendMessage(message) {
        if (failNextSync) {
          failNextSync = false;
          return { ok: false, error: "동기화 실패" };
        }
        return { ok: true };
      },
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...settings };
        },
        async set(updates) {
          Object.assign(settings, structuredClone(updates));
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 7, url: tabUrl }];
      },
      async reload(tabId) {
        if (failNextReload) {
          failNextReload = false;
          throw new Error("새로고침 실패");
        }
        reloads.push(tabId);
      },
      async sendMessage() {
        return { timeOrigin: 1000 };
      },
    },
  };

  const context = {
    URL,
    chrome,
    console,
    document: {
      querySelector(selector) {
        return elements[selector];
      },
    },
  };

  const source = fs.readFileSync(
    path.join(rootDirectory, "popup", "popup.js"),
    "utf8",
  );
  vm.runInNewContext(source, context, { filename: "popup/popup.js" });

  return {
    elements,
    reloads,
    settings,
    failReloadOnce() {
      failNextReload = true;
    },
    failSyncOnce() {
      failNextSync = true;
    },
  };
}

async function testPopup() {
  const harness = createPopupHarness();
  await settle();

  assert.equal(
    harness.elements["#status-title"].textContent,
    "광고 요청을 막고 있어요",
  );
  assert.equal(harness.elements["#blocked-count"].textContent, "3건 차단");
  assert.equal(harness.elements["#global-toggle"].disabled, false);

  const siteToggle = harness.elements["#site-toggle"];
  siteToggle.checked = false;
  await siteToggle.listeners.get("change")({ target: siteToggle });
  assert.deepEqual(harness.settings.disabledSites, ["news.example"]);
  assert.equal(harness.reloads.at(-1), 7);

  siteToggle.checked = true;
  await siteToggle.listeners.get("change")({ target: siteToggle });
  assert.deepEqual(harness.settings.disabledSites, []);

  harness.failReloadOnce();
  siteToggle.checked = false;
  await siteToggle.listeners.get("change")({ target: siteToggle });
  assert.equal(
    harness.elements["#status-title"].textContent,
    "설정은 저장했습니다",
  );
  assert.equal(siteToggle.disabled, false);
  assert.equal(siteToggle.focusCount, 3);
}

async function testPopupRollback() {
  const harness = createPopupHarness();
  await settle();

  harness.failSyncOnce();
  const globalToggle = harness.elements["#global-toggle"];
  globalToggle.checked = false;
  await globalToggle.listeners.get("change")({ target: globalToggle });

  assert.equal(harness.settings.enabled, true);
  assert.equal(
    harness.elements["#status-title"].textContent,
    "설정을 바꾸지 못했습니다",
  );
  assert.equal(globalToggle.disabled, false);
  assert.equal(globalToggle.focusCount, 1);
}

async function testBackground() {
  const events = {
    onChanged: createEvent(),
    onInstalled: createEvent(),
    onMessage: createEvent(),
    onStartup: createEvent(),
  };
  const settings = {
    enabled: false,
    disabledSites: ["Example.com", "example.com", "api.example.com"],
  };
  let dynamicRules = [];
  let enabledRulesets = ["easylist", "soop", "player_compat", "publisher_slots"];
  let actionOptions = null;
  let failNextPrimaryEnable = false;
  let registeredContentScripts = [];
  let sessionRules = [
    {
      id: 1_100_001,
      action: { type: "allowAllRequests" },
      condition: { tabIds: [17] },
    },
    {
      id: 1_100_002,
      action: { type: "allowAllRequests" },
      condition: { tabIds: [18] },
    },
    {
      id: 2_000_001,
      action: { type: "block" },
      condition: { urlFilter: "ads.unrelated.example" },
    },
  ];
  const badgeTexts = new Map();
  const actionTitles = new Map();
  const legacyMarkers = new Map([[17, true], [19, true], [20, false]]);
  const migrationEvents = [];
  const reloadedTabs = [];
  const warnings = [];

  const chrome = {
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText({ tabId, text }) {
        badgeTexts.set(tabId, text);
      },
      async setTitle({ tabId, title }) {
        actionTitles.set(tabId, title);
      },
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return structuredClone(dynamicRules);
      },
      async getEnabledRulesets() {
        return [...enabledRulesets];
      },
      async getSessionRules() {
        return structuredClone(sessionRules);
      },
      async setExtensionActionOptions(options) {
        actionOptions = options;
      },
      async updateDynamicRules({ addRules, removeRuleIds }) {
        dynamicRules = dynamicRules.filter(
          (rule) => !removeRuleIds.includes(rule.id),
        );
        dynamicRules.push(...structuredClone(addRules));
      },
      async updateEnabledRulesets({ disableRulesetIds, enableRulesetIds }) {
        if (
          failNextPrimaryEnable &&
          enableRulesetIds.includes("easylist")
        ) {
          failNextPrimaryEnable = false;
          throw new Error("정적 규칙 quota 부족");
        }
        enabledRulesets = enabledRulesets.filter(
          (id) => !disableRulesetIds.includes(id),
        );
        enabledRulesets.push(
          ...enableRulesetIds.filter((id) => !enabledRulesets.includes(id)),
        );
      },
      async updateSessionRules({ addRules, removeRuleIds }) {
        if (removeRuleIds.length) {
          migrationEvents.push(`remove:${removeRuleIds.join(",")}`);
        }
        sessionRules = sessionRules.filter(
          (rule) => !removeRuleIds.includes(rule.id),
        );
        sessionRules.push(...structuredClone(addRules));
      },
    },
    runtime: {
      getURL(relativePath) {
        return `chrome-extension://test/${relativePath}`;
      },
      onInstalled: events.onInstalled,
      onMessage: events.onMessage,
      onStartup: events.onStartup,
    },
    scripting: {
      async executeScript({ args, target, world }) {
        assert.equal(args.length, 1);
        assert.equal(args[0], "__lae_yt_pause_v1");
        assert.equal(world, "MAIN");
        assert.equal(target.frameIds.length, 1);
        assert.equal(target.frameIds[0], 0);
        migrationEvents.push(`marker:${target.tabId}`);
        const existed = legacyMarkers.get(target.tabId) === true;
        legacyMarkers.set(target.tabId, false);
        return [{ result: existed }];
      },
      async getRegisteredContentScripts({ ids }) {
        return structuredClone(
          registeredContentScripts.filter((script) => ids.includes(script.id)),
        );
      },
      async registerContentScripts(scripts) {
        registeredContentScripts.push(...structuredClone(scripts));
      },
      async unregisterContentScripts({ ids }) {
        registeredContentScripts = registeredContentScripts.filter(
          (script) => !ids.includes(script.id),
        );
      },
      async updateContentScripts(scripts) {
        for (const script of scripts) {
          const index = registeredContentScripts.findIndex(
            (registered) => registered.id === script.id,
          );
          assert.notEqual(index, -1);
          registeredContentScripts[index] = structuredClone(script);
        }
      },
    },
    storage: {
      local: {
        async get(keysOrDefaults) {
          if (Array.isArray(keysOrDefaults)) {
            return Object.fromEntries(
              keysOrDefaults
                .filter((key) => Object.hasOwn(settings, key))
                .map((key) => [key, structuredClone(settings[key])]),
            );
          }
          return { ...keysOrDefaults, ...structuredClone(settings) };
        },
        async set(updates) {
          Object.assign(settings, structuredClone(updates));
        },
      },
      onChanged: events.onChanged,
    },
    tabs: {
      async query({ url }) {
        assert.ok(Array.isArray(url));
        return [
          { id: 17, url: "https://www.youtube.com/watch?v=legacy" },
          { id: 19, url: "https://www.youtube.com/watch?v=marker" },
          { id: 20, url: "https://www.youtube.com/watch?v=clean" },
        ];
      },
      async reload(tabId) {
        migrationEvents.push(`reload:${tabId}`);
        reloadedTabs.push(tabId);
      },
    },
  };

  const source = fs.readFileSync(
    path.join(rootDirectory, "background.js"),
    "utf8",
  );
  vm.runInNewContext(
    source,
    {
      URL,
      chrome,
      console: {
        error: console.error,
        log: console.log,
        warn(...args) {
          warnings.push(args);
        },
      },
      async fetch(url) {
        assert.equal(
          url,
          "chrome-extension://test/rules/cosmetic-specific.json",
        );
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              schemaVersion: 2,
              conditionalGeneric: [".conditional-ad", "#legacy-adpost"],
              include: {
                "fmkorea.com": [
                  [".fmad_wrapper", []],
                  [".excluded-on-www", ["www.fmkorea.com"]],
                  ["#legacy-adpost", []],
                ],
                "www.fmkorea.com": [["iframe.current-ad", []]],
              },
              exception: {
                "www.fmkorea.com": [["#legacy-adpost", []]],
              },
              genericHideDisabledDomains: ["accounts.google.com"],
              elementHideDisabledDomains: ["private.example"],
            };
          },
        };
      },
    },
    { filename: "background.js" },
  );

  function sendBackgroundMessage(message, sender = {}) {
    return new Promise((resolve) => {
      const keepsChannelOpen = events.onMessage.listeners[0](
        message,
        sender,
        resolve,
      );
      assert.equal(keepsChannelOpen, true);
    });
  }

  const cosmeticResponse = await sendBackgroundMessage(
    {
      hostname: "www.fmkorea.com",
      type: "get-cosmetic-rules",
    },
    {
      documentId: "document-fm",
      frameId: 0,
      tab: { id: 31 },
      url: "https://www.fmkorea.com/hotdeal",
    },
  );
  assert.equal(cosmeticResponse.ok, true);
  assert.equal(cosmeticResponse.genericActive, true);
  assert.deepEqual(Array.from(cosmeticResponse.genericSelectors), [
    ".conditional-ad",
  ]);
  assert.equal(cosmeticResponse.specificActive, true);
  assert.deepEqual(Array.from(cosmeticResponse.specificSelectors), [
    ".fmad_wrapper",
    "iframe.current-ad",
  ]);

  const genericHideResponse = await sendBackgroundMessage(
    { hostname: "spoofed.example", type: "get-cosmetic-rules" },
    { url: "https://accounts.google.com/signin" },
  );
  assert.equal(genericHideResponse.ok, true);
  assert.equal(genericHideResponse.genericActive, false);
  assert.deepEqual(Array.from(genericHideResponse.genericSelectors), []);
  assert.equal(genericHideResponse.specificActive, true);

  const elementHideResponse = await sendBackgroundMessage(
    { hostname: "private.example", type: "get-cosmetic-rules" },
    {},
  );
  assert.equal(elementHideResponse.ok, true);
  assert.equal(elementHideResponse.genericActive, false);
  assert.equal(elementHideResponse.specificActive, false);

  events.onInstalled.listeners[0]();
  await settle();

  assert.deepEqual(settings.disabledSites, ["example.com", "api.example.com"]);
  assert.deepEqual(enabledRulesets, []);
  assert.equal(actionOptions.displayActionCountAsBadgeText, false);
  assert.equal(dynamicRules.length, 4);
  assert.deepEqual(registeredContentScripts, []);
  assert.deepEqual(sessionRules.map((rule) => rule.id), [2_000_001]);
  assert.deepEqual(
    reloadedTabs.sort((left, right) => left - right),
    [17, 19],
    JSON.stringify({ legacyMarkers: [...legacyMarkers], migrationEvents }),
  );
  assert.equal(legacyMarkers.get(17), false);
  assert.equal(legacyMarkers.get(19), false);
  assert.equal(badgeTexts.get(17), "");
  assert.equal(badgeTexts.get(18), "");
  assert.equal(badgeTexts.has(20), false);
  assert.ok(
    migrationEvents.indexOf("remove:1100001,1100002") <
      migrationEvents.indexOf("marker:17"),
  );
  assert.ok(
    migrationEvents.indexOf("marker:17") < migrationEvents.indexOf("reload:17"),
  );

  assert.equal(
    dynamicRules[0].condition.urlFilter,
    "|http://example.com^",
  );
  assert.equal(
    dynamicRules[1].condition.urlFilter,
    "|https://example.com^",
  );
  assert.equal(dynamicRules[2].condition.urlFilter, "|http://api.example.com^");
  assert.equal(dynamicRules[3].condition.urlFilter, "|https://api.example.com^");
  assert.deepEqual(dynamicRules[0].condition.requestDomains, ["example.com"]);

  settings.enabled = true;
  settings.disabledSites = [];
  const response = await new Promise((resolve) => {
    const keepsChannelOpen = events.onMessage.listeners[0](
      { type: "sync-settings" },
      {},
      resolve,
    );
    assert.equal(keepsChannelOpen, true);
  });

  assert.equal(response.ok, true);
  assert.deepEqual(enabledRulesets, ["easylist", "soop", "player_compat", "publisher_slots"]);
  assert.deepEqual(dynamicRules, []);
  assert.equal(actionOptions.displayActionCountAsBadgeText, true);
  assert.equal(registeredContentScripts.length, 4);
  const mainWorldScript = registeredContentScripts.find(
    (script) => script.id === "youtube-main-world",
  );
  const earlyGuardScript = registeredContentScripts.find(
    (script) => script.id === "youtube-early-guard",
  );
  assert.equal(mainWorldScript.world, "MAIN");
  assert.equal(mainWorldScript.runAt, "document_start");
  assert.deepEqual(mainWorldScript.excludeMatches, []);
  assert.equal(mainWorldScript.matchOriginAsFallback, true);
  assert.deepEqual(mainWorldScript.js, [
    "vendor/ublock-origin-lite/ublock-filters-main.js",
  ]);
  assert.equal(earlyGuardScript.world, "ISOLATED");
  assert.equal(earlyGuardScript.allFrames, true);
  assert.equal(earlyGuardScript.matchOriginAsFallback, true);
  assert.deepEqual(earlyGuardScript.js, [
    "vendor/ublock-origin-lite/ublock-filters-isolated.js",
  ]);
  const chzzkScript = registeredContentScripts.find(
    (script) => script.id === "chzzk-quality-main-world",
  );
  assert.equal(chzzkScript.world, "MAIN");
  assert.equal(chzzkScript.runAt, "document_start");
  assert.deepEqual(chzzkScript.matches, ["https://chzzk.naver.com/*"]);
  assert.deepEqual(chzzkScript.excludeMatches, []);
  assert.deepEqual(chzzkScript.js, ["sites/chzzk.js"]);

  const soopScript = registeredContentScripts.find(
    (script) => script.id === "soop-vod-main-world",
  );
  assert.equal(soopScript.world, "MAIN");
  assert.equal(soopScript.runAt, "document_start");
  assert.equal(soopScript.allFrames, true);
  assert.equal(soopScript.persistAcrossSessions, true);
  assert.deepEqual(soopScript.matches, ["https://vod.sooplive.com/*"]);
  assert.deepEqual(soopScript.excludeMatches, []);
  assert.deepEqual(soopScript.js, ["sites/soop.js"]);

  mainWorldScript.js = ["youtube-main.js"];
  delete mainWorldScript.matchOriginAsFallback;
  earlyGuardScript.js = ["youtube-guard.js"];
  earlyGuardScript.allFrames = false;
  const upgradeResponse = await sendBackgroundMessage({
    type: "sync-settings",
  });
  assert.equal(upgradeResponse.ok, true);
  const upgradedMainWorldScript = registeredContentScripts.find(
    (script) => script.id === "youtube-main-world",
  );
  const upgradedEarlyGuardScript = registeredContentScripts.find(
    (script) => script.id === "youtube-early-guard",
  );
  assert.deepEqual(upgradedMainWorldScript.js, [
    "vendor/ublock-origin-lite/ublock-filters-main.js",
  ]);
  assert.equal(upgradedMainWorldScript.matchOriginAsFallback, true);
  assert.deepEqual(upgradedEarlyGuardScript.js, [
    "vendor/ublock-origin-lite/ublock-filters-isolated.js",
  ]);
  assert.equal(upgradedEarlyGuardScript.allFrames, true);

  registeredContentScripts = registeredContentScripts.filter(
    (script) => script.id !== "youtube-early-guard",
  );
  const partialUpgradeResponse = await sendBackgroundMessage({
    type: "sync-settings",
  });
  assert.equal(partialUpgradeResponse.ok, true);
  assert.equal(registeredContentScripts.length, 4);
  assert.ok(
    registeredContentScripts.some(
      (script) => script.id === "youtube-early-guard",
    ),
  );

  settings.disabledSites = ["www.youtube.com"];
  await new Promise((resolve) => {
    events.onMessage.listeners[0]({ type: "sync-settings" }, {}, resolve);
  });
  const updatedMainWorldScript = registeredContentScripts.find(
    (script) => script.id === "youtube-main-world",
  );
  const updatedEarlyGuardScript = registeredContentScripts.find(
    (script) => script.id === "youtube-early-guard",
  );
  assert.deepEqual(updatedMainWorldScript.excludeMatches, [
    "https://www.youtube.com/*",
  ]);
  assert.deepEqual(updatedEarlyGuardScript.excludeMatches, [
    "https://www.youtube.com/*",
  ]);

  settings.disabledSites = ["vod.sooplive.com"];
  assert.equal((await sendBackgroundMessage({ type: "sync-settings" })).ok, true);
  assert.deepEqual(
    registeredContentScripts.find((script) => script.id === "soop-vod-main-world")
      .excludeMatches,
    ["https://vod.sooplive.com/*"],
  );
  assert.equal(dynamicRules.length, 2);
  assert.equal(dynamicRules[1].condition.urlFilter, "|https://vod.sooplive.com^");
  assert.equal(dynamicRules[1].priority, 10000);

  // 사이트 예외는 정확한 호스트에만 적용되며 SOOP 등록을 중복 생성하지 않습니다.
  settings.disabledSites = ["www.sooplive.com"];
  await sendBackgroundMessage({ type: "sync-settings" });
  assert.deepEqual(
    registeredContentScripts.find((script) => script.id === "soop-vod-main-world")
      .excludeMatches,
    [],
  );
  assert.equal(registeredContentScripts.length, 4);

  // 업데이트 전 설치본에 보조 ruleset이 없던 경우에도 복구합니다.
  enabledRulesets = ["easylist"];
  await sendBackgroundMessage({ type: "sync-settings" });
  assert.deepEqual(enabledRulesets, ["easylist", "soop", "player_compat", "publisher_slots"]);

  // v1.9.4에서 업데이트되어 플레이어 호환 ruleset만 빠진 상태도 복구합니다.
  enabledRulesets = ["easylist", "soop"];
  await sendBackgroundMessage({ type: "sync-settings" });
  assert.deepEqual(enabledRulesets, ["easylist", "soop", "player_compat", "publisher_slots"]);

  // Upgrade from 1.10 with only the new publisher rules missing.
  enabledRulesets = ["easylist", "soop", "player_compat"];
  await sendBackgroundMessage({ type: "sync-settings" });
  assert.ok(enabledRulesets.includes("publisher_slots"));

  settings.enabled = false;
  await new Promise((resolve) => {
    events.onMessage.listeners[0]({ type: "sync-settings" }, {}, resolve);
  });
  assert.deepEqual(enabledRulesets, []);
  assert.deepEqual(registeredContentScripts, []);

  settings.enabled = true;
  failNextPrimaryEnable = true;
  const fallbackResponse = await new Promise((resolve) => {
    events.onMessage.listeners[0]({ type: "sync-settings" }, {}, resolve);
  });
  assert.equal(fallbackResponse.ok, true);
  assert.deepEqual(enabledRulesets, ["ads", "soop", "player_compat", "publisher_slots"]);
  assert.equal(warnings.length, 1);

  await sendBackgroundMessage({ type: "sync-settings" });
  assert.deepEqual([...enabledRulesets].sort(), ["easylist", "player_compat", "publisher_slots", "soop"]);
  assert.equal(registeredContentScripts.length, 4);

  assert.deepEqual(sessionRules.map((rule) => rule.id), [2_000_001]);
  assert.deepEqual(reloadedTabs.sort((left, right) => left - right), [17, 19]);
}

async function testContentScriptUsesTopLevelSite() {
  const documentElement = new FakeElement();
  const dispatchedEvents = [];
  const sentMessages = [];
  const onChanged = createEvent();
  const onMessage = createEvent();
  const chrome = {
    runtime: {
      onMessage,
      async sendMessage(message) {
        sentMessages.push(structuredClone(message));
        return {
          ok: true,
          genericActive: false,
          genericSelectors: [],
          specificActive: true,
          specificSelectors: [],
        };
      },
    },
    storage: {
      local: {
        async get(defaults) {
          return {
            ...defaults,
            disabledSites: ["publisher.example"],
            enabled: true,
          };
        },
      },
      onChanged,
    },
  };
  const window = {
    location: {
      ancestorOrigins: ["https://publisher.example"],
      hostname: "frame.example",
    },
  };
  const document = {
    documentElement,
    dispatchEvent(event) {
      dispatchedEvents.push(event.type);
      return true;
    },
  };
  const source = fs.readFileSync(
    path.join(rootDirectory, "content.js"),
    "utf8",
  );

  vm.runInNewContext(
    source,
    {
      URL,
      chrome,
      console,
      document,
      Event: class Event {
        constructor(type) {
          this.type = type;
        }
      },
      performance: { timeOrigin: 1000 },
      window,
    },
    { filename: "content.js" },
  );
  await settle();

  assert.equal(
    documentElement.classList.contains("lae-active"),
    false,
  );
  assert.equal(
    documentElement.classList.contains("lae-generic-active"),
    false,
  );
  assert.equal(
    documentElement.classList.contains("lae-specific-active"),
    false,
  );
  assert.equal(
    documentElement.getAttribute("data-lae-player"),
    "off",
  );
  assert.deepEqual(dispatchedEvents, ["lae-player-state"]);
  assert.deepEqual(sentMessages, []);
}

async function testYoutubeLegacyMarkerCleanup() {
  const documentElement = new FakeElement();
  const onChanged = createEvent();
  const onMessage = createEvent();
  const storageValues = new Map([["__lae_yt_pause_v1", "1"]]);
  const sentMessages = [];
  const document = {
    documentElement,
    dispatchEvent() {
      return true;
    },
  };
  const chrome = {
    runtime: {
      onMessage,
      async sendMessage(message) {
        sentMessages.push(structuredClone(message));
        return {
          ok: true,
          genericActive: false,
          genericSelectors: [],
          specificActive: true,
          specificSelectors: [],
        };
      },
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, disabledSites: [], enabled: true };
        },
      },
      onChanged,
    },
  };
  const window = {
    location: {
      ancestorOrigins: [],
      hostname: "www.youtube.com",
    },
  };

  const sessionStorage = {
    removeItem(key) {
      storageValues.delete(key);
    },
  };
  const source = fs.readFileSync(
    path.join(rootDirectory, "content.js"),
    "utf8",
  );

  vm.runInNewContext(
    source,
    {
      URL,
      chrome,
      console,
      document,
      Event: class Event {
        constructor(type) {
          this.type = type;
        }
      },
      performance: { timeOrigin: 1000 },
      sessionStorage,
      window,
    },
    { filename: "content.js" },
  );
  await settle();

  assert.equal(storageValues.has("__lae_yt_pause_v1"), false);
  assert.equal(documentElement.classList.contains("lae-active"), true);
  assert.equal(
    documentElement.classList.contains("lae-generic-active"),
    false,
  );
  assert.equal(
    documentElement.classList.contains("lae-specific-active"),
    true,
  );
  assert.equal(documentElement.getAttribute("data-lae-player"), "on");
  assert.deepEqual(sentMessages, [
    {
      hostname: "www.youtube.com",
      type: "get-cosmetic-rules",
    },
  ]);
}

async function testContentScriptInstallsCosmeticRules() {
  const documentElement = new FakeElement();
  const onChanged = createEvent();
  const onMessage = createEvent();
  const styleSheets = [];
  const document = {
    adoptedStyleSheets: [],
    documentElement,
    dispatchEvent() {
      return true;
    },
  };
  class FakeStyleSheet {
    replaceSync(cssText) {
      this.cssText = cssText;
      styleSheets.push(cssText);
    }
  }
  const chrome = {
    runtime: {
      onMessage,
      async sendMessage() {
        return {
          ok: true,
          genericActive: true,
          genericSelectors: ["HTML > .conditional-ad"],
          specificActive: true,
          specificSelectors: [".fmad_wrapper"],
        };
      },
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, disabledSites: [], enabled: true };
        },
      },
      onChanged,
    },
  };
  const window = {
    location: {
      ancestorOrigins: [],
      hostname: "www.fmkorea.com",
    },
  };
  const source = fs.readFileSync(
    path.join(rootDirectory, "content.js"),
    "utf8",
  );

  vm.runInNewContext(
    source,
    {
      CSS: { supports: () => true },
      CSSStyleSheet: FakeStyleSheet,
      URL,
      chrome,
      console,
      document,
      Event: class Event {},
      performance: { timeOrigin: 1000 },
      window,
    },
    { filename: "content.js" },
  );
  await settle();

  assert.equal(documentElement.classList.contains("lae-active"), true);
  assert.equal(
    documentElement.classList.contains("lae-generic-active"),
    true,
  );
  assert.equal(
    documentElement.classList.contains("lae-specific-active"),
    true,
  );
  assert.equal(styleSheets.length, 2);
  assert.equal(
    styleSheets[0].includes(
      "html.lae-active.lae-generic-active > .conditional-ad",
    ),
    true,
  );
  assert.equal(
    styleSheets[1].includes(
      "html.lae-active.lae-specific-active .fmad_wrapper",
    ),
    true,
  );
}

function testNoSilentYoutubeAllowMessages() {
  const retiredMessages = [
    "youtube-wall-detected",
    "ensure-youtube-tab-pause",
    "get-tab-state",
    "resume-youtube-tab",
    "clear-youtube-auto-pause",
  ];
  const runtimeSources = [
    "background.js",
    "content.js",
    path.join("popup", "popup.js"),
  ].map((relativePath) =>
    fs.readFileSync(path.join(rootDirectory, relativePath), "utf8"),
  );

  for (const message of retiredMessages) {
    assert.equal(
      runtimeSources.some((source) => source.includes(message)),
      false,
      `폐기된 YouTube 자동 허용 메시지가 남아 있습니다: ${message}`,
    );
  }
}

function testYoutubeEarlyGuard() {
  let observerInstance = null;
  let readyStateListener = null;
  const existingTarget = {
    nodeName: "SCRIPT",
    textContent: 'const frozen = [window,"fetch"];',
  };
  const benignScript = {
    nodeName: "SCRIPT",
    textContent: "window.appStarted = true;",
  };
  const document = {
    currentScript: null,
    readyState: "loading",
    addEventListener(type, listener, options) {
      assert.equal(type, "readystatechange");
      assert.equal(options.capture, true);
      assert.equal(options.once, true);
      readyStateListener = listener;
    },
    querySelectorAll(selector) {
      assert.equal(selector, "script");
      return [existingTarget, benignScript];
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.pending = [];
      observerInstance = this;
    }

    disconnect() {
      this.disconnected = true;
    }

    observe(target, options) {
      assert.equal(target, document);
      assert.equal(options.childList, true);
      assert.equal(options.subtree, true);
    }

    takeRecords() {
      return this.pending.splice(0);
    }
  }

  const source = fs.readFileSync(
    path.join(rootDirectory, "youtube-guard.js"),
    "utf8",
  );
  vm.runInNewContext(
    source,
    {
      document,
      MutationObserver: FakeMutationObserver,
      Uint32Array,
    },
    { filename: "youtube-guard.js" },
  );

  assert.equal(existingTarget.textContent, "");
  assert.equal(benignScript.textContent, "window.appStarted = true;");
  assert.ok(observerInstance);

  const dynamicTarget = {
    nodeName: "SCRIPT",
    textContent: 'Object.freeze([window,"fetch"]);',
  };
  observerInstance.callback([{ addedNodes: [dynamicTarget] }]);
  assert.equal(dynamicTarget.textContent, "");

  const pendingTarget = {
    nodeName: "SCRIPT",
    textContent: 'void [window,"fetch"];',
  };
  observerInstance.pending.push({ addedNodes: [pendingTarget] });
  document.readyState = "interactive";
  readyStateListener();
  assert.equal(pendingTarget.textContent, "");
  assert.equal(observerInstance.disconnected, true);
}

async function testYoutubeMainScript() {
  const documentElement = new FakeElement();
  const listeners = new Map();
  const mainSessionValues = new Map();
  let currentPlayer = null;
  const document = {
    documentElement,
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
      return true;
    },
    querySelector(selector) {
      return selector === "#movie_player" ? currentPlayer : null;
    },
    querySelectorAll() {
      return [];
    },
  };

  class FakeMutationObserver {
    disconnect() {}

    observe() {}
  }

  class FakeResponse {
    constructor(url, value) {
      this.url = url;
      this.value = value;
    }

    async json() {
      return this.value;
    }
  }

  class FakeXMLHttpRequest {
    constructor(value) {
      this.listeners = new Map();
      this.readyState = 0;
      this.response = value;
      this.responseType = "json";
    }

    addEventListener(type, listener) {
      const entries = this.listeners.get(type) ?? [];
      entries.push(listener);
      this.listeners.set(type, entries);
    }

    finish() {
      this.readyState = 4;
      for (const listener of this.listeners.get("readystatechange") ?? []) {
        listener.call(this);
      }
    }

    open() {}
  }

  const context = vm.createContext({
    URL,
    console,
    document,
    location: {
      href: "https://music.youtube.com/watch?v=test",
      hostname: "music.youtube.com",
    },
    MutationObserver: FakeMutationObserver,
    Response: FakeResponse,
    sessionStorage: {
      getItem(key) {
        return mainSessionValues.get(key) ?? null;
      },
      removeItem(key) {
        mainSessionValues.delete(key);
      },
      setItem(key, value) {
        mainSessionValues.set(key, value);
      },
    },
    XMLHttpRequest: FakeXMLHttpRequest,
    queueMicrotask(callback) {
      callback();
    },
    setInterval() {
      return 1;
    },
  });
  context.window = context;

  const source = fs.readFileSync(
    path.join(rootDirectory, "youtube-main.js"),
    "utf8",
  );
  vm.runInContext(source, context, { filename: "youtube-main.js" });

  vm.runInContext(
    `
      globalThis.earlyResponse = JSON.parse(
        '{"adSlots":[{"id":"early"}],"videoDetails":{"videoId":"early"}}'
      );
      globalThis.earlyPlacementMap = new Map();
      earlyPlacementMap.set("remove", { kind: "AD_PLACEMENT_KIND_START" });
      earlyPlacementMap.set("replace", { kind: "AD_PLACEMENT_KIND_MIDROLL" });
      earlyPlacementMap.set("replace", { kind: "CONTENT", id: "replacement" });
    `,
    context,
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(earlyResponse, "adSlots")`, context),
    true,
  );
  documentElement.setAttribute("data-lae-player", "on");
  document.dispatchEvent({ type: "lae-player-state" });
  assert.equal(
    vm.runInContext(`Object.hasOwn(earlyResponse, "adSlots")`, context),
    false,
  );
  assert.equal(
    vm.runInContext(`earlyPlacementMap.has("remove")`, context),
    false,
  );
  assert.equal(
    vm.runInContext(`earlyPlacementMap.get("replace").id`, context),
    "replacement",
  );

  vm.runInContext(
    `
      globalThis.initialResponse = {
        adPlacements: [{ id: "pre-roll" }],
        adSlots: [{ id: "slot" }],
        playerAds: [{ id: "companion" }],
        playerConfig: { ssapConfig: { enabled: true } },
        serviceTrackingParams: [{ params: [{ adClientParams: { isAd: true, keep: 1 } }] }],
        entries: [
          { id: "ad-true", command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } },
          { id: "ad-false", command: { reelWatchEndpoint: { adClientParams: { isAd: false } } } },
          { id: "content", command: { reelWatchEndpoint: { adClientParams: {} } } },
          { id: "other-endpoint", command: { browseEndpoint: { adClientParams: { isAd: true } } } }
        ],
        videoDetails: { videoId: "test", title: "정상 영상" }
      };
      ytInitialPlayerResponse = globalThis.initialResponse;
    `,
    context,
  );

  assert.equal(
    vm.runInContext(
      `Object.hasOwn(ytInitialPlayerResponse, "adPlacements")`,
      context,
    ),
    false,
  );
  assert.equal(
    vm.runInContext(
      `Object.hasOwn(ytInitialPlayerResponse.playerConfig, "ssapConfig")`,
      context,
    ),
    false,
  );
  assert.equal(
    vm.runInContext(
      `ytInitialPlayerResponse.serviceTrackingParams[0].params[0].adClientParams.keep`,
      context,
    ),
    1,
  );
  assert.equal(
    vm.runInContext(
      `Object.hasOwn(ytInitialPlayerResponse.serviceTrackingParams[0].params[0].adClientParams, "isAd")`,
      context,
    ),
    true,
  );
  assert.equal(
    vm.runInContext(
      `ytInitialPlayerResponse.entries.map((entry) => entry.id).join(",")`,
      context,
    ),
    "content,other-endpoint",
  );
  assert.equal(
    vm.runInContext(`ytInitialPlayerResponse.videoDetails.videoId`, context),
    "test",
  );

  vm.runInContext(
    `
      globalThis.shortsGetterReads = 0;
      const inheritedParams = Object.create({ isAd: true });
      const getterParams = {};
      Object.defineProperty(getterParams, "isAd", {
        enumerable: true,
        get() {
          shortsGetterReads += 1;
          return true;
        }
      });
      globalThis.edgeShortsResponse = {
        entries: [
          { id: "inherited", command: { reelWatchEndpoint: { adClientParams: inheritedParams } } },
          { id: "getter", command: { reelWatchEndpoint: { adClientParams: getterParams } } }
        ]
      };
      ytInitialPlayerResponse = edgeShortsResponse;
      globalThis.frozenShortsResponse = {
        entries: Object.freeze([
          { id: "frozen-ad", command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } }
        ])
      };
      ytInitialPlayerResponse = frozenShortsResponse;
    `,
    context,
  );
  assert.equal(vm.runInContext(`shortsGetterReads`, context), 0);
  assert.equal(vm.runInContext(`edgeShortsResponse.entries.length`, context), 2);
  assert.equal(vm.runInContext(`frozenShortsResponse.entries.length`, context), 1);

  vm.runInContext(
    `
      globalThis.parsedResponse = JSON.parse(
        '{"adSlots":[{"id":"mid-roll"}],"videoDetails":{"videoId":"parsed"}}'
      );
      globalThis.placementMap = new Map();
      placementMap.set("ad", { kind: "AD_PLACEMENT_KIND_START" });
      placementMap.set("content", { kind: "CONTENT" });
    `,
    context,
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(parsedResponse, "adSlots")`, context),
    false,
  );
  assert.equal(vm.runInContext(`placementMap.has("ad")`, context), false);
  assert.equal(vm.runInContext(`placementMap.has("content")`, context), true);

  vm.runInContext(
    `
      globalThis.shortsOnlyResponse = JSON.parse(
        '{"entries":[{"id":"ad","command":{"reelWatchEndpoint":{"adClientParams":{"isAd":false}}}},{"id":"content","command":{"reelWatchEndpoint":{"adClientParams":{}}}}]}'
      );
    `,
    context,
  );
  assert.equal(
    vm.runInContext(`shortsOnlyResponse.entries.length`, context),
    1,
  );
  assert.equal(
    vm.runInContext(`shortsOnlyResponse.entries[0].id`, context),
    "content",
  );

  vm.runInContext(
    `
      globalThis.playerFetch = new Response(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        { adPlacements: [{ id: "network-ad" }], videoDetails: { videoId: "network" } }
      );
      globalThis.unrelatedFetch = new Response(
        "https://www.youtube.com/youtubei/v1/browse",
        { adPlacements: [{ id: "unrelated" }], keep: true }
      );
    `,
    context,
  );
  const playerFetchResult = await vm.runInContext(`playerFetch.json()`, context);
  const unrelatedFetchResult = await vm.runInContext(
    `unrelatedFetch.json()`,
    context,
  );
  assert.equal(Object.hasOwn(playerFetchResult, "adPlacements"), false);
  assert.equal(playerFetchResult.videoDetails.videoId, "network");
  assert.equal(Object.hasOwn(unrelatedFetchResult, "adPlacements"), true);

  vm.runInContext(
    `
      globalThis.playerXhr = new XMLHttpRequest({
        adSlots: [{ id: "xhr-ad" }],
        videoDetails: { videoId: "xhr" }
      });
      playerXhr.open("POST", "/youtubei/v1/player");
      playerXhr.finish();
    `,
    context,
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(playerXhr.response, "adSlots")`, context),
    false,
  );
  assert.equal(
    vm.runInContext(`playerXhr.response.videoDetails.videoId`, context),
    "xhr",
  );

  let skipAdCount = 0;
  const adVideo = { currentTime: 2, duration: 6 };
  currentPlayer = {
    classList: { contains: () => true },
    querySelector(selector) {
      return selector === "video" ? adVideo : null;
    },
    skipAd() {
      skipAdCount += 1;
    },
  };
  document.dispatchEvent({ type: "lae-player-state" });
  assert.equal(skipAdCount, 0);
  assert.equal(adVideo.currentTime, 6);

  const contentVideo = { currentTime: 2, duration: 300 };
  currentPlayer = {
    classList: { contains: () => false },
    querySelector(selector) {
      return selector === "video" ? contentVideo : null;
    },
  };
  document.dispatchEvent({ type: "lae-player-state" });
  assert.equal(contentVideo.currentTime, 2);

  documentElement.setAttribute("data-lae-player", "off");
  vm.runInContext(
    `globalThis.allowedResponse = JSON.parse('{"adSlots":[{"id":"allowed"}]}')`,
    context,
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(allowedResponse, "adSlots")`, context),
    true,
  );

  mainSessionValues.set("__lae_yt_pause_v1", "1");
  documentElement.setAttribute("data-lae-player", "on");
  vm.runInContext(
    `globalThis.pausedResponse = JSON.parse('{"adSlots":[{"id":"paused"}]}')`,
    context,
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(pausedResponse, "adSlots")`, context),
    false,
  );
  mainSessionValues.delete("__lae_yt_pause_v1");

  documentElement.setAttribute("data-lae-player", "");
  context.top = context;
  vm.runInContext(
    `globalThis.topLevelResponse = JSON.parse('{"adSlots":[{"id":"top-level"}]}')`,
    context,
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(topLevelResponse, "adSlots")`, context),
    false,
  );
}

async function testYoutubeDesktopHookScope() {
  const documentElement = new FakeElement();
  documentElement.setAttribute("data-lae-player", "on");
  let currentPlayer = null;
  let currentWall = null;
  const document = {
    documentElement,
    addEventListener() {},
    querySelector(selector) {
      if (selector === "#movie_player") {
        return currentPlayer;
      }
      if (selector === "ytd-enforcement-message-view-model") {
        return currentWall;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  class FakeMutationObserver {
    disconnect() {}

    observe() {}
  }

  class FakeResponse {
    constructor(url, value) {
      this.url = url;
      this.value = value;
    }

    async json() {
      return this.value;
    }
  }

  class FakeXMLHttpRequest {
    constructor(value = null) {
      this.listeners = new Map();
      this.readyState = 0;
      this.response = value;
      this.responseType = "json";
    }

    addEventListener(type, listener) {
      const entries = this.listeners.get(type) ?? [];
      entries.push(listener);
      this.listeners.set(type, entries);
    }

    finish() {
      this.readyState = 4;
      for (const listener of this.listeners.get("readystatechange") ?? []) {
        listener.call(this);
      }
    }

    open() {}
  }

  class FakeNode {
    appendChild(node) {
      this.lastChild = node;
      return node;
    }
  }

  class FakeHTMLElement extends FakeNode {}

  class FakeRequest {}

  let desktopIntervalTask = null;
  const context = vm.createContext({
    URL,
    console,
    document,
    fetch() {},
    HTMLElement: FakeHTMLElement,
    location: {
      href: "https://www.youtube.com/watch?v=desktop",
      hostname: "www.youtube.com",
    },
    MutationObserver: FakeMutationObserver,
    Node: FakeNode,
    queueMicrotask(callback) {
      callback();
    },
    Request: FakeRequest,
    Response: FakeResponse,
    sessionStorage: { getItem: () => null },
    setInterval(callback) {
      desktopIntervalTask = callback;
      return 1;
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    XMLHttpRequest: FakeXMLHttpRequest,
  });
  context.window = context;
  context.top = context;
  vm.runInContext(
    `
      globalThis.originalJsonParse = JSON.parse;
      globalThis.originalResponseJson = Response.prototype.json;
      globalThis.originalXhrOpen = XMLHttpRequest.prototype.open;
    `,
    context,
  );

  const source = fs.readFileSync(
    path.join(rootDirectory, "youtube-main.js"),
    "utf8",
  );
  vm.runInContext(source, context, { filename: "youtube-main.js" });

  assert.equal(vm.runInContext(`JSON.parse === originalJsonParse`, context), true);
  assert.equal(
    vm.runInContext(`Response.prototype.json === originalResponseJson`, context),
    false,
  );
  assert.equal(
    vm.runInContext(`XMLHttpRequest.prototype.open === originalXhrOpen`, context),
    false,
  );

  vm.runInContext(
    `
      globalThis.blankFrame = new HTMLElement();
      blankFrame.contentWindow = {
        location: { href: "about:blank" },
        fetch() {},
        Request: class ChildRequest {},
        JSON: { parse() {} }
      };
      globalThis.externalFrame = new HTMLElement();
      globalThis.externalFetch = function externalFetch() {};
      externalFrame.contentWindow = {
        location: { href: "https://example.com/frame" },
        fetch: externalFetch,
        Request: class ExternalRequest {},
        JSON: { parse() {} }
      };
      new Node().appendChild(blankFrame);
      new Node().appendChild(externalFrame);
    `,
    context,
  );
  assert.equal(
    vm.runInContext(`blankFrame.contentWindow.fetch === window.fetch`, context),
    true,
  );
  assert.equal(
    vm.runInContext(`blankFrame.contentWindow.Request === window.Request`, context),
    true,
  );
  assert.equal(
    vm.runInContext(`blankFrame.contentWindow.JSON.parse === JSON.parse`, context),
    true,
  );
  assert.equal(
    vm.runInContext(`externalFrame.contentWindow.fetch === externalFetch`, context),
    true,
  );

  vm.runInContext(
    `
      ytInitialPlayerResponse = {
        adPlacements: [{ id: "desktop-ad" }],
        videoDetails: { videoId: "desktop" }
      };
      globalThis.desktopParsed = JSON.parse('{"adSlots":[{"id":"not-global-hooked"}]}');
      globalThis.desktopMap = new Map();
      desktopMap.set("ad", { kind: "AD_PLACEMENT_KIND_START" });
    `,
    context,
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(ytInitialPlayerResponse, "adPlacements")`, context),
    false,
  );
  assert.equal(
    vm.runInContext(`ytInitialPlayerResponse.videoDetails.videoId`, context),
    "desktop",
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(desktopParsed, "adSlots")`, context),
    true,
  );
  assert.equal(vm.runInContext(`desktopMap.has("ad")`, context), false);
  assert.equal(
    vm.runInContext(
      `Object.getOwnPropertyDescriptor(window, "ytInitialPlayerResponse").get === undefined`,
      context,
    ),
    true,
  );

  const desktopPlayerResponse = await vm.runInContext(
    `new Response(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      { adSlots: [{ id: "desktop-network-ad" }], videoDetails: { videoId: "desktop" } }
    ).json()`,
    context,
  );
  const desktopBrowseResponse = await vm.runInContext(
    `new Response(
      "https://www.youtube.com/youtubei/v1/browse",
      { adSlots: [{ id: "browse-ad" }] }
    ).json()`,
    context,
  );
  const externalPlayerResponse = await vm.runInContext(
    `new Response(
      "https://example.com/youtubei/v1/player",
      { adSlots: [{ id: "external-ad" }] }
    ).json()`,
    context,
  );
  assert.equal(Object.hasOwn(desktopPlayerResponse, "adSlots"), false);
  assert.equal(Object.hasOwn(desktopBrowseResponse, "adSlots"), true);
  assert.equal(Object.hasOwn(externalPlayerResponse, "adSlots"), true);

  vm.runInContext(
    `
      globalThis.desktopBrowseXhr = new XMLHttpRequest({
        adSlots: [{ id: "browse-xhr-ad" }]
      });
      desktopBrowseXhr.open("POST", "/youtubei/v1/browse");
      desktopBrowseXhr.finish();
      globalThis.desktopPlayerXhr = new XMLHttpRequest({
        adSlots: [{ id: "player-xhr-ad" }],
        videoDetails: { videoId: "desktop" }
      });
      desktopPlayerXhr.open("POST", "/youtubei/v1/player");
      desktopPlayerXhr.finish();
    `,
    context,
  );
  assert.equal(
    vm.runInContext(
      `desktopBrowseXhr.listeners.get("readystatechange")?.length ?? 0`,
      context,
    ),
    0,
  );
  assert.equal(
    vm.runInContext(
      `desktopPlayerXhr.listeners.get("readystatechange")?.length ?? 0`,
      context,
    ),
    1,
  );
  assert.equal(
    vm.runInContext(`Object.hasOwn(desktopPlayerXhr.response, "adSlots")`, context),
    false,
  );

  vm.runInContext(
    `
      globalThis.ytplayer = {
        config: {
          args: {
            raw_player_response: {
              adSlots: [{ id: "late-desktop-ad" }],
              videoDetails: { videoId: "late-desktop" }
            }
          }
        }
      };
    `,
    context,
  );
  desktopIntervalTask();
  assert.equal(
    vm.runInContext(
      `Object.hasOwn(ytplayer.config.args.raw_player_response, "adSlots")`,
      context,
    ),
    false,
  );

  vm.runInContext(
    `
      ytplayer.config.args.raw_player_response =
        '{"entries":[{"id":"late-ad","command":{"reelWatchEndpoint":{"adClientParams":{"isAd":true}}}},{"id":"late-content"}]}';
    `,
    context,
  );
  desktopIntervalTask();
  assert.equal(
    vm.runInContext(
      `JSON.parse(ytplayer.config.args.raw_player_response).entries[0].id`,
      context,
    ),
    "late-content",
  );

  documentElement.setAttribute("data-lae-player", "off");
  vm.runInContext(
    `ytplayer.config.args.raw_player_response = '{"adSlots":[{"id":"allowed-late"}]}'`,
    context,
  );
  desktopIntervalTask();
  assert.equal(
    vm.runInContext(
      `JSON.parse(ytplayer.config.args.raw_player_response).adSlots[0].id`,
      context,
    ),
    "allowed-late",
  );

  function makeVisibleWall({ dismissible = false, hidden = false } = {}) {
    return {
      hidden,
      isConnected: true,
      checkVisibility() {
        return !hidden;
      },
      getAttribute() {
        return null;
      },
      hasAttribute() {
        return false;
      },
      querySelector(selector) {
        if (selector !== "#dismiss-button" || !dismissible) {
          return null;
        }
        return {
          disabled: false,
          getAttribute() {
            return null;
          },
          isConnected: true,
        };
      },
    };
  }

  const retryCalls = [];
  let activePlayerResponse = null;
  currentPlayer = {
    classList: { contains: () => false },
    getPlayerResponse() {
      return activePlayerResponse;
    },
    getProgressState() {
      return { current: 12, duration: 100 };
    },
    getStatsForNerds() {
      return { debug_info: "" };
    },
    loadVideoById(videoId, startSeconds) {
      retryCalls.push([videoId, startSeconds]);
    },
    querySelector(selector) {
      return selector === "video" ? { ended: false } : null;
    },
  };

  documentElement.setAttribute("data-lae-player", "on");
  currentWall = makeVisibleWall();
  activePlayerResponse = {
    playabilityStatus: { status: "OK" },
    videoDetails: { videoId: "desktop" },
  };
  desktopIntervalTask();
  desktopIntervalTask();
  assert.deepEqual(retryCalls, [["desktop", 12]]);

  context.location.href = "https://www.youtube.com/watch?v=loginerr1";
  activePlayerResponse = {
    playabilityStatus: { status: "LOGIN_REQUIRED" },
    videoDetails: { videoId: "loginerr1" },
  };
  desktopIntervalTask();
  assert.equal(retryCalls.length, 1);

  context.location.href = "https://www.youtube.com/watch?v=dismiss1";
  currentWall = makeVisibleWall({ dismissible: true });
  activePlayerResponse = {
    playabilityStatus: { status: "OK" },
    videoDetails: { videoId: "dismiss1" },
  };
  desktopIntervalTask();
  assert.equal(retryCalls.length, 1);

  context.location.href = "https://www.youtube.com/watch?v=server303";
  currentWall = null;
  activePlayerResponse = {
    playabilityStatus: {
      status: "UNPLAYABLE",
      errorScreen: {
        playerErrorMessageRenderer: {
          subreason: {
            runs: [
              { webPageType: "WEB_PAGE_TYPE_UNKNOWN" },
              { url: "https://support.google.com/youtube/answer/3037019?hl=ko" },
            ],
          },
        },
      },
    },
    videoDetails: { videoId: "server303" },
  };
  desktopIntervalTask();
  desktopIntervalTask();
  assert.deepEqual(retryCalls.at(-1), ["server303", 12]);
  assert.equal(retryCalls.length, 2);

  context.location.href = "https://www.youtube.com/watch?v=partial1";
  activePlayerResponse = {
    playabilityStatus: {
      status: "UNPLAYABLE",
      errorScreen: {
        playerErrorMessageRenderer: {
          subreason: {
            runs: [
              { url: "https://support.google.com/youtube/answer/3037019" },
            ],
          },
        },
      },
    },
    videoDetails: { videoId: "partial1" },
  };
  desktopIntervalTask();
  assert.equal(retryCalls.length, 2);

  context.location.href = "https://www.youtube.com/watch?v=matchvid1";
  currentWall = makeVisibleWall();
  activePlayerResponse = {
    playabilityStatus: { status: "OK" },
    videoDetails: { videoId: "different1" },
  };
  desktopIntervalTask();
  assert.equal(retryCalls.length, 2);
  activePlayerResponse.videoDetails.videoId = "matchvid1";
  desktopIntervalTask();
  assert.deepEqual(retryCalls.at(-1), ["matchvid1", 12]);
  assert.equal(retryCalls.length, 3);

  const pausedContext = vm.createContext({
    document: {
      documentElement: new FakeElement(),
      addEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    location: {
      href: "https://www.youtube.com/watch?v=paused-startup",
      hostname: "www.youtube.com",
    },
    MutationObserver: FakeMutationObserver,
    queueMicrotask(callback) {
      callback();
    },
    sessionStorage: { getItem: () => "1" },
    setInterval() {
      return 1;
    },
  });
  pausedContext.window = pausedContext;
  pausedContext.top = pausedContext;
  vm.runInContext(
    `
      globalThis.originalPausedMapSet = Map.prototype.set;
      globalThis.originalPausedJsonParse = JSON.parse;
    `,
    pausedContext,
  );
  vm.runInContext(source, pausedContext, { filename: "youtube-main.js" });
  assert.equal(
    vm.runInContext(`Map.prototype.set === originalPausedMapSet`, pausedContext),
    false,
  );
  assert.equal(
    vm.runInContext(`JSON.parse === originalPausedJsonParse`, pausedContext),
    true,
  );
  vm.runInContext(
    `globalThis.ytInitialPlayerResponse = { adSlots: [{ id: "allowed" }] }`,
    pausedContext,
  );
  assert.equal(
    vm.runInContext(
      `Object.hasOwn(ytInitialPlayerResponse, "adSlots")`,
      pausedContext,
    ),
    false,
  );

  const existingValueDocumentElement = new FakeElement();
  existingValueDocumentElement.setAttribute("data-lae-player", "on");
  const existingValueContext = vm.createContext({
    URL,
    document: {
      documentElement: existingValueDocumentElement,
      addEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    location: {
      href: "https://www.youtube.com/watch?v=existing1",
      hostname: "www.youtube.com",
    },
    MutationObserver: FakeMutationObserver,
    queueMicrotask(callback) {
      callback();
    },
    sessionStorage: { getItem: () => null },
    setInterval() {
      return 1;
    },
  });
  existingValueContext.window = existingValueContext;
  existingValueContext.top = existingValueContext;
  vm.runInContext(
    `
      Object.defineProperty(window, "ytInitialPlayerResponse", {
        configurable: true,
        enumerable: false,
        value: {
          adPlacements: [{ id: "existing-ad" }],
          videoDetails: { videoId: "existing1" }
        },
        writable: true
      });
    `,
    existingValueContext,
  );
  vm.runInContext(source, existingValueContext, { filename: "youtube-main.js" });
  assert.equal(
    vm.runInContext(
      `Object.hasOwn(ytInitialPlayerResponse, "adPlacements")`,
      existingValueContext,
    ),
    false,
  );
  assert.equal(
    vm.runInContext(
      `Object.getOwnPropertyDescriptor(window, "ytInitialPlayerResponse").enumerable`,
      existingValueContext,
    ),
    false,
  );
  assert.equal(
    vm.runInContext(
      `Object.getOwnPropertyDescriptor(window, "ytInitialPlayerResponse").get === undefined`,
      existingValueContext,
    ),
    true,
  );
}

function collectUbolYoutubeScriptlets(relativePath) {
  const absolutePath = path.join(rootDirectory, relativePath);
  let source = fs.readFileSync(absolutePath, "utf8");
  const invocationPattern =
    /try \{ fn\(\.\.\.arglist\.slice\(1\)\.map\(a => args\[a\]\)\); \}\r?\n\s*catch \{ \}/;
  assert.match(source, invocationPattern);
  source = source.replace(
    invocationPattern,
    `try {
      globalThis.__calls.push({
        name: fn.name,
        args: arglist.slice(1).map(a => args[a]),
      });
    } catch (error) {
      globalThis.__errors.push(String(error));
    }`,
  );

  const context = {
    document: {
      location: {
        ancestorOrigins: [],
        origin: "https://www.youtube.com",
      },
    },
    __calls: [],
    __errors: [],
  };
  vm.runInNewContext(source, context, { filename: relativePath });
  assert.deepEqual(context.__errors, []);
  return context.__calls;
}

function testUbolYoutubeScriptlets() {
  const mainCalls = collectUbolYoutubeScriptlets(
    "vendor/ublock-origin-lite/ublock-filters-main.js",
  );
  const isolatedCalls = collectUbolYoutubeScriptlets(
    "vendor/ublock-origin-lite/ublock-filters-isolated.js",
  );
  const mainNames = mainCalls.map((call) => call.name);
  const isolatedNames = isolatedCalls.map((call) => call.name);

  assert.ok(
    mainNames.filter((name) => name === "trustedJsonEditXhrRequest").length >= 4,
  );
  assert.ok(mainNames.includes("jsonPruneFetchResponse"));
  assert.ok(mainNames.includes("jsonPruneXhrResponse"));
  assert.ok(mainNames.includes("trustedReplaceFetchResponse"));
  assert.equal(
    mainNames.filter((name) => name === "trustedPreventDomBypass").length,
    3,
  );

  const requestEdits = mainCalls
    .filter((call) => call.name === "trustedJsonEditXhrRequest")
    .flatMap((call) => call.args);
  assert.ok(requestEdits.some((argument) => argument.includes('userAgent*="channel"')));
  assert.ok(requestEdits.some((argument) => argument.includes('userAgent*="lactmilli"')));
  assert.ok(requestEdits.some((argument) => argument.includes("lactMilliseconds")));

  assert.ok(isolatedNames.includes("replaceNodeText"));
  assert.ok(isolatedNames.includes("removeNodeText"));
  const serverContract = isolatedCalls.find(
    (call) =>
      call.name === "replaceNodeText" &&
      call.args[1] === "(function serverContract()",
  );
  assert.ok(serverContract);
  const replacement = serverContract.args[2];
  for (const marker of [
    "support.google.com/youtube/answer/3037019",
    "onAbnormalityDetected",
    "onSnackbarMessage",
    "lactmilli",
    "loadVideoById",
  ]) {
    assert.ok(replacement.includes(marker), `serverContract 누락: ${marker}`);
  }
}

async function testChzzkQualityUnthrottle() {
  const source = fs.readFileSync(
    path.join(rootDirectory, "sites", "chzzk.js"),
    "utf8",
  );
  const throttled = JSON.stringify({
    status: "STARTED",
    playableStatus: "FORCE_LOW_RESOLUTION",
    trafficThrottling: 3_200_000,
    callPeriodMilliSecond: 10_000,
  });
  const relaxed = JSON.stringify({
    status: "STARTED",
    playableStatus: "PLAYABLE",
    trafficThrottling: -1,
    callPeriodMilliSecond: 10_000,
  });
  const buildResponse = (url, content) => {
    const response = new Response(JSON.stringify({ code: 200, content }), {
      status: 200,
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };

  let served = null;
  const context = vm.createContext({
    Object,
    Promise,
    Response,
    URL,
    location: new URL("https://chzzk.naver.com/live/abc"),
    document: { documentElement: { getAttribute: () => "on" } },
    fetch: async () => served,
  });
  vm.runInContext("window = globalThis", context);
  vm.runInContext(source, context, { filename: "sites/chzzk.js" });
  const patchedFetch = context.window.fetch;

  // 10초 주기 폴링 응답의 상한을 무제한으로 되돌립니다.
  const statusUrl =
    "https://api.chzzk.naver.com/polling/v3/channels/abc/live-status";
  served = buildResponse(statusUrl, { livePollingStatusJson: throttled });
  let body = await (await patchedFetch(statusUrl)).json();
  let status = JSON.parse(body.content.livePollingStatusJson);
  assert.equal(status.playableStatus, "PLAYABLE");
  assert.equal(status.trafficThrottling, -1);
  assert.equal(status.callPeriodMilliSecond, 10_000);

  // 최초 진입 시 읽는 live-detail도 같은 필드를 갖고 있습니다.
  const detailUrl =
    "https://api.chzzk.naver.com/service/v3/channels/abc/live-detail";
  served = buildResponse(detailUrl, {
    livePlaybackJson: "{}",
    livePollingStatusJson: throttled,
  });
  body = await (await patchedFetch(detailUrl)).json();
  assert.equal(
    JSON.parse(body.content.livePollingStatusJson).trafficThrottling,
    -1,
  );
  assert.equal(body.content.livePlaybackJson, "{}");

  // 상한이 없는 응답과 대상이 아닌 요청은 원본 그대로 통과시킵니다.
  served = buildResponse(statusUrl, { livePollingStatusJson: relaxed });
  assert.equal(await patchedFetch(statusUrl), served);

  const otherUrl = "https://api.chzzk.naver.com/service/v1/channels/abc";
  served = buildResponse(otherUrl, { livePollingStatusJson: throttled });
  assert.equal(await patchedFetch(otherUrl), served);

  // pre-roll 광고 게이트는 live-detail의 skipPreRollAd로도 닫습니다.
  served = buildResponse(detailUrl, {
    livePollingStatusJson: relaxed,
    skipPreRollAd: false,
  });
  body = await (await patchedFetch(detailUrl)).json();
  assert.equal(body.content.skipPreRollAd, true);

  // 광고 정책 응답은 pre/mid/post-roll 플래그를 모두 내립니다.
  const adUrl =
    "https://api.chzzk.naver.com/service/v1/seoraksan?pgType=CHZZK_LIVE&pgId=abc";
  served = buildResponse(adUrl, {
    playerAdDisplayResponse: { preRoll: true, midRoll: true, postRoll: true },
  });
  body = await (await patchedFetch(adUrl)).json();
  assert.deepEqual(body.content.playerAdDisplayResponse, {
    preRoll: false,
    midRoll: false,
    postRoll: false,
  });

  // 재생 정보처럼 위장된 플래그도 같은 의미로 처리합니다.
  served = buildResponse(adUrl, {
    livePlaybackJson: { liveId: true, chatChannelId: true },
  });
  body = await (await patchedFetch(adUrl)).json();
  assert.deepEqual(body.content.livePlaybackJson, {
    liveId: false,
    chatChannelId: false,
  });

  // live-detail의 livePlaybackJson은 문자열이라 광고 처리 대상이 아닙니다.
  served = buildResponse(detailUrl, {
    livePlaybackJson: "{}",
    livePollingStatusJson: relaxed,
    skipPreRollAd: true,
  });
  assert.equal(await patchedFetch(detailUrl), served);
}

await testPopup();
await testPopupRollback();
await testBackground();
await testContentScriptUsesTopLevelSite();
await testYoutubeLegacyMarkerCleanup();
await testContentScriptInstallsCosmeticRules();
testNoSilentYoutubeAllowMessages();
testYoutubeEarlyGuard();
await testYoutubeMainScript();
await testYoutubeDesktopHookScope();
testUbolYoutubeScriptlets();
await testChzzkQualityUnthrottle();

console.log(
  "스모크 테스트 완료: 팝업 상태, 설정 롤백, 호스트별 DNR 예외, 범용·도메인별 cosmetic 예외, v1.3 탭 허용 마이그레이션, 기존 YouTube 회귀 항목, uBOL MAIN/ISOLATED 요청 편집·serverContract 적용, 치지직 서버 화질 상한·광고 재생 무력화, SOOP 등록·보조 규칙·배지·fallback",
);
