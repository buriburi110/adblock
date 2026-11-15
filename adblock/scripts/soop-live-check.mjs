import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const extensionEnabled = process.argv.includes("--extension");
const headed = process.argv.includes("--headed");
const repeatAfterReload = process.argv.includes("--reload");
const extensionDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryPrefix = "light-adblock-soop-live-check-";
const profileDirectory = fs.mkdtempSync(path.join(temporaryRoot, temporaryPrefix));
const targetUrl = "https://vod.sooplive.com/player/206062537";
const knownEndpoint = /\/api\/get_ad\.php|\/api\/v1\/recommend|\/station\/video\/a\/view|\/api\/da_block_api\.php/;

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "blob:") return "blob:" + url.origin + "/<uuid>";
    if (knownEndpoint.test(url.pathname)) return url.origin + url.pathname;
    if (/\.(?:m3u8|mp4|ts|m4s)(?:$|\/)/i.test(url.pathname)) return url.origin + "/<media>";
    if (/^\/(?:asset\/app\/vodplayer\/|script\/|data\/ad\/)/.test(url.pathname)) return url.origin + url.pathname;
    return url.origin + "/<resource>";
  } catch { return "<invalid-url>"; }
}
function safeError(value) {
  return String(value).replace(/https?:\/\/[^\s)'"<>]+/g, safeUrl).slice(0, 600);
}
function assertSafeTemporaryDirectory() {
  const resolved = path.resolve(profileDirectory);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith(temporaryPrefix)) {
    throw new Error("Unsafe temporary profile cleanup path");
  }
}
let context;
try {
  context = await chromium.launchPersistentContext(profileDirectory, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: [
      "--window-position=-32000,-32000", "--window-size=1280,900",
      ...(extensionEnabled ? ["--disable-extensions-except=" + extensionDirectory, "--load-extension=" + extensionDirectory] : []),
    ],
    ...(extensionEnabled ? { ignoreDefaultArgs: ["--disable-extensions"] } : {}),
  });
  let extensionState = null;
  if (extensionEnabled) {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 15000 });
    extensionState = await worker.evaluate(async () => {
      let registered = [];
      for (let attempt = 0; attempt < 60; attempt += 1) {
        registered = await chrome.scripting.getRegisteredContentScripts();
        if (registered.some(script => script.id.includes("soop"))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return {
        version: chrome.runtime.getManifest().version,
        rulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
        soopScripts: registered.filter(script => script.id.includes("soop")).map(script => ({id:script.id, world:script.world, files:script.js})),
      };
    });
    if (!extensionState.rulesets.includes("soop")) throw new Error("SOOP ruleset is not enabled");
  }
  const page = await context.newPage();
  const errors = [];
  const failures = [];
  const responses = [];
  page.on("pageerror", error => errors.push(safeError(error.stack || error.message)));
  page.on("requestfailed", request => {
    if (["image", "font", "stylesheet"].includes(request.resourceType())) return;
    failures.push({ url: safeUrl(request.url()), type: request.resourceType(), error: request.failure()?.errorText });
  });
  page.on("response", response => {
    const request = response.request();
    if (knownEndpoint.test(request.url()) || request.resourceType() === "media" || /\.m3u8(?:\?|$)/i.test(request.url())) {
      responses.push({ url: safeUrl(request.url()), type: request.resourceType(), status: response.status() });
    }
  });
  async function state() {
    return page.evaluate(() => {
      const mediaState = id => {
        const element = document.getElementById(id);
        if (!element) return null;
        return { srcPresent:Boolean(element.currentSrc || element.src), ready:element.readyState, network:element.networkState, paused:element.paused, error:element.error?.code || 0, time:element.currentTime, duration:Number.isFinite(element.duration)?element.duration:null };
      };
      return {
        corePresent: typeof vodCore !== "undefined" && Boolean(vodCore),
        identity: typeof vodCore !== "undefined" && vodCore ? vodCore.identity : null,
        main:mediaState("video"), ad:mediaState("adVideo"),
        codecs:{h264:document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"'),aac:document.createElement("audio").canPlayType('audio/mp4; codecs="mp4a.40.2"')},
      };
    });
  }
  async function runPlaybackPass(label, reload) {
    const failureStart = failures.length;
    const responseStart = responses.length;
    if (reload) await page.reload({ waitUntil:"domcontentloaded", timeout:30000 });
    else await page.goto(targetUrl, { waitUntil:"domcontentloaded", timeout:30000 });
    await page.waitForTimeout(10000);
    const initial = await state();
    const vodLink = page.getByText("VOD 보기", { exact:true }).first();
    let action = "already-playing";
    if (await vodLink.isVisible()) {
      await vodLink.click({timeout:5000});
      action = "clicked-vod-view";
    } else if (!initial.main || initial.main.paused) {
      const playButton = page.getByRole("button", {name:/^(재생|Play)$/i}).first();
      if (await playButton.isVisible()) { await playButton.click({timeout:5000}); action = "clicked-play"; }
      else action = "no-visible-play-control";
    }
    await page.waitForTimeout(5000);
    let current = await state();
    let adObserved = Boolean(current.ad && !current.ad.paused && current.ad.time > 0.25);
    console.log(JSON.stringify({phase:"started",label,extensionEnabled,headed,extensionState,action,initial,current}));
    for (let attempt = 0; attempt < 24 && !(current.main && !current.main.paused && current.main.time > 1 && current.main.ready >= 2); attempt += 1) {
      await page.waitForTimeout(2000);
      current = await state();
      adObserved ||= Boolean(current.ad && !current.ad.paused && current.ad.time > 0.25);
    }
    const before = current;
    await page.waitForTimeout(3000);
    const after = await state();
    adObserved ||= Boolean(after.ad && !after.ad.paused && after.ad.time > 0.25);
    const mainProgressed = Boolean(before.main && after.main && !after.main.paused && after.main.error === 0 && after.main.ready >= 2 && after.main.time > before.main.time + 0.5);
    const passFailures = failures.slice(failureStart);
    const blockedAdRequests = passFailures.filter(item => knownEndpoint.test(item.url) && /ERR_BLOCKED_BY_CLIENT/.test(item.error || ""));
    console.log(JSON.stringify({phase:"result",label,extensionEnabled,action,adObserved,mainProgressed,before,after,blockedAdRequests,errors:[...errors],responses:responses.slice(responseStart),failures:passFailures}));
    if (!mainProgressed) throw new Error(label + ": main video did not make playback progress");
    if (extensionEnabled && adObserved) throw new Error(label + ": ad playback was observed while extension was enabled");
    if (extensionEnabled && blockedAdRequests.length === 0) throw new Error(label + ": no SOOP advertising API request was observed blocked");
  }
  await runPlaybackPass("initial-navigation", false);
  if (repeatAfterReload) await runPlaybackPass("after-reload", true);
} catch (error) {
  console.error(safeError(error.stack || error));
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  assertSafeTemporaryDirectory();
  fs.rmSync(profileDirectory, {recursive:true,force:true,maxRetries:5,retryDelay:200});
}
