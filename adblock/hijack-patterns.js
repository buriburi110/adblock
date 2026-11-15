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
