const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  disabledSites: [],
  hijackDisabledSites: [],
  hijackStrictSites: [],
});
const MAX_DISABLED_SITES = 1000;
const COUNTED_RULESET_IDS = new Set(["ads", "easylist", "soop"]);

const elements = {
  statusCard: document.querySelector("#status-card"),
  statusLabel: document.querySelector("#status-label"),
  statusTitle: document.querySelector("#status-title"),
  statusDescription: document.querySelector("#status-description"),
  blockedCount: document.querySelector("#blocked-count"),
  globalToggle: document.querySelector("#global-toggle"),
  siteToggle: document.querySelector("#site-toggle"),
  siteName: document.querySelector("#site-name"),
  hijackToggle: document.querySelector("#hijack-toggle"),
  hijackStrictToggle: document.querySelector("#hijack-strict-toggle"),
  hijackSummary: document.querySelector("#hijack-summary"),
  hijackReasons: document.querySelector("#hijack-reasons"),
  hijackAllowOnce: document.querySelector("#hijack-allow-once"),
  hijackRestore: document.querySelector("#hijack-restore"),
};

const state = {
  tabId: null,
  hostname: "",
  supportedPage: false,
  enabled: true,
  disabledSites: [],
  hijackDisabledSites: [],
  hijackStrictSites: [],
  hijackStatus: null,
  hijackBusy: false,
  hijackNotice: "",
  hijackControlsLocked: false,
  hijackRequestVersion: 0,
  blockedCount: null,
  busy: true,
  errorTitle: "",
  errorMessage: "",
  noticeTitle: "",
  noticeMessage: "",
  controlsLocked: true,
};

function siteMatches(hostname, disabledSite) {
  return hostname === disabledSite;
}

function normalizeDisabledSites(sites) {
  if (!Array.isArray(sites)) {
    return [];
  }

  return [
    ...new Set(
      sites
        .map((site) => String(site).trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, MAX_DISABLED_SITES);
}

function applyStoredSettings(settings) {
  state.enabled = settings.enabled !== false;
  state.disabledSites = normalizeDisabledSites(settings.disabledSites);
  // Ad toggle rollback snapshots contain only their own settings. Preserve the
  // independent hijack preferences unless they were actually read from storage.
  if (Object.hasOwn(settings, "hijackDisabledSites")) {
    state.hijackDisabledSites = normalizeDisabledSites(settings.hijackDisabledSites);
  }
  if (Object.hasOwn(settings, "hijackStrictSites")) {
    state.hijackStrictSites = normalizeDisabledSites(settings.hijackStrictSites);
  }
}

function isCurrentSiteDisabled() {
  return state.disabledSites.some((site) => siteMatches(state.hostname, site));
}

function setCardMode(mode) {
  elements.statusCard.classList.toggle("is-paused", mode === "paused");
  elements.statusCard.classList.toggle(
    "is-unavailable",
    mode === "unavailable",
  );
  elements.statusCard.classList.toggle("is-notice", mode === "notice");
}

function setControlDisabled(toggle, disabled) {
  if (!toggle) return;
  toggle.disabled = disabled;
  const row = toggle.closest(".control-row");
  row?.classList.toggle("is-disabled", disabled);
  row?.setAttribute("aria-disabled", String(disabled));
}

function render() {
  const siteDisabled = isCurrentSiteDisabled();
  const siteIsBlocking =
    state.enabled &&
    state.supportedPage &&
    !siteDisabled;
  const hasError = Boolean(state.errorMessage);
  const hasNotice = Boolean(state.noticeMessage);

  elements.globalToggle.checked = state.enabled;
  elements.siteToggle.checked = siteIsBlocking;
  setControlDisabled(
    elements.globalToggle,
    state.busy || state.hijackBusy || state.controlsLocked,
  );
  setControlDisabled(
    elements.siteToggle,
    state.busy || state.hijackBusy ||
      state.controlsLocked ||
      !state.enabled ||
      !state.supportedPage,
  );
  elements.statusCard.setAttribute("aria-busy", String(state.busy));
  elements.statusCard.setAttribute("role", hasError ? "alert" : "status");
  elements.statusCard.setAttribute(
    "aria-live",
    hasError ? "assertive" : "polite",
  );
  elements.siteName.textContent = state.supportedPage
    ? state.hostname
    : "일반 웹페이지에서만 사용할 수 있어요";
  renderHijack();

  if (state.errorMessage) {
    setCardMode("unavailable");
    elements.statusLabel.textContent = "오류";
    elements.statusTitle.textContent = state.errorTitle;
    elements.statusDescription.textContent = state.errorMessage;
    elements.blockedCount.textContent = "확인 필요";
    return;
  }

  if (hasNotice) {
    setCardMode("notice");
    elements.statusLabel.textContent = "새로고침 필요";
    elements.statusTitle.textContent = state.noticeTitle;
    elements.statusDescription.textContent = state.noticeMessage;
    elements.blockedCount.textContent = "저장됨";
    return;
  }

  if (!state.enabled) {
    setCardMode("paused");
    elements.statusLabel.textContent = "일시 중지";
    elements.statusTitle.textContent = "광고 차단이 꺼져 있어요";
    elements.statusDescription.textContent =
      "스위치를 켜면 사이트 예외를 제외하고 다시 차단합니다.";
    elements.blockedCount.textContent = "꺼짐";
    return;
  }

  if (!state.supportedPage) {
    setCardMode("unavailable");
    elements.statusLabel.textContent = "사용할 수 없음";
    elements.statusTitle.textContent = "이 페이지는 Chrome이 보호해요";
    elements.statusDescription.textContent =
      "Chrome 설정, 새 탭, 확장 프로그램 페이지에는 적용되지 않습니다.";
    elements.blockedCount.textContent = "—";
    return;
  }

  if (siteDisabled) {
    setCardMode("paused");
    elements.statusLabel.textContent = "사이트 예외";
    elements.statusTitle.textContent = "이 사이트에서는 쉬는 중";
    elements.statusDescription.textContent =
      "광고 차단과 납치 방지가 꺼져 있습니다. 사이트 스위치를 켜면 다시 차단합니다.";
    elements.blockedCount.textContent = "허용됨";
    return;
  }

  setCardMode("active");
  elements.statusLabel.textContent = "보호 중";
  elements.statusTitle.textContent = "광고 요청을 막고 있어요";
  elements.statusDescription.textContent = state.blockedCount > 0
    ? `현재 탭에서 ${state.blockedCount}개의 요청을 차단했습니다.`
    : "알려진 광고 요청과 광고 영역을 차단합니다.";
  elements.blockedCount.textContent = state.blockedCount > 0
    ? `${state.blockedCount}건 차단`
    : "활성";
}

const HIJACK_REASON_LABELS = Object.freeze({
  "known-overlay": "확인된 클릭 덮개",
  "ad-overlay": "광고 링크가 겹친 덮개",
  "ad-link": "확인된 광고 링크",
  "ad-popup": "확인된 광고 팝업",
  "strict-popup": "강화 모드 팝업",
});

function normalizeHijackStatus(response) {
  if (response?.ok !== true || typeof response.active !== "boolean" ||
      typeof response.pageToken !== "string" || !response.pageToken || response.pageToken.length > 256) {
    return null;
  }
  const count = value => Number.isFinite(value)
    ? Math.min(100_000, Math.max(0, Math.floor(value))) : 0;
  return {
    pageToken: response.pageToken,
    active: response.active,
    strict: response.strict === true,
    blockedCount: count(response.blockedCount),
    overlayCount: count(response.overlayCount),
    popupCount: count(response.popupCount),
    linkCount: count(response.linkCount),
    canAllowOnce: response.canAllowOnce === true,
    temporarilyAllowed: response.temporarilyAllowed === true,
    reasonCodes: [...new Set(Array.isArray(response.reasonCodes)
      ? response.reasonCodes.filter(code => Object.hasOwn(HIJACK_REASON_LABELS, code)) : [])],
  };
}

function renderHijack() {
  if (!elements.hijackToggle) return;
  const enabledHere = state.enabled && state.supportedPage && !isCurrentSiteDisabled();
  const selected = !state.hijackDisabledSites.includes(state.hostname);
  const status = state.hijackStatus;
  const locked = state.busy || state.hijackBusy || state.controlsLocked ||
    state.hijackControlsLocked || !enabledHere || !status;
  elements.hijackToggle.checked = enabledHere && selected;
  elements.hijackStrictToggle.checked = state.hijackStrictSites.includes(state.hostname);
  setControlDisabled(elements.hijackToggle, locked);
  setControlDisabled(elements.hijackStrictToggle, locked || !selected || status?.temporarilyAllowed);
  elements.hijackAllowOnce.disabled = locked || !selected || !status?.canAllowOnce || status?.temporarilyAllowed;
  elements.hijackRestore.disabled = locked || !selected || !status?.temporarilyAllowed;

  let summary;
  if (state.hijackNotice) summary = state.hijackNotice;
  else if (!state.supportedPage) summary = "일반 웹페이지에서만 사용할 수 있어요.";
  else if (!enabledHere) summary = "광고 차단과 함께 일시 중지됐어요.";
  else if (!selected) summary = "이 사이트의 납치 방지만 꺼져 있어요.";
  else if (!status) summary = "페이지를 새로고침하면 보호 상태를 확인할 수 있어요.";
  else if (status.temporarilyAllowed) summary = "이번 페이지에서 허용 중 · 새로고침하면 복구";
  else if (!status.active) summary = "보호 설정을 적용하는 중이에요.";
  else if (status.blockedCount > 0) summary =
    `덮개 ${status.overlayCount} · 링크 ${status.linkCount} · 팝업 ${status.popupCount}건`;
  else summary = status.strict ? "강화 보호 중 · 정상 팝업이 막히면 꺼 주세요." : "기본 보호 중 · 확인된 패턴만 차단해요.";
  elements.hijackSummary.textContent = summary;
  elements.hijackSummary.setAttribute("aria-busy", String(state.hijackBusy));
  elements.hijackReasons.textContent = status?.reasonCodes.length
    ? `차단 이유: ${status.reasonCodes.map(code => HIJACK_REASON_LABELS[code]).join(" · ")}`
    : "아직 확인된 차단 내역이 없어요.";
}

async function readHijackStatus({ required = false } = {}) {
  if (!elements.hijackToggle || !state.supportedPage || !Number.isInteger(state.tabId)) return;
  const version = ++state.hijackRequestVersion;
  try {
    const response = await chrome.runtime.sendMessage({ type: "hijack-status", tabId: state.tabId });
    const status = normalizeHijackStatus(response);
    if (!status) throw new Error("보호 상태를 확인하지 못했습니다.");
    if (version === state.hijackRequestVersion) state.hijackStatus = status;
  } catch {
    if (version === state.hijackRequestVersion) state.hijackStatus = null;
    if (required) throw new Error("페이지를 새로고침한 뒤 다시 시도해 주세요.");
  }
}

async function handleHijackSetting(event, key, enabledMeansIncluded) {
  if (state.busy || state.hijackBusy || state.controlsLocked || state.hijackControlsLocked ||
      !state.enabled || !state.supportedPage || isCurrentSiteDisabled() || !state.hijackStatus) return;
  const toggle = event.currentTarget ?? event.target;
  const include = event.target.checked === enabledMeansIncluded;
  let previous;
  state.hijackBusy = true;
  state.hijackRequestVersion += 1;
  state.hijackNotice = "";
  render();
  try {
    const stored = await chrome.storage.local.get({ [key]: [] });
    previous = normalizeDisabledSites(stored[key]);
    if (include && !previous.includes(state.hostname) && previous.length >= MAX_DISABLED_SITES) {
      throw new Error("사이트 설정이 가득 찼습니다.");
    }
    const next = previous.filter(hostname => hostname !== state.hostname);
    if (include) next.push(state.hostname);
    await chrome.storage.local.set({ [key]: next });
    state[key] = next;
    await readHijackStatus({ required: true });
  } catch {
    if (previous) {
      try {
        await chrome.storage.local.set({ [key]: previous });
        state[key] = previous;
        await readHijackStatus();
        state.hijackNotice = "설정을 바꾸지 못해 이전 상태로 되돌렸어요. 다시 시도해 주세요.";
      } catch {
        try {
          const actual = await chrome.storage.local.get({ [key]: [] });
          state[key] = normalizeDisabledSites(actual[key]);
          state.hijackNotice = "현재 저장된 설정을 표시했어요. 페이지를 새로고침해 주세요.";
        } catch {
          state.hijackControlsLocked = true;
          state.hijackNotice = "설정 상태를 확인할 수 없어요. 팝업을 닫고 다시 열어 주세요.";
        }
      }
    } else state.hijackNotice = "설정을 읽지 못했어요. 팝업을 닫고 다시 열어 주세요.";
  } finally {
    state.hijackBusy = false;
    render();
    toggle.focus?.({ preventScroll: true });
  }
}

async function handleHijackAction(type) {
  if (state.busy || state.hijackBusy || state.controlsLocked || state.hijackControlsLocked ||
      !state.enabled || !state.supportedPage || isCurrentSiteDisabled() ||
      state.hijackDisabledSites.includes(state.hostname) || !state.hijackStatus) return;
  state.hijackBusy = true;
  state.hijackRequestVersion += 1;
  state.hijackNotice = "";
  render();
  try {
    const response = await chrome.runtime.sendMessage({
      type, tabId: state.tabId, expectedPageToken: state.hijackStatus.pageToken,
    });
    const status = normalizeHijackStatus(response);
    if (!status) throw new Error("페이지 응답이 없습니다.");
    state.hijackStatus = status;
  } catch {
    await readHijackStatus();
    state.hijackNotice = "페이지가 바뀌었거나 일부 프레임에 적용하지 못했어요. 새로고침 후 다시 시도해 주세요.";
  } finally {
    state.hijackBusy = false;
    render();
  }
}

async function syncBackground() {
  const response = await chrome.runtime.sendMessage({ type: "sync-settings" });
  if (!response?.ok) {
    throw new Error(response?.error || "설정을 적용하지 못했습니다.");
  }
}

async function reloadCurrentTab() {
  if (state.supportedPage && Number.isInteger(state.tabId)) {
    await chrome.tabs.reload(state.tabId);
  }
}

async function recoverFromSettingsFailure(previousSettings) {
  try {
    await chrome.storage.local.set(previousSettings);
    await syncBackground();
    applyStoredSettings(previousSettings);
    return "rolled-back";
  } catch {
    try {
      await syncBackground();
      const actualSettings = await chrome.storage.local.get(DEFAULT_SETTINGS);
      applyStoredSettings(actualSettings);
      return "current";
    } catch {
      state.controlsLocked = true;
      return "unknown";
    }
  }
}

function showSettingsFailure(error, recoveryResult) {
  if (recoveryResult === "rolled-back") {
    state.errorTitle = "설정을 바꾸지 못했습니다";
    state.errorMessage = error.message;
    return;
  }

  if (recoveryResult === "current") {
    state.errorTitle = "저장된 설정을 다시 불러왔습니다";
    state.errorMessage =
      "일부 작업이 실패해 현재 저장된 상태를 표시합니다. 다시 시도해 주세요.";
    return;
  }

  state.errorTitle = "설정 상태를 확인할 수 없습니다";
  state.errorMessage =
    "팝업을 닫고 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요.";
}

async function readBlockedCount() {
  if (!state.supportedPage || !Number.isInteger(state.tabId)) {
    return null;
  }

  try {
    const page = await chrome.tabs.sendMessage(state.tabId, {
      type: "get-page-start-time",
    }, { frameId: 0 });

    if (!Number.isFinite(page?.timeOrigin)) {
      return null;
    }

    const result = await chrome.declarativeNetRequest.getMatchedRules({
      tabId: state.tabId,
      minTimeStamp: page.timeOrigin,
    });

    return result.rulesMatchedInfo.filter(
      (match) => COUNTED_RULESET_IDS.has(match.rule.rulesetId),
    ).length;
  } catch {
    // 확장 설치 전에 열려 있던 탭에는 콘텐츠 스크립트가 아직 없습니다.
    return null;
  }
}

async function handleGlobalToggle(event) {
  if (state.busy || state.hijackBusy || state.controlsLocked) {
    return;
  }

  const activeToggle = event.currentTarget ?? event.target;
  const previousSettings = {
    enabled: state.enabled,
    disabledSites: [...state.disabledSites],
  };
  state.busy = true;
  state.enabled = event.target.checked;
  state.blockedCount = 0;
  state.errorTitle = "";
  state.errorMessage = "";
  state.noticeTitle = "";
  state.noticeMessage = "";
  render();

  try {
    await chrome.storage.local.set({ enabled: state.enabled });
    await syncBackground();
    try {
      await reloadCurrentTab();
    } catch {
      state.noticeTitle = "설정은 저장했습니다";
      state.noticeMessage =
        "페이지를 직접 새로고침하면 변경 사항이 적용됩니다.";
    }
  } catch (error) {
    const recoveryResult =
      await recoverFromSettingsFailure(previousSettings);
    showSettingsFailure(error, recoveryResult);
  } finally {
    state.busy = false;
    render();
    activeToggle.focus?.({ preventScroll: true });
  }
}

async function handleSiteToggle(event) {
  if (state.busy || state.hijackBusy || state.controlsLocked || !state.supportedPage) {
    return;
  }

  const activeToggle = event.currentTarget ?? event.target;
  state.busy = true;
  const shouldBlock = event.target.checked;
  const previousSettings = {
    enabled: state.enabled,
    disabledSites: [...state.disabledSites],
  };
  state.blockedCount = 0;
  state.errorTitle = "";
  state.errorMessage = "";
  state.noticeTitle = "";
  state.noticeMessage = "";

  if (shouldBlock) {
    state.disabledSites = state.disabledSites.filter(
      (site) => !siteMatches(state.hostname, site),
    );
  } else if (!state.disabledSites.includes(state.hostname)) {
    if (state.disabledSites.length >= MAX_DISABLED_SITES) {
      state.busy = false;
      state.errorTitle = "사이트 예외가 가득 찼습니다";
      state.errorMessage =
        "저장된 사이트 예외를 정리한 뒤 다시 시도해 주세요.";
      render();
      return;
    }
    state.disabledSites.push(state.hostname);
  }

  render();

  try {
    await chrome.storage.local.set({ disabledSites: state.disabledSites });
    await syncBackground();
    try {
      await reloadCurrentTab();
    } catch {
      state.noticeTitle = "설정은 저장했습니다";
      state.noticeMessage =
        "페이지를 직접 새로고침하면 변경 사항이 적용됩니다.";
    }
  } catch (error) {
    const recoveryResult =
      await recoverFromSettingsFailure(previousSettings);
    showSettingsFailure(error, recoveryResult);
  } finally {
    state.busy = false;
    render();
    activeToggle.focus?.({ preventScroll: true });
  }
}

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await syncBackground();
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);

    state.tabId = Number.isInteger(tab?.id) ? tab.id : null;
    applyStoredSettings(settings);

    if (tab?.url) {
      const url = new URL(tab.url);
      state.supportedPage = url.protocol === "http:" || url.protocol === "https:";
      state.hostname = state.supportedPage ? url.hostname.toLowerCase() : "";
    }

    state.blockedCount = await readBlockedCount();
    await readHijackStatus();
    state.controlsLocked = false;
  } catch (error) {
    state.errorTitle = "상태를 불러오지 못했습니다";
    state.errorMessage = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

elements.globalToggle.addEventListener("change", handleGlobalToggle);
elements.siteToggle.addEventListener("change", handleSiteToggle);
elements.hijackToggle?.addEventListener("change", event =>
  handleHijackSetting(event, "hijackDisabledSites", false));
elements.hijackStrictToggle?.addEventListener("change", event =>
  handleHijackSetting(event, "hijackStrictSites", true));
elements.hijackAllowOnce?.addEventListener("click", () => handleHijackAction("hijack-allow-once"));
elements.hijackRestore?.addEventListener("click", () => handleHijackAction("hijack-restore"));

// Only the open popup polls fixed counters. URLs, cookies, and browsing history
// are neither requested nor stored. Older tabs show a reload hint, not a false OK.
if (elements.hijackToggle && typeof globalThis.setInterval === "function") {
  globalThis.setInterval(async () => {
    if (state.busy || state.hijackBusy || state.controlsLocked) return;
    await readHijackStatus();
    renderHijack();
  }, 1500);
}

initialize();
