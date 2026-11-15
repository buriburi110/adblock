const PRIMARY_RULESET_ID = "easylist";
const FALLBACK_RULESET_ID = "ads";
const SOOP_RULESET_ID = "soop";
const PLAYER_COMPAT_RULESET_ID = "player_compat";
const MANAGED_RULESET_IDS = [
  PRIMARY_RULESET_ID,
  FALLBACK_RULESET_ID,
  SOOP_RULESET_ID,
  PLAYER_COMPAT_RULESET_ID,
];
const ALLOWLIST_RULE_ID_START = 900001;
const MAX_DISABLED_SITES = 1000;
const WEB_SCHEMES = ["http", "https"];
// 기존 ID를 유지해 업데이트 시 Chrome에 남아 있는 동적 등록도 제자리에서
// 공식 uBOL scriptlet 번들로 교체합니다.
const YOUTUBE_CONTENT_SCRIPT_ID = "youtube-main-world";
const YOUTUBE_GUARD_SCRIPT_ID = "youtube-early-guard";
const YOUTUBE_CONTENT_SCRIPT_IDS = [
  YOUTUBE_CONTENT_SCRIPT_ID,
  YOUTUBE_GUARD_SCRIPT_ID,
];
const COSMETIC_RULES_PATH = "rules/cosmetic-specific.json";
const MAX_COSMETIC_SELECTORS_PER_DOCUMENT = 10_000;
// v1.3에서 자동 복구용으로 만들었던 탭별 허용 규칙 범위입니다.
// v1.4에서는 새 규칙을 만들지 않고 기존 규칙을 제거할 때만 사용합니다.
const YOUTUBE_TAB_RULE_ID_START = 1_100_001;
const MAX_YOUTUBE_PAUSED_TABS = 1000;
const LEGACY_YOUTUBE_PAUSE_KEY = "__lae_yt_pause_v1";
const LEGACY_YOUTUBE_MIGRATION_KEY = "youtubeAutoPauseV1Migrated";
const DEFAULT_ACTION_TITLE = "가벼운 광고 차단기";
const YOUTUBE_HOSTNAMES = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "tv.youtube.com",
  "www.youtube-nocookie.com",
];
const YOUTUBE_MATCHES = YOUTUBE_HOSTNAMES.map(
  (hostname) => `https://${hostname}/*`,
);
const CHZZK_CONTENT_SCRIPT_ID = "chzzk-quality-main-world";
const CHZZK_HOSTNAME = "chzzk.naver.com";
const CHZZK_MATCHES = [`https://${CHZZK_HOSTNAME}/*`];
const SOOP_CONTENT_SCRIPT_ID = "soop-vod-main-world";
const SOOP_HOSTNAME = "vod.sooplive.com";
const SOOP_MATCHES = [`https://${SOOP_HOSTNAME}/*`];
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  disabledSites: [],
});

let syncQueue = Promise.resolve();
let migrationQueue = Promise.resolve();
let cosmeticRulesPromise = null;

// Page-local protection diagnostics are deliberately volatile. Keep only browser
// document identities, fixed reason codes and bounded counters, never URLs,
// cookies, DOM text, destinations or event payloads from the page.
const HIJACK_REASON_CODES = new Set([
  "known-overlay", "ad-overlay", "ad-link", "ad-popup", "strict-popup",
]);
const MAX_HIJACK_TABS = 100;
const MAX_HIJACK_FRAMES = 100;
const HIJACK_COUNTER_LIMIT = 999;
const hijackTabs = new Map();
let hijackReportSequence = 0;

function hijackCounter(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(HIJACK_COUNTER_LIMIT, Math.max(0, Math.floor(value)))
    : 0;
}

function sanitizeHijackStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.active !== "boolean" || typeof value.strict !== "boolean" ||
      !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0) {
    return null;
  }
  return {
    active: value.active,
    strict: value.strict,
    blockedCount: hijackCounter(value.blockedCount),
    overlayCount: hijackCounter(value.overlayCount),
    popupCount: hijackCounter(value.popupCount),
    linkCount: hijackCounter(value.linkCount),
    canAllowOnce: value.canAllowOnce === true,
    temporarilyAllowed: value.temporarilyAllowed === true,
    reasonCodes: [...new Set(
      (Array.isArray(value.reasonCodes) ? value.reasonCodes.slice(0, 32) : [])
        .filter(reason => typeof reason === "string" && HIJACK_REASON_CODES.has(reason)),
    )],
    timeOrigin: value.timeOrigin,
  };
}

function recordHijackStatus(message, sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  const documentId = sender?.documentId;
  const status = sanitizeHijackStatus(message?.status);
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(frameId) || frameId < 0 ||
      typeof documentId !== "string" || !documentId || documentId.length > 128 ||
      (sender.documentLifecycle && sender.documentLifecycle !== "active") || !status) {
    return { ok: false, error: "페이지 보호 상태를 확인할 수 없습니다." };
  }

  let tab = hijackTabs.get(tabId);
  if (!tab) {
    if (hijackTabs.size >= MAX_HIJACK_TABS) hijackTabs.delete(hijackTabs.keys().next().value);
    tab = { rootDocumentId: null, frames: new Map() };
    hijackTabs.set(tabId, tab);
  }
  const previousRoot = tab.frames.get(tab.rootDocumentId);
  if (frameId === 0 && previousRoot &&
      status.timeOrigin < previousRoot.status.timeOrigin) {
    return { ok: false, error: "이전 페이지의 보호 상태는 적용하지 않습니다." };
  }
  // A new top-level document starts a new page. Old iframe reports must not
  // survive a navigation or receive a command intended for that previous page.
  if (frameId === 0 && tab.rootDocumentId !== documentId) {
    if (tab.rootDocumentId !== null) tab.frames.clear();
    tab.rootDocumentId = documentId;
  }
  for (const [id, record] of tab.frames) {
    if (record.frameId === frameId && id !== documentId) tab.frames.delete(id);
  }
  if (!tab.frames.has(documentId) && tab.frames.size >= MAX_HIJACK_FRAMES) {
    const oldestChild = [...tab.frames].find(([, record]) => record.frameId !== 0);
    if (oldestChild) tab.frames.delete(oldestChild[0]);
    else return { ok: false, error: "페이지 보호 상태 수가 제한을 넘었습니다." };
  }
  tab.frames.set(documentId, { frameId, status, sequence: ++hijackReportSequence });
  return { ok: true };
}

function aggregateHijackStatus(tabId) {
  const tab = hijackTabs.get(tabId);
  const records = [...(tab?.frames.values() ?? [])];
  const root = records.find(record => record.frameId === 0)?.status;
  if (!root || !tab?.rootDocumentId) {
    return { ok: false, error: "페이지 보호 상태가 준비되지 않았습니다. 페이지를 새로고침한 뒤 다시 확인해 주세요." };
  }
  const sum = key => Math.min(HIJACK_COUNTER_LIMIT,
    records.reduce((total, record) => total + record.status[key], 0));
  return {
    ok: true,
    pageToken: tab.rootDocumentId,
    active: root?.active ?? false,
    strict: root?.strict ?? false,
    blockedCount: sum("blockedCount"),
    overlayCount: sum("overlayCount"),
    popupCount: sum("popupCount"),
    linkCount: sum("linkCount"),
    canAllowOnce: records.some(record => record.status.canAllowOnce),
    temporarilyAllowed: records.some(record => record.status.temporarilyAllowed),
    reasonCodes: [...new Set(records.flatMap(record => record.status.reasonCodes))],
    timeOrigin: root?.timeOrigin ?? 0,
  };
}

function removeHijackDocument(tab, documentId) {
  tab.frames.delete(documentId);
  if (tab.rootDocumentId === documentId) tab.rootDocumentId = null;
}

function boundedHijackMessage(tabId, message, options) {
  // A stale/closed/suspended document or a missing listener must not keep the
  // popup waiting, nor expose browser errors containing page addresses.
  return new Promise(resolve => {
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 250);
    try {
      Promise.resolve(chrome.tabs.sendMessage(tabId, message, options))
        .then(finish, () => finish(null));
    } catch {
      finish(null);
    }
  });
}

async function refreshHijackDocuments(tabId) {
  // Rebuild RAM after service-worker suspension. Each live content script sends
  // its own report; only Chrome's sender metadata selects the owning document.
  // Establish the root first so a new root report cannot discard child reports
  // from the immediately following all-frame announcement.
  await boundedHijackMessage(tabId, { type: "hijack-announce" }, { frameId: 0 });
  await boundedHijackMessage(tabId, { type: "hijack-announce" });
  await new Promise(resolve => setTimeout(resolve, 100));
  const tab = hijackTabs.get(tabId);
  if (!tab) return;
  const records = [...tab.frames];
  await Promise.all(records.map(async ([documentId, record]) => {
    const reply = await boundedHijackMessage(tabId, { type: "hijack-announce" }, { documentId });
    const currentTab = hijackTabs.get(tabId);
    if (currentTab !== tab) return;
    const current = tab.frames.get(documentId);
    if (!current) return;
    const status = sanitizeHijackStatus(reply?.status ?? reply);
    if (status && status.timeOrigin === record.status.timeOrigin) {
      current.status = status;
    } else if (current.sequence === record.sequence) {
      // A listener may report asynchronously without returning a response. A new
      // validated report is enough to keep that document, but old data is not.
      removeHijackDocument(tab, documentId);
    }
  }));
  if (!tab.rootDocumentId || !tab.frames.has(tab.rootDocumentId)) {
    // A BFCache restoration can have an older timeOrigin than the page it
    // replaces. Only accept that root after the old document failed the live
    // document check above; an unsolicited late old report cannot replace it.
    await boundedHijackMessage(tabId, { type: "hijack-announce" }, { frameId: 0 });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function handleHijackUi(message, sender) {
  if (sender?.url !== chrome.runtime.getURL("popup/popup.html") ||
      !Number.isInteger(message?.tabId) || message.tabId < 0) {
    return { ok: false, error: "보호 설정은 확장 프로그램 팝업에서만 바꿀 수 있습니다." };
  }
  const tabId = message.tabId;
  const isCommand = message.type !== "hijack-status";
  const expectedPageToken = message.expectedPageToken;
  const pageChanged = () => ({
    ok: false, error: "페이지가 바뀌었습니다. 보호 상태를 다시 확인한 뒤 시도해 주세요.",
  });
  if (isCommand && (typeof expectedPageToken !== "string" || !expectedPageToken ||
      hijackTabs.get(tabId)?.rootDocumentId !== expectedPageToken)) return pageChanged();
  await refreshHijackDocuments(tabId);
  if (message.type === "hijack-status") return aggregateHijackStatus(tabId);

  const tab = hijackTabs.get(tabId);
  if (tab?.rootDocumentId !== expectedPageToken || !tab.frames.has(expectedPageToken)) return pageChanged();
  const records = [...(tab?.frames ?? [])];
  if (!records.length) return { ok: false, error: "페이지를 새로고침한 뒤 다시 시도해 주세요." };
  const action = message.type === "hijack-allow-once" ? "allow-page" : "restore";
  let applied = 0;
  await Promise.all(records.map(async ([documentId, record]) => {
    // Commands never broadcast: the UI only controls documents observed above,
    // not new frames or a new page that appears while the popup is working.
    if (hijackTabs.get(tabId) !== tab || tab.rootDocumentId !== expectedPageToken) return;
    const reply = await boundedHijackMessage(tabId,
      { type: "hijack-command", action }, { documentId });
    if (hijackTabs.get(tabId) !== tab || tab.rootDocumentId !== expectedPageToken) return;
    const current = tab.frames.get(documentId);
    if (!current) return;
    const status = sanitizeHijackStatus(reply?.status ?? reply);
    if (status && status.timeOrigin === record.status.timeOrigin) {
      current.status = status;
      applied += 1;
    } else if (current.sequence === record.sequence) {
      removeHijackDocument(tab, documentId);
    } else {
      applied += 1;
    }
  }));
  if (applied !== records.length || hijackTabs.get(tabId) !== tab || tab.rootDocumentId !== expectedPageToken) {
    return { ok: false, error: "일부 페이지가 바뀌었거나 응답하지 않습니다. 보호 상태를 다시 확인해 주세요." };
  }
  return aggregateHijackStatus(tabId);
}

function normalizeHostname(value) {
  const candidate = String(value ?? "").trim().toLowerCase();

  if (!candidate || candidate.length > 253) {
    return "";
  }

  try {
    return new URL(`http://${candidate}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostnameMatchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function hostnameSuffixes(hostname) {
  if (/^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")) {
    return [hostname];
  }

  const labels = hostname.split(".");
  return labels.map((_label, index) => labels.slice(index).join("."));
}

async function loadCosmeticRules() {
  if (!cosmeticRulesPromise) {
    cosmeticRulesPromise = fetch(chrome.runtime.getURL(COSMETIC_RULES_PATH))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`cosmetic rules HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((rules) => {
        if (
          rules?.schemaVersion !== 2 ||
          !Array.isArray(rules.conditionalGeneric) ||
          !rules.include ||
          !rules.exception ||
          !Array.isArray(rules.genericHideDisabledDomains) ||
          !Array.isArray(rules.elementHideDisabledDomains)
        ) {
          throw new Error("cosmetic rules schema mismatch");
        }
        return rules;
      })
      .catch((error) => {
        cosmeticRulesPromise = null;
        throw error;
      });
  }
  return cosmeticRulesPromise;
}

function collectCosmeticSelectors(index, hostname) {
  const selectors = new Set();

  for (const suffix of hostnameSuffixes(hostname)) {
    const entries = index[suffix];
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      const selector = entry?.[0];
      const excludedDomains = entry?.[1];
      if (
        typeof selector !== "string" ||
        !Array.isArray(excludedDomains) ||
        excludedDomains.some((domain) =>
          hostnameMatchesDomain(hostname, domain),
        )
      ) {
        continue;
      }
      selectors.add(selector);
      if (selectors.size >= MAX_COSMETIC_SELECTORS_PER_DOCUMENT) {
        return selectors;
      }
    }
  }

  return selectors;
}

function hostnameMatchesAnyDomain(hostname, domains) {
  return domains.some(
    (domain) =>
      typeof domain === "string" && hostnameMatchesDomain(hostname, domain),
  );
}

async function getCosmeticRules(message, sender) {
  const requestedHostname = normalizeHostname(message?.hostname);
  let senderHostname = "";
  try {
    const senderUrl = new URL(sender?.url ?? "");
    if (["http:", "https:"].includes(senderUrl.protocol)) {
      senderHostname = normalizeHostname(senderUrl.hostname);
    }
  } catch {
    // about:blank처럼 호스트가 없는 프레임은 content script가 전달한 호스트를 사용합니다.
  }

  const hostname = senderHostname || requestedHostname;
  if (!hostname) {
    return {
      genericActive: false,
      genericSelectors: [],
      specificActive: false,
      specificSelectors: [],
    };
  }

  const rules = await loadCosmeticRules();
  const elementHideDisabled = hostnameMatchesAnyDomain(
    hostname,
    rules.elementHideDisabledDomains,
  );
  const genericHideDisabled =
    elementHideDisabled ||
    hostnameMatchesAnyDomain(hostname, rules.genericHideDisabledDomains);
  const genericSelectors = genericHideDisabled
    ? new Set()
    : new Set(rules.conditionalGeneric);
  const specificSelectors = elementHideDisabled
    ? new Set()
    : collectCosmeticSelectors(rules.include, hostname);
  const exceptions = collectCosmeticSelectors(rules.exception, hostname);
  for (const selector of exceptions) {
    genericSelectors.delete(selector);
    specificSelectors.delete(selector);
  }

  return {
    genericActive: !genericHideDisabled,
    genericSelectors: [...genericSelectors]
      .sort()
      .slice(0, MAX_COSMETIC_SELECTORS_PER_DOCUMENT),
    specificActive: !elementHideDisabled,
    specificSelectors: [...specificSelectors]
      .sort()
      .slice(0, MAX_COSMETIC_SELECTORS_PER_DOCUMENT),
  };
}

function sanitizeDisabledSites(sites) {
  if (!Array.isArray(sites)) {
    return [];
  }

  return [...new Set(sites.map(normalizeHostname).filter(Boolean))].slice(
    0,
    MAX_DISABLED_SITES,
  );
}

async function readSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const settings = {
    enabled:
      typeof stored.enabled === "boolean"
        ? stored.enabled
        : DEFAULT_SETTINGS.enabled,
    disabledSites: sanitizeDisabledSites(stored.disabledSites),
  };

  if (
    settings.enabled !== stored.enabled ||
    JSON.stringify(settings.disabledSites) !== JSON.stringify(stored.disabledSites)
  ) {
    await chrome.storage.local.set(settings);
  }

  return settings;
}

function isYoutubeHostname(hostname) {
  return YOUTUBE_HOSTNAMES.includes(hostname);
}

function youtubeExcludeMatches(disabledSites) {
  return disabledSites
    .filter(isYoutubeHostname)
    .map((hostname) => `https://${hostname}/*`);
}

async function syncYoutubeContentScript(settings) {
  const registeredScripts = await chrome.scripting.getRegisteredContentScripts({
    ids: YOUTUBE_CONTENT_SCRIPT_IDS,
  });
  const registeredIds = new Set(registeredScripts.map((script) => script.id));

  if (!settings.enabled) {
    if (registeredIds.size) {
      await chrome.scripting.unregisterContentScripts({
        ids: [...registeredIds],
      });
    }
    return;
  }

  const excludeMatches = youtubeExcludeMatches(settings.disabledSites);
  const registrations = [
    {
      id: YOUTUBE_CONTENT_SCRIPT_ID,
      allFrames: true,
      excludeMatches,
      js: ["vendor/ublock-origin-lite/ublock-filters-main.js"],
      matchOriginAsFallback: true,
      matches: YOUTUBE_MATCHES,
      persistAcrossSessions: true,
      runAt: "document_start",
      world: "MAIN",
    },
    {
      id: YOUTUBE_GUARD_SCRIPT_ID,
      allFrames: true,
      excludeMatches,
      js: ["vendor/ublock-origin-lite/ublock-filters-isolated.js"],
      matchOriginAsFallback: true,
      matches: YOUTUBE_MATCHES,
      persistAcrossSessions: true,
      runAt: "document_start",
      world: "ISOLATED",
    },
  ];
  const updates = registrations.filter((script) => registeredIds.has(script.id));
  const additions = registrations.filter(
    (script) => !registeredIds.has(script.id),
  );

  if (updates.length) {
    await chrome.scripting.updateContentScripts(updates);
  }
  if (additions.length) {
    await chrome.scripting.registerContentScripts(additions);
  }
}

async function syncChzzkContentScript(settings) {
  const registeredScripts = await chrome.scripting.getRegisteredContentScripts({
    ids: [CHZZK_CONTENT_SCRIPT_ID],
  });

  if (!settings.enabled) {
    if (registeredScripts.length) {
      await chrome.scripting.unregisterContentScripts({
        ids: [CHZZK_CONTENT_SCRIPT_ID],
      });
    }
    return;
  }

  const registration = {
    id: CHZZK_CONTENT_SCRIPT_ID,
    allFrames: true,
    excludeMatches: settings.disabledSites.includes(CHZZK_HOSTNAME)
      ? CHZZK_MATCHES
      : [],
    js: ["sites/chzzk.js"],
    matches: CHZZK_MATCHES,
    persistAcrossSessions: true,
    runAt: "document_start",
    world: "MAIN",
  };

  if (registeredScripts.length) {
    await chrome.scripting.updateContentScripts([registration]);
  } else {
    await chrome.scripting.registerContentScripts([registration]);
  }
}

async function syncSoopContentScript(settings) {
  const registeredScripts = await chrome.scripting.getRegisteredContentScripts({
    ids: [SOOP_CONTENT_SCRIPT_ID],
  });

  if (!settings.enabled) {
    if (registeredScripts.length) {
      await chrome.scripting.unregisterContentScripts({
        ids: [SOOP_CONTENT_SCRIPT_ID],
      });
    }
    return;
  }

  const registration = {
    id: SOOP_CONTENT_SCRIPT_ID,
    allFrames: true,
    excludeMatches: settings.disabledSites.includes(SOOP_HOSTNAME)
      ? SOOP_MATCHES
      : [],
    js: ["sites/soop.js"],
    matches: SOOP_MATCHES,
    persistAcrossSessions: true,
    runAt: "document_start",
    world: "MAIN",
  };

  if (registeredScripts.length) {
    await chrome.scripting.updateContentScripts([registration]);
  } else {
    await chrome.scripting.registerContentScripts([registration]);
  }
}

function isYoutubePauseRule(rule) {
  return (
    rule.id >= YOUTUBE_TAB_RULE_ID_START &&
    rule.id < YOUTUBE_TAB_RULE_ID_START + MAX_YOUTUBE_PAUSED_TABS
  );
}

async function clearLegacyYoutubeBadge(tabId) {
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: "" }),
      chrome.action.setTitle({
        tabId,
        title: DEFAULT_ACTION_TITLE,
      }),
    ]);
  } catch {
    // 마이그레이션 중 탭이 닫히면 탭별 배지 상태도 함께 사라집니다.
  }
}

async function removeLegacyYoutubeMarker(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      args: [LEGACY_YOUTUBE_PAUSE_KEY],
      func(key) {
        try {
          const existed = sessionStorage.getItem(key) !== null;
          sessionStorage.removeItem(key);
          return existed;
        } catch {
          return false;
        }
      },
      target: { tabId, frameIds: [0] },
      world: "MAIN",
    });
    return Boolean(injection?.result);
  } catch {
    // 닫혔거나 아직 스크립트를 삽입할 수 없는 탭은 다음 탐색 때 content.js가 정리합니다.
    return false;
  }
}

async function migrateLegacyYoutubeAutoPause() {
  const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
  const legacyRules = sessionRules.filter(isYoutubePauseRule);
  const legacyTabIds = new Set(
    legacyRules.flatMap((rule) => rule.condition?.tabIds ?? []),
  );
  const migrationState = await chrome.storage.local.get({
    [LEGACY_YOUTUBE_MIGRATION_KEY]: false,
  });

  if (legacyRules.length) {
    // 광고 요청이 다시 허용되는 순간을 만들지 않도록 규칙을 가장 먼저 제거합니다.
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [],
      removeRuleIds: legacyRules.map((rule) => rule.id),
    });
  }

  const shouldScanYoutubeTabs =
    legacyRules.length > 0 ||
    migrationState[LEGACY_YOUTUBE_MIGRATION_KEY] !== true;
  const youtubeTabs = shouldScanYoutubeTabs
    ? await chrome.tabs.query({ url: YOUTUBE_MATCHES })
    : [];
  const youtubeTabsById = new Map(
    youtubeTabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => [tab.id, tab]),
  );
  const affectedTabIds = new Set([
    ...legacyTabIds,
    ...youtubeTabsById.keys(),
  ]);

  for (const tabId of affectedTabIds) {
    const hadMarker = youtubeTabsById.has(tabId)
      ? await removeLegacyYoutubeMarker(tabId)
      : false;
    const wasAffected = legacyTabIds.has(tabId) || hadMarker;

    if (!wasAffected) {
      continue;
    }

    await clearLegacyYoutubeBadge(tabId);

    if (youtubeTabsById.has(tabId)) {
      try {
        // 기존 문서에는 v1.3 MAIN-world 코드가 남아 있으므로 새 코드로 한 번만 교체합니다.
        await chrome.tabs.reload(tabId);
      } catch {
        // 다른 탭의 마이그레이션은 계속합니다.
      }
    }
  }

  if (migrationState[LEGACY_YOUTUBE_MIGRATION_KEY] !== true) {
    await chrome.storage.local.set({ [LEGACY_YOUTUBE_MIGRATION_KEY]: true });
  }
}

function queueLegacyYoutubeMigration() {
  const result = migrationQueue.then(
    migrateLegacyYoutubeAutoPause,
    migrateLegacyYoutubeAutoPause,
  );
  migrationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function applySettings() {
  const settings = await readSettings();
  await syncYoutubeContentScript(settings);
  await syncChzzkContentScript(settings);
  await syncSoopContentScript(settings);
  const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  const enabledManagedRulesets = MANAGED_RULESET_IDS.filter((rulesetId) =>
    enabledRulesets.includes(rulesetId),
  );

  if (!settings.enabled && enabledManagedRulesets.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [],
      disableRulesetIds: enabledManagedRulesets,
    });
  } else if (
    settings.enabled &&
    (!enabledRulesets.includes(PRIMARY_RULESET_ID) ||
      enabledRulesets.includes(FALLBACK_RULESET_ID) ||
      !enabledRulesets.includes(SOOP_RULESET_ID) ||
      !enabledRulesets.includes(PLAYER_COMPAT_RULESET_ID))
  ) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: [PRIMARY_RULESET_ID, SOOP_RULESET_ID, PLAYER_COMPAT_RULESET_ID],
        disableRulesetIds: [FALLBACK_RULESET_ID],
      });
    } catch (error) {
      console.warn(
        "EasyList를 활성화하지 못해 소형 기본 목록으로 전환합니다.",
        error,
      );
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: [FALLBACK_RULESET_ID, SOOP_RULESET_ID, PLAYER_COMPAT_RULESET_ID],
        disableRulesetIds: [PRIMARY_RULESET_ID],
      });
    }
  }

  const currentDynamicRules =
    await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentDynamicRules
    .filter(
      (rule) =>
        rule.id >= ALLOWLIST_RULE_ID_START &&
        rule.id <
          ALLOWLIST_RULE_ID_START + MAX_DISABLED_SITES * WEB_SCHEMES.length,
    )
    .map((rule) => rule.id);
  const addRules = settings.disabledSites.flatMap((hostname, siteIndex) =>
    WEB_SCHEMES.map((scheme, schemeIndex) => ({
      id:
        ALLOWLIST_RULE_ID_START +
        siteIndex * WEB_SCHEMES.length +
        schemeIndex,
      priority: 10000,
      action: { type: "allowAllRequests" },
      condition: {
        urlFilter: `|${scheme}://${hostname}^`,
        requestDomains: [hostname],
        resourceTypes: ["main_frame"],
      },
    })),
  );

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });

  await chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: settings.enabled,
  });
  await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
}

function queueSettingsSync() {
  syncQueue = syncQueue.then(applySettings, applySettings);
  return syncQueue;
}

async function initialize() {
  const stored = await chrome.storage.local.get(["enabled", "disabledSites"]);
  const updates = {};

  if (typeof stored.enabled !== "boolean") {
    updates.enabled = DEFAULT_SETTINGS.enabled;
  }

  const normalizedSites = sanitizeDisabledSites(stored.disabledSites);
  if (JSON.stringify(normalizedSites) !== JSON.stringify(stored.disabledSites ?? [])) {
    updates.disabledSites = normalizedSites;
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }

  await queueSettingsSync();
  await queueLegacyYoutubeMigration();
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((error) => {
    console.error("확장 프로그램 초기화에 실패했습니다.", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((error) => {
    console.error("차단 설정을 복원하지 못했습니다.", error);
  });
});

chrome.tabs.onRemoved?.addListener(tabId => hijackTabs.delete(tabId));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    (Object.hasOwn(changes, "enabled") || Object.hasOwn(changes, "disabledSites"))
  ) {
    queueSettingsSync().catch((error) => {
      console.error("차단 설정을 적용하지 못했습니다.", error);
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let operation;

  if (message?.type === "hijack-report") {
    sendResponse(recordHijackStatus(message, _sender));
    return false;
  } else if (["hijack-status", "hijack-allow-once", "hijack-restore"].includes(message?.type)) {
    operation = handleHijackUi(message, _sender);
  } else if (message?.type === "sync-settings") {
    operation = queueSettingsSync()
      .then(queueLegacyYoutubeMigration)
      .then(() => ({ ok: true }));
  } else if (message?.type === "get-cosmetic-rules") {
    operation = getCosmeticRules(message, _sender).then((result) => ({
      ok: true,
      ...result,
    }));
  } else {
    return false;
  }

  operation
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
