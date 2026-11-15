(() => {
  const classify = globalThis.__laeHijackPatterns?.classify;
  if (!classify) return;
  const ACTIVE = "lae-hijack-active";
  const MARK = "data-lae-hijack-blocked";
  const reasons = new Set();
  const seenOverlays = new WeakSet();
  const marked = new Set();
  const dirty = new Set();
  let settingsActive = false, active = false, strict = false, temporarilyAllowed = false;
  let overlayCount = 0, popupCount = 0, linkCount = 0;
  let settingsVersion = 0, scanTimer = null, reportTimer = null, observer;
  const count = value => Math.min(999, value);
  function topHostname() {
    try {
      const origins = location.ancestorOrigins;
      return new URL(origins?.length ? origins[origins.length - 1] : location.href).hostname.toLowerCase();
    } catch { return location.hostname.toLowerCase(); }
  }
  const hostname = topHostname();
  function matches(list) {
    return Array.isArray(list) && list.slice(0, 1000).some(value =>
      typeof value === "string" && value.trim().toLowerCase() === hostname);
  }
  function status() {
    return {
      active, strict: active && strict, temporarilyAllowed,
      overlayCount, popupCount, linkCount,
      blockedCount: count(overlayCount + popupCount + linkCount),
      canAllowOnce: active && overlayCount + popupCount + linkCount > 0,
      reasonCodes: [...reasons], timeOrigin: performance.timeOrigin,
    };
  }
  function report() {
    if (reportTimer !== null) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      chrome.runtime.sendMessage({ type: "hijack-report", status: status() }).catch(() => {});
    }, 80);
  }
  function detected(reason, node) {
    if (reason === "known-overlay" || reason === "ad-overlay") {
      if (seenOverlays.has(node)) return;
      seenOverlays.add(node);
      overlayCount = count(overlayCount + 1);
    } else if (reason === "ad-link") linkCount = count(linkCount + 1);
    else popupCount = count(popupCount + 1);
    reasons.add(reason);
    report();
  }
  function applyState() {
    active = settingsActive && !temporarilyAllowed;
    document.documentElement?.classList.toggle(ACTIVE, active);
    document.documentElement?.setAttribute("data-lae-hijack-mode", !active ? "off" : strict ? "strict" : "basic");
    if (!active) {
      for (const node of marked) node.removeAttribute(MARK);
      marked.clear();
      dirty.clear();
    } else schedule(document);
    report();
  }
  async function readSettings() {
    const revision = ++settingsVersion;
    try {
      const value = await chrome.storage.local.get({ enabled: true, disabledSites: [], hijackDisabledSites: [], hijackStrictSites: [] });
      if (revision !== settingsVersion) return;
      settingsActive = value.enabled !== false && !matches(value.disabledSites) && !matches(value.hijackDisabledSites);
      strict = matches(value.hijackStrictSites);
      applyState();
    } catch { /* An invalidated extension context does not change the page. */ }
  }
  function overlayAnchor(anchor, media) {
    if (!classify(anchor.getAttribute("href"), document.baseURI).knownHost) return false;
    const css = getComputedStyle(anchor);
    if (!["absolute", "fixed"].includes(css.position)) return false;
    const box = anchor.getBoundingClientRect();
    if (box.width < 100 || box.height < 50 || css.visibility !== "visible") return false;
    return media.some(node => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 50) return false;
      const left = Math.max(rect.left, box.left), right = Math.min(rect.right, box.right);
      const top = Math.max(rect.top, box.top), bottom = Math.min(rect.bottom, box.bottom);
      if (Math.max(0, right - left) * Math.max(0, bottom - top) < rect.width * rect.height * 0.6) return false;
      const x = (left + right) / 2, y = (top + bottom) / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const stack = document.elementsFromPoint(x, y);
      const above = stack.findIndex(item => item === anchor || anchor.contains(item));
      return above >= 0 && stack.indexOf(node) > above;
    });
  }
  function scan() {
    scanTimer = null;
    if (!active) return;
    const candidates = new Set();
    // Recheck previously hidden covers first. New links must not consume the
    // geometry budget and accidentally leave an existing cover restored.
    for (const node of marked) {
      node.removeAttribute(MARK);
      if (node.isConnected) candidates.add(node);
    }
    marked.clear();
    for (const root of dirty) {
      if (root instanceof Element && root.matches("div[data-cl-overlay],a[href]")) candidates.add(root);
      for (const node of root.querySelectorAll?.("div[data-cl-overlay],a[href]") ?? []) {
        candidates.add(node);
        if (candidates.size >= 500) break;
      }
      if (candidates.size >= 500) break;
    }
    dirty.clear();
    const media = [...document.querySelectorAll("video,iframe")].slice(0, 40);
    let geometryChecks = 0;
    for (const node of candidates) {
      if (!node.isConnected) continue;
      if (node.matches("div[data-cl-overlay]")) detected("known-overlay", node);
      else if (node instanceof HTMLAnchorElement && geometryChecks < 100 &&
          classify(node.getAttribute("href"), document.baseURI).knownHost) {
        geometryChecks += 1;
        if (overlayAnchor(node, media)) {
          node.setAttribute(MARK, "");
          marked.add(node);
          detected("ad-overlay", node);
        }
      }
    }
  }
  function schedule(node) {
    if (!active) return;
    if (dirty.size < 128) dirty.add(node);
    if (scanTimer === null) scanTimer = setTimeout(scan, 100);
  }
  function installObserver() {
    if (!document.documentElement || observer) return;
    observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target === document.documentElement) continue;
        // Inspect added/changed subtrees, never poll the whole page continuously.
        if (record.type === "attributes") schedule(record.target.parentElement || record.target);
        else {
          if (record.removedNodes.length) schedule(record.target);
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            schedule(node);
            // A player can be inserted after its sibling overlay. Re-evaluate
            // that local container rather than waiting for a later scroll.
            if (node.matches("video,iframe") || node.querySelector("video,iframe")) {
              schedule(node.parentElement || node);
            }
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["href", "data-cl-overlay", "class", "style"] });
    applyState();
  }
  window.addEventListener("click", event => {
    if (!active) return;
    const path = event.composedPath();
    const overlay = path.find(node => node instanceof Element && node.matches(`div[data-cl-overlay],[${MARK}]`));
    const anchor = path.find(node => node instanceof HTMLAnchorElement && node.hasAttribute("href"));
    const adLink = anchor && classify(anchor.getAttribute("href"), document.baseURI).knownHost;
    if (!overlay && !adLink) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (overlay) detected(overlay.hasAttribute("data-cl-overlay") ? "known-overlay" : "ad-overlay", overlay);
    else detected("ad-link");
  }, true);
  // Middle-click new tabs also originate from links; ordinary destinations pass.
  window.addEventListener("auxclick", event => {
    if (!active || event.button !== 1) return;
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (anchor && classify(anchor.getAttribute("href"), document.baseURI).knownHost) {
      event.preventDefault(); event.stopImmediatePropagation(); detected("ad-link");
    }
  }, true);
  document.addEventListener("lae-hijack-blocked", event => {
    // Untrusted MAIN-world messages only affect bounded in-memory counters.
    if (active && ["ad-popup", "strict-popup"].includes(event.detail)) detected(event.detail);
  });
  window.addEventListener("resize", () => schedule(document), { passive: true });
  window.addEventListener("scroll", () => schedule(document), { passive: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["enabled", "disabledSites", "hijackDisabledSites", "hijackStrictSites"].some(key => Object.hasOwn(changes, key))) readSettings();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if (message?.type === "hijack-announce") { report(); respond(status()); }
    else if (message?.type === "hijack-get-status") respond(status());
    else if (message?.type === "hijack-command" && ["allow-page", "restore"].includes(message.action)) {
      temporarilyAllowed = message.action === "allow-page";
      applyState(); respond(status());
    } else return false;
    return false;
  });
  if (document.documentElement) installObserver();
  else {
    const ready = new MutationObserver(() => {
      if (document.documentElement) { ready.disconnect(); installObserver(); }
    });
    ready.observe(document, { childList: true, subtree: true });
  }
  readSettings();
})();
