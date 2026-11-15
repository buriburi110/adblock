(() => {
  const ROOT_CLASS = "lae-active";
  const GENERIC_CLASS = "lae-generic-active";
  const SPECIFIC_CLASS = "lae-specific-active";
  const YOUTUBE_STATE_ATTRIBUTE = "data-lae-player";
  const YOUTUBE_STATE_EVENT = "lae-player-state";
  const LEGACY_YOUTUBE_PAUSE_KEY = "__lae_yt_pause_v1";
  const currentHostname = getTopLevelHostname();
  const documentHostname = getDocumentHostname();
  let updateVersion = 0;
  let cosmeticRulesRequested = false;
  let cosmeticRulesLoaded = false;
  let cosmeticModes = { genericActive: false, specificActive: false };
  let pageFilteringActive = false;
  let cosmeticFilteringActive = false;
  let rootObserver = null;
  const installedCosmeticStyles = [];

  function getTopLevelHostname() {
    const ancestorOrigins = window.location.ancestorOrigins;
    const topLevelOrigin = ancestorOrigins?.length
      ? ancestorOrigins[ancestorOrigins.length - 1]
      : "";

    if (topLevelOrigin) {
      try {
        return new URL(topLevelOrigin).hostname.toLowerCase();
      } catch {
        // 예상하지 못한 origin 형식이면 현재 문서의 호스트를 사용합니다.
      }
    }

    return window.location.hostname.toLowerCase();
  }

  function getDocumentHostname() {
    const ownHostname = window.location.hostname.toLowerCase();
    if (ownHostname) {
      return ownHostname;
    }

    const nearestAncestorOrigin = window.location.ancestorOrigins?.[0] ?? "";
    if (nearestAncestorOrigin) {
      try {
        return new URL(nearestAncestorOrigin).hostname.toLowerCase();
      } catch {
        // about:blank/srcdoc의 origin을 해석할 수 없으면 최상위 호스트로 되돌립니다.
      }
    }
    return currentHostname;
  }

  function siteMatches(hostname, disabledSite) {
    return hostname === disabledSite;
  }

  function clearLegacyYoutubePauseMarker() {
    if (
      currentHostname !== "youtube.com" &&
      !currentHostname.endsWith(".youtube.com") &&
      currentHostname !== "www.youtube-nocookie.com"
    ) {
      return;
    }

    try {
      sessionStorage.removeItem(LEGACY_YOUTUBE_PAUSE_KEY);
    } catch {
      // 샌드박스 iframe에서는 sessionStorage를 읽을 수 없을 수 있습니다.
    }
  }

  function waitForDocumentElement() {
    if (
      rootObserver ||
      document.documentElement ||
      typeof globalThis.MutationObserver !== "function"
    ) {
      return;
    }

    rootObserver = new globalThis.MutationObserver(() => {
      if (!document.documentElement) {
        return;
      }
      rootObserver.disconnect();
      rootObserver = null;
      setPageFilteringActive(pageFilteringActive);
      setCosmeticModes(cosmeticFilteringActive);
    });
    rootObserver.observe(document, { childList: true, subtree: true });
  }

  function setPageFilteringActive(active) {
    pageFilteringActive = active;
    const root = document.documentElement;

    if (!root) {
      waitForDocumentElement();
      return;
    }

    root.classList.toggle(ROOT_CLASS, active);
    root.setAttribute(YOUTUBE_STATE_ATTRIBUTE, active ? "on" : "off");
    document.dispatchEvent(new Event(YOUTUBE_STATE_EVENT));
  }

  function setCosmeticModes(active, modes = cosmeticModes) {
    cosmeticFilteringActive = active;
    const root = document.documentElement;
    if (!root) {
      waitForDocumentElement();
      return;
    }

    root.classList.toggle(
      GENERIC_CLASS,
      active && modes.genericActive === true,
    );
    root.classList.toggle(
      SPECIFIC_CLASS,
      active && modes.specificActive === true,
    );
  }

  function selectorIsSupported(selector) {
    if (typeof selector !== "string" || !selector || selector.length > 4096) {
      return false;
    }
    try {
      return typeof globalThis.CSS?.supports !== "function" ||
        globalThis.CSS.supports(`selector(${selector})`);
    } catch {
      return false;
    }
  }

  function scopeCosmeticSelector(selector, modeClass) {
    const activeRoot = `html.${ROOT_CLASS}.${modeClass}`;
    if (/^:root(?=$|[\s.#:[>+~])/i.test(selector)) {
      return `${activeRoot}${selector.slice(5)}`;
    }
    if (/^html(?=$|[\s.#:[>+~])/i.test(selector)) {
      return `${activeRoot}${selector.slice(4)}`;
    }
    return `${activeRoot} ${selector}`;
  }

  function installCosmeticStyle(selectors, modeClass) {
    const cssText = [...new Set(Array.isArray(selectors) ? selectors : [])]
      .filter(selectorIsSupported)
      .map(
        (selector) =>
          `${scopeCosmeticSelector(selector, modeClass)} { display: none !important; }`,
      )
      .join("\n");
    if (!cssText) {
      return;
    }

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      installedCosmeticStyles.push(sheet);
      return;
    } catch {
      // constructable stylesheet를 지원하지 않는 문서에서는 일반 style 요소를 사용합니다.
    }

    const style = document.createElement("style");
    style.setAttribute("data-lae-cosmetic", modeClass);
    style.textContent = cssText;
    (document.documentElement || document.head).append(style);
    installedCosmeticStyles.push(style);
  }

  async function requestCosmeticRules() {
    cosmeticRulesRequested = true;
    try {
      const response = await chrome.runtime.sendMessage({
        hostname: documentHostname || currentHostname,
        type: "get-cosmetic-rules",
      });
      if (!response?.ok) {
        cosmeticRulesRequested = false;
        return;
      }

      installCosmeticStyle(response.genericSelectors, GENERIC_CLASS);
      installCosmeticStyle(response.specificSelectors, SPECIFIC_CLASS);
      cosmeticModes = {
        genericActive: response.genericActive === true,
        specificActive: response.specificActive === true,
      };
      cosmeticRulesLoaded = true;
      setCosmeticModes(pageFilteringActive);
    } catch {
      cosmeticRulesRequested = false;
    }
  }

  async function updateCosmeticFiltering() {
    const requestedVersion = ++updateVersion;

    try {
      const { enabled = true, disabledSites = [] } =
        await chrome.storage.local.get({ enabled: true, disabledSites: [] });
      const sites = Array.isArray(disabledSites)
        ? disabledSites.slice(0, 1000)
        : [];
      const siteIsDisabled = sites.some((site) =>
        siteMatches(currentHostname, String(site).toLowerCase()),
      );

      if (requestedVersion !== updateVersion) {
        return;
      }

      const filteringActive = Boolean(enabled) && !siteIsDisabled;
      setPageFilteringActive(filteringActive);
      setCosmeticModes(filteringActive && cosmeticRulesLoaded);

      if (
        filteringActive &&
        !cosmeticRulesLoaded &&
        !cosmeticRulesRequested &&
        typeof chrome.runtime?.sendMessage === "function"
      ) {
        await requestCosmeticRules();
      }
    } catch {
      // 확장 프로그램이 업데이트되는 순간 기존 탭의 컨텍스트가 끊길 수 있습니다.
    }
  }

  clearLegacyYoutubePauseMarker();
  updateCosmeticFiltering();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      (Object.hasOwn(changes, "enabled") ||
        Object.hasOwn(changes, "disabledSites"))
    ) {
      updateCosmeticFiltering();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "get-page-start-time") {
      sendResponse({ timeOrigin: performance.timeOrigin });
      return false;
    }

    return false;
  });
})();
