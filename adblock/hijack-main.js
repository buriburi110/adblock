// Small, portable classifier. No browser permissions, requests, or URL storage.
// Reviewed EasyList popup subset and attribution: rules/hijack-patterns.source.txt.
(() => {
  const hosts = Object.freeze([
    "popads.net", "popcash.net", "popmyads.com", "popunder.bid",
    "popunderjs.com", "propellerpops.com",
  ]);
  function classify(value, base) {
    if (typeof value !== "string") return { external: false, knownHost: false, popupPattern: false };
    try {
      const url = new URL(value, base);
      const source = new URL(base);
      const external = /^https?:$/.test(url.protocol) && url.hostname !== source.hostname;
      return {
        external,
        knownHost: external && hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)),
        popupPattern: external && /\/(?:popunder\/in\/click\/|popunder_|popupads\.|links\/popad(?:[/?]|$))/.test(url.pathname),
      };
    } catch {
      return { external: false, knownHost: false, popupPattern: false };
    }
  }
  globalThis.__laeHijackPatterns = Object.freeze({ classify });
})();
// The prefix above is bundled from hijack-patterns.js (tests enforce equality).
// A distinct bundled path ensures execution in both worlds (integration tested).
// Page-world hook, deliberately inert until the isolated guard enables it.
// The page can alter this bridge; it is NOT an authorization/security boundary.
(() => {
  "use strict";
  const classify = globalThis.__laeHijackPatterns?.classify;
  const nativeOpen = window.open;
  if (!classify || typeof nativeOpen !== "function") return;
  const nativeDispatch = document.dispatchEvent.bind(document);
  const EventClass = CustomEvent;
  const nativeApply = Reflect.apply;
  const later = window.setTimeout.bind(window);
  const cancelLater = window.clearTimeout.bind(window);
  let explicitClick = null;
  let clickTimer;
  window.addEventListener("click", event => {
    explicitClick = null;
    cancelLater(clickTimer);
    if (document.documentElement?.getAttribute("data-lae-hijack-mode") !== "strict" ||
        !event.isTrusted || event.button !== 0) return;
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.hasAttribute("href"));
    if (anchor) {
      const click = { href: anchor.href, until: performance.now() + 500 };
      explicitClick = click;
      clickTimer = later(() => { if (explicitClick === click) explicitClick = null; }, 500);
    }
  }, true);
  window.open = function (...args) {
    if ((this !== window && this !== undefined) ||
        (args.length > 1 && args[1] !== undefined && typeof args[1] !== "string")) {
      return nativeApply(nativeOpen, this, args);
    }
    const mode = document.documentElement?.getAttribute("data-lae-hijack-mode");
    if (mode !== "basic" && mode !== "strict") return nativeApply(nativeOpen, this, args);
    const info = classify(args[0], document.baseURI);
    // Do not coerce arbitrary objects a second time or interfere with native
    // argument errors, same-document targets, printing, downloads, or blank tabs.
    const target = typeof args[1] === "string" ? args[1].toLowerCase() : "_blank";
    const newContext = !["_self", "_top", "_parent"].includes(target);
    let reason = "";
    if (newContext && (info.knownHost || info.popupPattern)) reason = "ad-popup";
    else if (mode === "strict" && newContext && info.external) {
      let explicit = false;
      try {
        explicit = explicitClick && performance.now() <= explicitClick.until &&
          new URL(args[0], document.baseURI).href === explicitClick.href;
      } catch { /* Unknown forms pass to the native API. */ }
      if (!explicit) reason = "strict-popup";
      else { explicitClick = null; cancelLater(clickTimer); }
    }
    if (!reason) return nativeApply(nativeOpen, this, args);
    // Fixed reason only: no destination URL, credentials, or message command.
    nativeDispatch(new EventClass("lae-hijack-blocked", { detail: reason }));
    return null;
  };
})();
