import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Synthetic fixtures only: requests are fulfilled locally or aborted, never continued.
// --chrome uses an isolated temporary profile and the actual unpacked extension.
const require = createRequire(import.meta.url);
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = "/codex-overlay-fixture";
const fixtureHost = "overlay-fixture.example";
const fixtureUrl = `https://${fixtureHost}${fixturePath}`;
const frameHost = "frame.overlay-fixture.example";
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(rootDirectory, file), "utf8"));
const readText = (file) => fs.readFileSync(path.join(rootDirectory, file), "utf8");
let passed = 0;

async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

await test("Known overlay marker remains exact and uses the independent hijack protection state", () => {
  const css = readText("cosmetic.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const overlayRules = blocks.filter(([, selector]) => selector.includes("data-cl-overlay"));
  assert.equal(overlayRules.length, 1, "Expected exactly one dedicated overlay rule");
  const [, selector, body] = overlayRules[0];
  assert.equal(selector.trim(), "html.lae-hijack-active div[data-cl-overlay],\nhtml.lae-hijack-active [data-lae-hijack-blocked]");
  const declarations = body.split(";").map((entry) => entry.trim()).filter(Boolean).sort();
  assert.deepEqual(declarations, ["display: none !important", "pointer-events: none !important"]);
  assert.doesNotMatch(css, /ea0Lbe|pgippxjdr3ep|ph28f62673o/,
    "Do not target Google UI or unstable random classes");
});

await test("Hijack protection retains permissions and separates isolated settings from the narrow popup hook", () => {
  const manifest = readJson("manifest.json");
  assert.deepEqual(manifest.permissions, ["activeTab", "declarativeNetRequest", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://chzzk.naver.com/*", "https://vod.sooplive.com/*", "https://youtube.com/*",
    "https://www.youtube.com/*", "https://m.youtube.com/*", "https://music.youtube.com/*",
    "https://tv.youtube.com/*", "https://www.youtube-nocookie.com/*",
  ]);
  const registrations = manifest.content_scripts.filter((script) => script.css?.includes("cosmetic.css"));
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].matches, ["http://*/*", "https://*/*"]);
  assert.deepEqual(registrations[0].js, ["content.js", "hijack-patterns.js", "hijack-guard.js"]);
  assert.equal(registrations[0].run_at, "document_start");
  assert.equal(registrations[0].all_frames, true);
  assert.equal(registrations[0].match_about_blank, true);
  assert.equal(registrations[0].world ?? "ISOLATED", "ISOLATED");
  const allSiteScripts = manifest.content_scripts.filter((script) => script.matches.some((match) =>
    ["<all_urls>", "http://*/*", "https://*/*", "*://*/*"].includes(match)));
  assert.equal(allSiteScripts.length, 2);
  const mainGuard = allSiteScripts.find(script => script.world === "MAIN");
  assert.deepEqual(mainGuard.js, ["hijack-main.js"]);
  assert.equal(mainGuard.run_at, "document_start");
  assert.equal(mainGuard.all_frames, true);
  assert.equal(mainGuard.match_about_blank, true);
  assert.doesNotMatch(readText("content.js"), /data-cl-overlay|ea0Lbe|(?:window|globalThis)\.open\s*=/);
  assert.deepEqual(manifest.declarative_net_request.rule_resources.map((rule) => rule.id),
    ["easylist", "ads", "soop", "player_compat"], "Only the separately scoped player compatibility ruleset is added");
});

const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Offline overlay fixture</title>
<style>
body { margin: 16px; font: 16px sans-serif; }
.stage { position: relative; width: 704px; height: 350px; margin-bottom: 20px; }
.play { position: absolute; left: 0; top: 0; width: 704px; height: 350px; }
#normalControls > * { display: inline-block; padding: 8px; margin: 4px; }
dialog[open] { position: static; display: inline-block; }
iframe { display: block; width: 760px; height: 950px; border: 0; }
</style></head><body>
<section class="stage" id="stageA"><button class="play" id="playA">Synthetic play A</button>
<div id="overlayA" class="pgippxjdr3ep" data-cl-overlay="" style='z-index:1001; background-image:url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"); left:0px;top:0px;height:350px;width:704px;position:absolute'></div></section>
<section class="stage" id="stageB"><button class="play" id="playB">Synthetic play B</button>
<div id="overlayB" class="ph28f62673o" data-cl-overlay="" style='z-index:1001; background-image:url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"); left:0px;top:0px;height:350px;width:704px;position:absolute'></div></section>
<section id="normalControls">
<button id="normalButton">Normal control</button>
<div id="sameClass" class="pgippxjdr3ep">Same random class, no marker</div>
<div id="nearAttribute" data-cl-overlays="">Different attribute</div>
<span id="markedSpan" data-cl-overlay="">Non-div marker</span>
<dialog id="normalDialog" open data-cl-overlay="">Normal dialog</dialog>
<div id="googleControl" class="ea0Lbe" role="button" tabindex="0">Google-style control</div>
<button id="legitimatePopup">Normal local popup</button>
</section>
<script>
window.fixture = {
  clicks: { playA: 0, playB: 0, overlayA: 0, overlayB: 0, normalButton: 0, googleControl: 0 },
  syntheticAdAttempts: 0,
  originals: [document.getElementById("overlayA"), document.getElementById("overlayB")],
};
window.fixture.originalStyles = window.fixture.originals.map((element) => element.getAttribute("style"));
for (const id of Object.keys(window.fixture.clicks)) {
  document.getElementById(id).addEventListener("click", (event) => {
    window.fixture.clicks[id] += 1;
    if (id.startsWith("overlay")) {
      // Record the would-be advertising action without contacting or opening an ad.
      window.fixture.syntheticAdAttempts += 1;
      event.preventDefault();
      event.stopPropagation();
    }
  });
}
document.getElementById("legitimatePopup").addEventListener("click", () => window.open("about:blank", "_blank"));
</script></body></html>`;

async function chromeIntegration() {
  const { chromium } = require("playwright");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const prefix = "light-adblock-overlay-check-";
  const profileDirectory = fs.mkdtempSync(path.join(temporaryRoot, prefix));
  const pageErrors = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      headless: false,
      viewport: { width: 1000, height: 1100 },
      args: [
        `--disable-extensions-except=${rootDirectory}`,
        `--load-extension=${rootDirectory}`,
        "--disable-background-networking",
        "--window-position=-32000,-32000",
        "--window-size=1000,1100",
      ],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    // Never continue an HTTP(S) request. Even the real-domain exception test is local HTML.
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === fixturePath && request.resourceType() === "document") {
        await route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml });
      } else {
        await route.abort();
      }
    });
    context.on("page", (newPage) => newPage.on("pageerror", (error) => pageErrors.push(String(error))));
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();

    const syncSettings = async (settings) => {
      await worker.evaluate(async (value) => {
        await chrome.storage.local.set(value);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const rulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
          const dynamic = (await chrome.declarativeNetRequest.getDynamicRules())
            .filter((rule) => rule.id >= 900001 && rule.id < 902001);
          const managed = rulesets.filter((id) => ["easylist", "ads", "soop", "player_compat"].includes(id));
          const ready = value.enabled
            ? managed.includes("easylist") && managed.includes("soop") && managed.includes("player_compat") && !managed.includes("ads")
            : managed.length === 0;
          const expected = value.disabledSites.flatMap((host) => [`|http://${host}^`, `|https://${host}^`]).sort();
          const actual = dynamic.map((rule) => rule.condition.urlFilter).sort();
          if (ready && JSON.stringify(expected) === JSON.stringify(actual)) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Overlay fixture settings did not synchronize");
      }, settings);
    };

    const inspect = async (target, hidden, dynamic = false) => {
      const ids = ["overlayA", "overlayB", ...(dynamic ? ["dynamicOverlay"] : [])];
      await target.waitForFunction(({ ids, hidden }) => ids.every((id) => {
        const element = document.getElementById(id);
        if (!element) return false;
        const style = getComputedStyle(element);
        return (style.display === "none") === hidden && (style.pointerEvents === "none") === hidden;
      }), { ids, hidden });
      const state = await target.evaluate(() => ({
        originalsPreserved: window.fixture.originals.every((element, index) =>
          element.isConnected && document.getElementById(element.id) === element &&
          element.getAttribute("style") === window.fixture.originalStyles[index]),
        unaffected: ["normalButton", "sameClass", "nearAttribute", "markedSpan", "normalDialog", "googleControl"]
          .every((id) => {
            const style = getComputedStyle(document.getElementById(id));
            return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
          }),
        dialogOpen: document.getElementById("normalDialog").open,
      }));
      assert.deepEqual(state, { originalsPreserved: true, unaffected: true, dialogOpen: true });
    };

    const clickStage = async (suffix, hidden) => {
      const before = await page.evaluate(() => ({ ...window.fixture.clicks, attempts: window.fixture.syntheticAdAttempts }));
      const urlBefore = page.url();
      const pagesBefore = context.pages().length;
      await page.locator(`#stage${suffix}`).scrollIntoViewIfNeeded();
      const box = await page.locator(`#stage${suffix}`).boundingBox();
      assert.ok(box, "Missing stage rectangle");
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point),
        `${hidden ? "play" : "overlay"}${suffix}`);
      // Deliberately use a real coordinate click, not locator.click(force) or a dispatched event.
      await page.mouse.click(point.x, point.y);
      const after = await page.evaluate(() => ({ ...window.fixture.clicks, attempts: window.fixture.syntheticAdAttempts }));
      assert.equal(after[`play${suffix}`], before[`play${suffix}`] + Number(hidden));
      assert.equal(after[`overlay${suffix}`], before[`overlay${suffix}`] + Number(!hidden));
      assert.equal(after.attempts, before.attempts + Number(!hidden));
      assert.equal(page.url(), urlBefore, "Synthetic overlay click navigated unexpectedly");
      assert.equal(context.pages().length, pagesBefore, "Synthetic overlay click opened a popup");
    };

    await test("Chromium: both supplied overlay examples are hidden and real clicks reach the underlying play buttons", async () => {
      await syncSettings({ enabled: true, disabledSites: [] });
      await page.goto(fixtureUrl, { waitUntil: "load" });
      await inspect(page, true);
      await clickStage("A", true);
      await clickStage("B", true);
    });

    await test("Chromium: late insertion, arbitrary class changes, and marker changes remain reversible", async () => {
      await page.evaluate(() => {
        const element = document.createElement("div");
        element.id = "dynamicOverlay";
        element.className = "new-random-class";
        element.setAttribute("data-cl-overlay", "new-value");
        element.textContent = "Dynamically inserted synthetic overlay";
        document.body.append(element);
        window.fixture.originals.forEach((original, index) => { original.className = `changed-random-${index}`; });
      });
      await inspect(page, true, true);
      await page.evaluate(() => document.getElementById("dynamicOverlay").removeAttribute("data-cl-overlay"));
      assert.equal(await page.locator("#dynamicOverlay").evaluate((element) => getComputedStyle(element).display !== "none"), true);
      await page.evaluate(() => document.getElementById("dynamicOverlay").setAttribute("data-cl-overlay", ""));
      await inspect(page, true, true);
    });

    await test("Chromium: normal controls, dialogs, Google ea0Lbe UI, and legitimate window.open remain functional", async () => {
      await inspect(page, true, true);
      await page.locator("#normalButton").click();
      await page.locator("#googleControl").click();
      const clicks = await page.evaluate(() => window.fixture.clicks);
      assert.equal(clicks.normalButton, 1);
      assert.equal(clicks.googleControl, 1);
      const popupPromise = page.waitForEvent("popup");
      await page.locator("#legitimatePopup").click();
      const popup = await popupPromise;
      assert.equal(popup.url(), "about:blank");
      await popup.close();
    });

    await test("Chromium: global OFF restores original overlays and hit-testing in existing and new documents; ON hides again", async () => {
      await syncSettings({ enabled: false, disabledSites: [] });
      await inspect(page, false, true);
      await clickStage("A", false);
      await clickStage("B", false);
      await page.reload({ waitUntil: "load" });
      await inspect(page, false);
      await clickStage("A", false);
      await syncSettings({ enabled: true, disabledSites: [] });
      await inspect(page, true);
      await clickStage("A", true);
      await page.reload({ waitUntil: "load" });
      await inspect(page, true);
    });

    await test("Chromium: exact-site exclusion restores current/new documents while other hosts and subdomains remain protected", async () => {
      await syncSettings({ enabled: true, disabledSites: [fixtureHost] });
      await inspect(page, false);
      await clickStage("B", false);
      await page.reload({ waitUntil: "load" });
      await inspect(page, false);
      for (const hostname of ["different-fixture.example", `child.${fixtureHost}`, `${fixtureHost}.lookalike.example`]) {
        await page.goto(`https://${hostname}${fixturePath}`, { waitUntil: "load" });
        await inspect(page, true);
        await clickStage("A", true);
      }
      await page.goto(fixtureUrl, { waitUntil: "load" });
      await inspect(page, false);
      await syncSettings({ enabled: true, disabledSites: [] });
      await inspect(page, true);
      await page.reload({ waitUntil: "load" });
      await inspect(page, true);
    });

    await test("Chromium: explicit overlay protection does not depend on EasyList generic/specific cosmetic state", async () => {
      await page.waitForFunction(() => document.documentElement.classList.contains("lae-generic-active"));
      await page.evaluate(() => document.documentElement.classList.remove("lae-generic-active", "lae-specific-active"));
      await inspect(page, true);
      await clickStage("A", true);
      const rules = readJson("rules/cosmetic-specific.json");
      const exceptionHost = rules.genericHideDisabledDomains[0] ?? rules.elementHideDisabledDomains[0];
      assert.ok(exceptionHost, "Expected a bundled EasyList cosmetic exception to exercise");
      await page.goto(`https://${exceptionHost}${fixturePath}`, { waitUntil: "load" });
      await inspect(page, true);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("lae-generic-active")), false);
      await clickStage("A", true);
    });

    await test("Chromium: cross-origin and srcdoc frames follow the top-level site's existing exclusion and global toggle", async () => {
      await page.goto(fixtureUrl, { waitUntil: "load" });
      await page.evaluate(({ frameHost, fixturePath, fixtureHtml }) => {
        const crossOrigin = document.createElement("iframe");
        crossOrigin.name = "crossOriginFixture";
        crossOrigin.src = `https://${frameHost}${fixturePath}`;
        document.body.append(crossOrigin);
        const blank = document.createElement("iframe");
        blank.name = "blankFixture";
        blank.srcdoc = fixtureHtml;
        document.body.append(blank);
      }, { frameHost, fixturePath, fixtureHtml });
      await page.waitForFunction(() => document.querySelectorAll("iframe").length === 2);
      const crossOrigin = page.frame({ name: "crossOriginFixture" });
      const blank = page.frame({ name: "blankFixture" });
      assert.ok(crossOrigin);
      assert.ok(blank);
      await crossOrigin.waitForURL(`https://${frameHost}${fixturePath}`);
      await blank.waitForURL("about:srcdoc");
      await inspect(crossOrigin, true);
      await inspect(blank, true);
      await syncSettings({ enabled: true, disabledSites: [frameHost] });
      await inspect(page, true);
      await inspect(crossOrigin, true);
      await inspect(blank, true);
      await syncSettings({ enabled: true, disabledSites: [fixtureHost] });
      await inspect(page, false);
      await inspect(crossOrigin, false);
      await inspect(blank, false);
      await syncSettings({ enabled: true, disabledSites: [] });
      await inspect(crossOrigin, true);
      await inspect(blank, true);
      await syncSettings({ enabled: false, disabledSites: [] });
      await inspect(crossOrigin, false);
      await inspect(blank, false);
      await syncSettings({ enabled: true, disabledSites: [] });
      await inspect(crossOrigin, true);
      await inspect(blank, true);
      assert.deepEqual(pageErrors, []);
    });
  } finally {
    await context?.close();
    const resolved = path.resolve(profileDirectory);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith(prefix)) {
      throw new Error("Refusing to remove an unexpected temporary profile path");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (process.argv.includes("--chrome")) await chromeIntegration();
console.log(`Overlay checks complete: ${passed} groups passed${process.argv.includes("--chrome") ? " (including offline Chromium integration)" : " (add --chrome for offline Chromium integration)"}`);
