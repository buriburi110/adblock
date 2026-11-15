import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Offline only. Every request is fulfilled from synthetic data or aborted, and
// external DNS is disabled. Never supply real cookies, media URLs, or ad payloads.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const host = "04.avsee.is";
const gatePath = "/player/ad-gate.js?v=1790860982";
const gateUrl = `https://${host}${gatePath}`;
const fixturePath = "/codex-player-compat-fixture";
const parentHost = "player-parent.example";
const rulesetId = "player_compat";
const rule = readJson("rules/player-compat.json")[0];
let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

const negativeUrls = [
  `http://${host}${gatePath}`,
  `https://64.avsee.is${gatePath}`,
  `https://child.${host}${gatePath}`,
  `https://${host}.lookalike.example${gatePath}`,
  `https://elsewhere.example${gatePath}`,
  `https://${host}/other/ad-gate.js?v=1790860982`,
  `https://${host}/player/AD-gate.js?v=1790860982`,
  `https://${host}/player/ad-gate.js`,
  `https://${host}/player/ad-gate.js?v=1790860983`,
  `https://${host}/player/ad-gate.js?v=1790860982&other=1`,
  `https://${host}/player/ad-gate.js?other=1&v=1790860982`,
  `https://${host}/player/advertisement.js?v=1789756327`,
  `https://${host}/player/player.js?v=1791207311`,
  `https://${host}/player/jwplayer-8.13.8/jwplayer.js`,
];

await test("Compatibility rule pins one HTTPS request host, path, version, and script type", () => {
  const rules = readJson("rules/player-compat.json");
  assert.equal(rules.length, 1);
  assert.deepEqual(rule, {
    id: 1,
    priority: 1000,
    action: { type: "block" },
    condition: {
      regexFilter: "^https://04\\.avsee\\.is/player/ad-gate\\.js\\?v=1790860982$",
      isUrlFilterCaseSensitive: true,
      initiatorDomains: [host],
      resourceTypes: ["script"],
    },
  });
  const pattern = new RegExp(rule.condition.regexFilter);
  assert.equal(pattern.test(gateUrl), true);
  for (const url of negativeUrls) assert.equal(pattern.test(url), false, url);
});

await test("Compatibility uses the managed DNR ruleset without broader permissions or page injections", () => {
  const manifest = readJson("manifest.json");
  assert.deepEqual(manifest.declarative_net_request.rule_resources.find(resource => resource.id === rulesetId), {
    id: rulesetId, enabled: true, path: "rules/player-compat.json",
  });
  assert.deepEqual(manifest.permissions, ["activeTab", "declarativeNetRequest", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://chzzk.naver.com/*", "https://vod.sooplive.com/*", "https://youtube.com/*",
    "https://www.youtube.com/*", "https://m.youtube.com/*", "https://music.youtube.com/*",
    "https://tv.youtube.com/*", "https://www.youtube-nocookie.com/*",
  ]);
  assert.equal(manifest.content_scripts.some(entry => entry.matches.some(match => match.includes("avsee"))), false);
});

// The default fixture is an intentionally small contract test, not a copy of the
// site's player. Set PLAYER_SOURCE to the user-supplied local player.js to exercise
// the real supplied implementation against the same inert DOM/JW/ad substitutes.
const syntheticContract = `(async function () {
  const config = JSON.parse(document.getElementById('player-config').textContent);
  const result = !config.adsEnabled ? 'clear' : window.AminaPlayerAdGate
    ? await window.AminaPlayerAdGate.check(config.probeVersion) : 'unknown';
  if (result === 'blocked') {
    document.getElementById('player-status-title').textContent = 'Ads blocked';
    document.getElementById('player-ad-help').hidden = false;
  } else {
    if (result === 'clear' && config.adsEnabled) {
      const script = document.createElement('script');
      script.textContent = 'window.fixture.ads += 1;';
      document.head.appendChild(script);
    }
    window.playerInstance = window.jwplayer('player');
    window.playerInstance.setup({sources: config.sources});
    window.playerInstance.on('ready', () => {document.getElementById('player-status').hidden = true;});
  }
}());`;
let playerSource = syntheticContract;
if (process.env.PLAYER_SOURCE) {
  const sourcePath = path.resolve(process.env.PLAYER_SOURCE);
  assert.ok(fs.statSync(sourcePath).size < 500_000, "Unexpectedly large local player source");
  playerSource = fs.readFileSync(sourcePath, "utf8");
  assert.ok(playerSource.includes("AminaPlayerAdGate") && playerSource.includes("initializePlayer"),
    "PLAYER_SOURCE must be the supplied player.js, not page HTML or an ad payload");
  console.log(`Supplied player.js SHA-256: ${crypto.createHash("sha256").update(playerSource).digest("hex")}`);
} else {
  console.log("Using a synthetic player contract; set PLAYER_SOURCE to verify the supplied local player.js too.");
}

const jsonScript = value => JSON.stringify(value).replace(/</g, "\\u003c");
const locale = {lang: "en", dir: "ltr", ui: {
  adTitle: "Ads blocked", adDetail: "Synthetic blocked state", adRetry: "Check again",
  loading: "Loading", wait: "Wait", retry: "Retry", loadError: "Missing JW",
  startError: "Setup failed", slow: "Slow", resumeAt: "Resume {time}",
}, jw: {volume: "Volume", enabled: "Enabled", disabled: "Disabled"}};
const config = {languages: ["en"], locale, fallbackLocale: locale, adsEnabled: true,
  probeVersion: "1789756327", localeVersion: "fixture", sources: [], tracks: [],
  resumeId: "0".repeat(64), legacyCookie: "codex_inert_fixture"};
const stub = `
window.fixture = {setups:0, ads:0, gateExecutions:0, pauses:0, ready:0, errors:[]};
window.addEventListener('error', event => {if (event.error) window.fixture.errors.push(String(event.error));});
window.addEventListener('unhandledrejection', event => window.fixture.errors.push(String(event.reason)));
window.jwplayer = function () {
  const handlers = new Map();
  const api = {
    setup() {window.fixture.setups++;setTimeout(()=>{window.fixture.ready++;handlers.get('ready')?.();},0);return api;},
    on(name,callback) {handlers.set(name,callback);return api;},
    getContainer() {return document.getElementById('player');},
    addButton() {}, getVolume() {return 50;}, getMute() {return false;},
    setVolume() {}, setMute() {}, getDuration() {return 60;}, getPosition() {return 0;},
    pause() {window.fixture.pauses++;}, play() {handlers.get('play')?.();}, seek() {},
  };
  return api;
};`;
function fixtureHtml(mode = "absent", gateVersion = "1790860982") {
  const gate = mode === "request"
    ? `<script src="/player/ad-gate.js?v=${gateVersion}"></script>`
    : mode === "absent" ? "" : `<script>window.AminaPlayerAdGate={check:async()=>${JSON.stringify(mode)}};</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Offline compatibility fixture</title></head><body>
<main class="player-shell"><div id="player"></div>
<section id="player-status"><span id="player-spinner"></span><h1 id="player-status-title">Initial</h1>
<p id="player-status-detail"></p><button id="player-retry">Retry</button><details id="player-ad-help" hidden></details></section>
<div id="player-resume" hidden><span id="player-resume-label"></span><button id="player-continue">Continue</button><button id="player-restart">Restart</button></div>
<div id="player-toast" hidden></div><div id="fixture-overlay" data-cl-overlay="">Inert overlay</div></main>
<script id="player-config" type="application/json">${jsonScript(config)}</script>
<script id="player-ad-config" type="application/json">${jsonScript("<script>window.fixture.ads += 1;</script>")}</script>
<script>${stub}</script>${gate}<script src="/codex-fixture-player.js"></script></body></html>`;
}

async function chromeIntegration() {
  const { chromium } = require("playwright");
  const tempRoot = fs.realpathSync(os.tmpdir());
  const prefix = "light-adblock-player-compat-";
  const profile = fs.mkdtempSync(path.join(tempRoot, prefix));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {}),
      headless: false, locale: "en-US",
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
        "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND",
        "--window-position=-32000,-32000", "--window-size=900,700"],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      // No route.continue(): the real hostname is only a local DNR matching input.
      if (url.pathname === fixturePath && request.resourceType() === "document") {
        await route.fulfill({status:200, contentType:"text/html", body:fixtureHtml(url.searchParams.get("mode") || "absent", url.searchParams.get("version") || "1790860982")});
      } else if (url.hostname === parentHost && url.pathname === "/parent") {
        await route.fulfill({status:200, contentType:"text/html", body:`<!doctype html><iframe name="playerFixture" src="https://${host}${fixturePath}?mode=request"></iframe>`});
      } else if (url.pathname === "/codex-fixture-player.js" && request.resourceType() === "script") {
        await route.fulfill({status:200, contentType:"text/javascript", body:playerSource});
      } else if (url.pathname === "/player/ad-gate.js" && request.resourceType() === "script") {
        await route.fulfill({status:200, contentType:"text/javascript", body:"window.fixture.gateExecutions++;window.AminaPlayerAdGate={check:async()=> 'blocked'};"});
      } else await route.abort();
    });
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", {timeout:15000});
    const sync = async settings => {
      await worker.evaluate(async value => {
        await chrome.storage.local.set(value);
        for (let attempt=0;attempt<100;attempt++) {
          const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
          const managed = enabled.filter(id=>["easylist","ads","soop","player_compat"].includes(id));
          const ready = value.enabled
            ? ["easylist","soop","player_compat"].every(id=>managed.includes(id)) && !managed.includes("ads")
            : managed.length === 0;
          const dynamic = (await chrome.declarativeNetRequest.getDynamicRules()).filter(rule=>rule.id>=900001 && rule.id<902001);
          const expected = value.disabledSites.flatMap(site=>[`|http://${site}^`,`|https://${site}^`]).sort();
          if (ready && JSON.stringify(dynamic.map(rule=>rule.condition.urlFilter).sort())===JSON.stringify(expected)) return;
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw new Error("Settings did not synchronize");
      }, settings);
    };
    const match = async (url, type = "script", initiator = `https://${host}`) => worker.evaluate(async args => {
      const result = await chrome.declarativeNetRequest.testMatchOutcome({...args, tabId:-1});
      return result.matchedRules.some(rule=>rule.rulesetId === "player_compat");
    }, {url,type,initiator});
    await sync({enabled:true,disabledSites:[]});
    await test("Chromium DNR: exact gate matches; other hosts, files, versions, resource types, and initiators do not", async () => {
      assert.equal(await match(gateUrl), true);
      for (const url of negativeUrls) assert.equal(await match(url), false, url);
      for (const type of ["xmlhttprequest","image","main_frame","sub_frame"]) assert.equal(await match(gateUrl,type),false,type);
      assert.equal(await match(gateUrl,"script","https://unrelated.example"),false);
      // Chrome domain conditions intentionally include child initiators, while the
      // actual requested script URL remains pinned to the one exact hostname.
      assert.equal(await match(gateUrl,"script",`https://child.${host}`),true);
    });
    const page = await context.newPage();
    const inspect = async target => {
      await target.waitForFunction(()=>window.fixture && (window.fixture.setups>0 || document.getElementById('player-status-title').textContent==='Ads blocked'));
      if (await target.evaluate(()=>window.fixture.setups>0)) await target.waitForFunction(()=>window.fixture.ready===1);
      return target.evaluate(()=>({...window.fixture,
        statusHidden:document.getElementById('player-status').hidden,
        overlayHidden:getComputedStyle(document.getElementById('fixture-overlay')).display==='none',
      }));
    };
    const visit = async (mode, hostname = "player-contract.example", version) => {
      await page.goto(`https://${hostname}${fixturePath}?mode=${mode}${version ? `&version=${version}` : ""}`, {waitUntil:"load"});
      return inspect(page);
    };
    const expectedPlayback = (state, ads=0) => {
      assert.equal(state.setups,1); assert.equal(state.ready,1); assert.equal(state.ads,ads);
      assert.equal(state.statusHidden,true); assert.deepEqual(state.errors,[]);
    };
    await test(`Chromium ${process.env.PLAYER_SOURCE ? "supplied player.js" : "synthetic contract"}: absent/unknown allow initialization without ads; blocked stops; clear activates only inert ad marker`, async () => {
      for (const mode of ["absent","unknown"]) expectedPlayback(await visit(mode));
      const blocked = await visit("blocked");
      assert.equal(blocked.setups,0); assert.equal(blocked.ads,0); assert.equal(blocked.statusHidden,false); assert.deepEqual(blocked.errors,[]);
      expectedPlayback(await visit("clear"),1);
    });
    await test("Chromium: real blocked gate request reaches the player's missing-gate path without advertising, while overlay protection remains on", async () => {
      const state = await visit("request",host);
      expectedPlayback(state);
      assert.equal(state.gateExecutions,0);
      await page.waitForFunction(()=>getComputedStyle(document.getElementById('fixture-overlay')).display==='none');
      // Different gate versions stay unchanged even on the same host.
      const changed = await visit("request",host,"1790860983");
      assert.equal(changed.gateExecutions,1); assert.equal(changed.setups,0); assert.equal(changed.statusHidden,false);
    });
    await test("Chromium: global OFF and exact-site OFF restore the gate and overlay; ON restores compatibility", async () => {
      for (const settings of [{enabled:false,disabledSites:[]},{enabled:true,disabledSites:[host]}]) {
        await sync(settings);
        if (!settings.enabled) assert.equal(await match(gateUrl),false);
        const state = await visit("request",host);
        assert.equal(state.gateExecutions,1); assert.equal(state.setups,0); assert.equal(state.ads,0);
        await page.waitForFunction(()=>!document.documentElement.classList.contains('lae-active'));
        assert.equal(await page.locator('#fixture-overlay').evaluate(node=>getComputedStyle(node).display==='none'),false);
      }
      await sync({enabled:true,disabledSites:[]});
      expectedPlayback(await visit("request",host));
    });
    await test("Chromium: top-level site OFF propagates its network exception and overlay setting into the cross-origin player frame", async () => {
      const visitFrame = async () => {
        await page.goto(`https://${parentHost}/parent`,{waitUntil:"load"});
        const frame=page.frame({name:"playerFixture"}); assert.ok(frame);
        return {frame,state:await inspect(frame)};
      };
      let {frame,state}=await visitFrame();
      expectedPlayback(state); assert.equal(state.gateExecutions,0);
      await frame.waitForFunction(()=>document.documentElement.classList.contains('lae-active'));
      await sync({enabled:true,disabledSites:[parentHost]});
      ({frame,state}=await visitFrame());
      assert.equal(state.gateExecutions,1); assert.equal(state.setups,0);
      await frame.waitForFunction(()=>!document.documentElement.classList.contains('lae-active'));
      await sync({enabled:true,disabledSites:[]});
      ({state}=await visitFrame()); expectedPlayback(state); assert.equal(state.gateExecutions,0);
    });
  } finally {
    await context?.close();
    const resolved=path.resolve(profile);
    if (path.dirname(resolved)!==tempRoot || !path.basename(resolved).startsWith(prefix)) throw new Error("Refusing unexpected profile cleanup path");
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

if (process.argv.includes("--chrome")) await chromeIntegration();
console.log(`Player compatibility checks complete: ${passed} groups passed${process.argv.includes("--chrome") ? " (offline Chromium integration)" : " (add --chrome for offline Chromium integration)"}`);
