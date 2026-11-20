// A hidden native modal still makes the page inert, and hidden media can keep playing.
// cosmetic.css provides the inherited marker only when generic filtering is active.
(() => {
  const tracked = new Set();

  function check(element) {
    const media = element instanceof HTMLMediaElement;
    if (!element.isConnected || (media ? element.paused || element.ended : !element.open)) {
      tracked.delete(element);
      return;
    }
    if (getComputedStyle(element).getPropertyValue("--lae-ad-slot").trim() !== "1") return;
    if (media) element.pause();
    else if (element.matches(":modal")) element.close();
  }

  document.addEventListener("play", ({ target }) => {
    if (target instanceof HTMLMediaElement) {
      tracked.add(target);
      check(target);
    }
  }, true);
  for (const type of ["pause", "ended", "close"]) {
    document.addEventListener(type, ({ target }) => {
      if (target.paused || target.ended || target.open === false) tracked.delete(target);
    }, true);
  }

  // Track actual playing elements and open dialogs. Do not scan each inserted subtree.
  new MutationObserver(records => {
    for (const record of records) {
      if (record.attributeName === "open" && record.target instanceof HTMLDialogElement && record.target.open) {
        tracked.add(record.target);
      }
    }
    if (!tracked.size) return;
    for (const element of tracked) {
      if (!element.isConnected || records.some(record =>
        record.type === "attributes"
          ? record.target.contains(element)
          : Array.from(record.addedNodes).some(node => node.contains(element))
      )) check(element);
    }
  }).observe(document, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["open", "id", "name", "class", "role", "aria-label", "data-ad-slot", "data-google-query-id"]
  });
})();
