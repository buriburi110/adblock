import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// All fixtures are synthetic and contain no site content, images, or video.
// --chrome never fetches the actual website or an advertising server.
const require = createRequire(import.meta.url);
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureUrl = "https://sexkbj.tv/codex-adblock-fixture";
const adUrl = "https://go.whitetrafsa.com/api/models/vast?fixture=1";
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(rootDirectory, file), "utf8"));
let passed = 0;

async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

await test("Site CSS registration is exact-host and does not inject page scripts", () => {
  const manifest = readJson("manifest.json");
  const registration = manifest.content_scripts.find((script) => script.css?.includes("sites/sexkbj.css"));
  assert.ok(registration, "Missing site stylesheet registration");
  assert.deepEqual(registration.matches, ["https://sexkbj.tv/*"]);
  assert.equal(registration.run_at, "document_start");
  assert.equal(registration.js?.length ?? 0, 0);
  assert.equal(manifest.host_permissions.some((entry) => entry.includes("sexkbj")), false,
    "A static stylesheet must not expand host permissions unnecessarily");
});

await test("Primary and fallback advertising rules preserve the intended scope", () => {
  const primary = readJson("rules/easylist.json").find((rule) => rule.id === 415630);
  assert.equal(primary?.action.type, "block");
  assert.equal(primary?.condition.urlFilter, "||whitetrafsa.com^");
  const fallback = readJson("rules/ads.json").find((rule) => rule.id === 2);
  assert.deepEqual(fallback, {
    id: 2,
    priority: 1000,
    action: { type: "block" },
    condition: {
      urlFilter: "||go.whitetrafsa.com/api/models/vast",
      initiatorDomains: ["sexkbj.tv"],
      resourceTypes: ["xmlhttprequest"],
    },
  });
});

await test("Site stylesheet requires filtering state, sponsorship, and exact ad destination", () => {
  const css = fs.readFileSync(path.join(rootDirectory, "sites/sexkbj.css"), "utf8");
  assert.match(css, /html\.lae-active\.lae-specific-active\s+a\[rel~=["']sponsored["']\]\[href\^=["']https:\/\/t\.vlmai-5\.com\/["']\]/);
  assert.match(css, /display:\s*none\s*!important/);
});

const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Offline advertising regression fixture</title></head><body>
<main id="content"><p id="description">Synthetic content only.</p>
<a id="sponsored" rel="nofollow sponsored noopener" href="https://t.vlmai-5.com/fixture">Synthetic advertising slot</a>
<a id="ordinary" href="https://sexkbj.tv/fixture-normal-link">Ordinary local navigation</a>
<a id="unsponsored" rel="nofollow" href="https://t.vlmai-5.com/fixture">Destination without sponsored marker</a>
<a id="otherSponsor" rel="sponsored" href="https://publisher.example/fixture">Other sponsored destination</a>
<a id="lookalikeHost" rel="sponsored" href="https://t.vlmai-5.com.evil.example/fixture">Different host</a>
<a id="lookalikeRel" rel="not-sponsored" href="https://t.vlmai-5.com/fixture">Different rel token</a>
<a id="lookalikeScheme" rel="sponsored" href="http://t.vlmai-5.com/fixture">Different scheme</a>
<video id="mainVideo" controls preload="none"></video></main>
</body></html>`;

async function chromeIntegration() {
  const { chromium } = require("playwright");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const prefix = "light-adblock-sexkbj-check-";
  const profileDirectory = fs.mkdtempSync(path.join(temporaryRoot, prefix));
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      headless: false,
      args: [
        `--disable-extensions-except=${rootDirectory}`,
        `--load-extension=${rootDirectory}`,
        "--window-position=-32000,-32000",
        "--window-size=800,600",
      ],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    // No request is continued to the internet, including advertising and media.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/codex-adblock-fixture") {
        await route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml });
      } else {
        await route.abort();
      }
    });
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    const syncSettings = async (settings) => {
      await worker.evaluate(async (value) => {
        await chrome.storage.local.set(value);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const rulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
          const scripts = await chrome.scripting.getRegisteredContentScripts();
          const dynamic = (await chrome.declarativeNetRequest.getDynamicRules())
            .filter((rule) => rule.id >= 900001 && rule.id < 902001);
          const managed = rulesets.filter((id) => ["easylist", "ads", "soop"].includes(id));
          const rulesetsReady = value.enabled
            ? managed.includes("easylist") && managed.includes("soop") && !managed.includes("ads")
            : managed.length === 0;
          const scriptsReady = Boolean(scripts.find((script) => script.id === "soop-vod-main-world")) === value.enabled;
          const expectedUrls = value.disabledSites.flatMap((host) => [
            `|http://${host}^`, `|https://${host}^`,
          ]).sort();
          const actualUrls = dynamic.map((rule) => rule.condition.urlFilter).sort();
          if (rulesetsReady && scriptsReady && JSON.stringify(expectedUrls) === JSON.stringify(actualUrls)) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Advertising fixture settings did not synchronize");
      }, settings);
    };
    const inspect = async (hidden, includeDynamic = false) => {
      await page.waitForFunction(({ expected, dynamic }) => {
        const ad = document.getElementById("sponsored");
        const added = document.getElementById("dynamicSponsor");
        return ad && (getComputedStyle(ad).display === "none") === expected &&
          (!dynamic || (added && (getComputedStyle(added).display === "none") === expected));
      }, { expected: hidden, dynamic: includeDynamic });
      const state = await page.evaluate(() => {
        const visibility = (id) => getComputedStyle(document.getElementById(id)).display !== "none";
        return {
          preserved: ["ordinary", "unsponsored", "otherSponsor", "lookalikeHost", "lookalikeRel", "lookalikeScheme", "mainVideo", "description"].map(visibility),
          mainVideoUnchanged: document.getElementById("mainVideo").getAttribute("src") === null,
        };
      });
      assert.ok(state.preserved.every(Boolean), JSON.stringify(state));
      assert.equal(state.mainVideoUnchanged, true);
    };
    const inspectRules = async (rulesetId, enabled) => {
      const outcomes = await worker.evaluate(async ({ selectedId, requestUrl }) => {
        const check = async (url, type, initiator = "https://sexkbj.tv") => {
          const result = await chrome.declarativeNetRequest.testMatchOutcome({ url, type, initiator, tabId: -1 });
          return result.matchedRules.some((rule) => rule.rulesetId === selectedId);
        };
        return {
          advertising: await check(requestUrl, "xmlhttprequest"),
          mainVideo: await check("https://sexkbj.tv/codex-fixture/main.mp4", "media"),
          mediaManifest: await check("https://media.example/codex-fixture/main.m3u8", "xmlhttprequest"),
          ordinaryScript: await check("https://sexkbj.tv/codex-fixture/player.js", "script"),
          fallbackNegatives: selectedId === "ads" ? [
            await check(requestUrl, "xmlhttprequest", "https://unrelated.example"),
            await check(requestUrl, "main_frame"),
            await check(requestUrl, "media"),
            await check("https://go.whitetrafsa.com/api/models/other", "xmlhttprequest"),
            await check("https://go.whitetrafsa.com.evil.example/api/models/vast", "xmlhttprequest"),
          ] : [],
        };
      }, { selectedId: rulesetId, requestUrl: adUrl });
      assert.equal(outcomes.advertising, enabled, JSON.stringify(outcomes));
      assert.ok([outcomes.mainVideo, outcomes.mediaManifest, outcomes.ordinaryScript, ...outcomes.fallbackNegatives]
        .every((value) => value === false), JSON.stringify(outcomes));
    };

    await test("Chromium: targeted advertising links hidden, other links and player preserved", async () => {
      await syncSettings({ enabled: true, disabledSites: [] });
      await page.goto(fixtureUrl, { waitUntil: "load" });
      await inspect(true);
    });
    await test("Chromium: advertising link inserted after load is hidden automatically", async () => {
      await page.evaluate(() => {
        const link = document.createElement("a");
        link.id = "dynamicSponsor";
        link.rel = "sponsored";
        link.href = "https://t.vlmai-5.com/added-after-load";
        link.textContent = "Dynamically inserted synthetic advertising slot";
        document.getElementById("content").append(link);
      });
      await inspect(true, true);
    });
    await test("Chromium: global OFF and ON update the existing document without reload", async () => {
      await syncSettings({ enabled: false, disabledSites: [] });
      await inspect(false, true);
      await inspectRules("easylist", false);
      await inspectRules("ads", false);
      await syncSettings({ enabled: true, disabledSites: [] });
      await inspect(true, true);
    });
    await test("Chromium: exact-site exclusion and re-enable update existing and new documents", async () => {
      await syncSettings({ enabled: true, disabledSites: ["sexkbj.tv"] });
      await inspect(false, true);
      await page.reload({ waitUntil: "load" });
      await inspect(false);
      const allowRules = await worker.evaluate(async () => (
        await chrome.declarativeNetRequest.testMatchOutcome({
          url: "https://sexkbj.tv/codex-adblock-fixture", type: "main_frame", tabId: -1,
        })
      ).matchedRules);
      assert.ok(allowRules.some((rule) => rule.ruleId === 900002));
      await syncSettings({ enabled: true, disabledSites: ["www.sexkbj.tv"] });
      await inspect(true);
      await syncSettings({ enabled: true, disabledSites: [] });
      await page.reload({ waitUntil: "load" });
      await inspect(true);
    });
    await test("Chromium: primary and fallback rules block advertising without matching main-video fixtures", async () => {
      await inspectRules("easylist", true);
      await worker.evaluate(() => chrome.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: ["easylist"], enableRulesetIds: ["ads"],
      }));
      await inspectRules("ads", true);
      await page.reload({ waitUntil: "load" });
      await inspect(true);
      await syncSettings({ enabled: false, disabledSites: [] });
      await inspectRules("ads", false);
      await syncSettings({ enabled: true, disabledSites: [] });
      await inspectRules("easylist", true);
    });
    await test("Chromium: exact-host CSS does not affect lookalike or unrelated domains", async () => {
      for (const url of [
        "https://unrelated.example/codex-adblock-fixture",
        "https://sexkbj.tv.evil.example/codex-adblock-fixture",
      ]) {
        await page.goto(url, { waitUntil: "load" });
        await page.waitForFunction(() => document.documentElement.classList.contains("lae-active"));
        await inspect(false);
      }
      assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
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
console.log(`사이트 광고 검사 완료: ${passed}개 그룹 통과${process.argv.includes("--chrome") ? " (Chromium 오프라인 fixture 포함)" : " (--chrome으로 오프라인 확장 통합 검사 추가)"}`);
