// Real public-stream diagnostic: uses a fresh profile, never installs a native
// connector, and prints no cookies, signed stream URLs, or API response bodies.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionEnabled = process.argv.includes("--extension");
const reload = process.argv.includes("--reload");
const secondsArgument = process.argv.find((arg) => arg.startsWith("--seconds="));
const sampleSeconds = secondsArgument ? Number(secondsArgument.slice("--seconds=".length)) : 20;
assert.ok(Number.isInteger(sampleSeconds) && sampleSeconds >= 5 && sampleSeconds <= 180,
  "--seconds must be an integer from 5 to 180");
const target = process.argv.find((arg) => arg.startsWith("https://")) ??
  "https://chzzk.naver.com/live/ec857bee6cded06df19dae85cf37f878";
const targetUrl = new URL(target);
assert.equal(targetUrl.origin, "https://chzzk.naver.com");
assert.match(targetUrl.pathname, /^\/live\/[a-f0-9]{32}$/);
const tempRoot = fs.realpathSync(os.tmpdir());
const prefix = "light-adblock-chzzk-live-";
const profile = fs.mkdtempSync(path.join(tempRoot, prefix));
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    // Use the real desktop browser mode: HeadlessChrome gets a different site UI.
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      "--window-position=-32000,-32000", "--window-size=1280,900", "--mute-audio",
      ...(extensionEnabled ? [`--load-extension=${root}`, `--disable-extensions-except=${root}`] : []),
    ],
    ...(extensionEnabled ? { ignoreDefaultArgs: ["--disable-extensions"] } : {}),
  });
  if (extensionEnabled) {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const registration = await worker.evaluate(async () => {
      for (let i = 0; i < 70; i += 1) {
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        const script = scripts.find((item) => item.id === "chzzk-quality-main-world");
        if (script) return { version: chrome.runtime.getManifest().version, script };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Chzzk script registration did not complete");
    });
    assert.equal(registration.script.world, "MAIN");
    assert.equal(registration.script.runAt, "document_start");
    console.log(JSON.stringify({ extension: registration.version, script: registration.script.id }));
  }
  const page = await context.newPage();
  const requestTypes = new Set();
  const adRequestHosts = new Set();
  const failedRequestHosts = new Set();
  const pageErrorNames = [];
  page.on("pageerror", (error) => pageErrorNames.push(error.name));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "api.chzzk.naver.com") {
      if (/^\/service\/t\//.test(url.pathname)) requestTypes.add(`tunnel:${request.resourceType()}`);
      if (/live-status$/.test(url.pathname)) requestTypes.add(`polling:${request.resourceType()}`);
    }
    if (/veta|gfp|doubleclick|googlesyndication/.test(url.hostname)) adRequestHosts.add(url.hostname);
  });
  page.on("requestfailed", (request) => {
    failedRequestHosts.add(`${new URL(request.url()).hostname}:${request.failure()?.errorText}`);
  });
  const snapshot = () => page.evaluate(() => {
    const visible = (el) => {
      if (!el || el.getClientRects().length === 0) return false;
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    };
    // Keep only transient node/source identities; signed media URLs never leave
    // the page. Index-based comparison could otherwise confuse an ad with live.
    const key = Symbol.for("codex.chzzk.live-check.video-identities");
    const identities = window[key] ??= { nodes: new WeakMap(), next: 1 };
    const adUiEvidence = [];
    for (const selector of [
      ".pzp-ad-break-indicator", ".pzp-ad-click-through-button",
      ".pzp-pc__ad-break-indicator", ".pzp-pc__ad-click-through-button",
      ".vod_player_wrap .btn_skip", ".vod_player_wrap .link_more", "[data-role='adControlEl']",
    ]) {
      if ([...document.querySelectorAll(selector)].some(visible)) adUiEvidence.push(selector);
    }
    // These are player controls from the public bundles, not chat text. The
    // current video-ad SDK uses Korean click-through text and a SKIP countdown.
    const playerRoots = document.querySelectorAll(".pzp-pc, .vod_player_wrap, #preAdPlayerWrapper, #midAdPlayerWrapper");
    for (const root of playerRoots) {
      for (const element of root.querySelectorAll("a, button, [role='button'], .txt_skip")) {
        if (!visible(element)) continue;
        const label = (element.getAttribute("aria-label") || element.textContent || "").trim().replace(/\s+/g, " ");
        if (label === "광고 페이지 보기") adUiEvidence.push("text:광고 페이지 보기");
        if (/^(?:광고\s+|\d+\s*초\s*후\s*)?SKIP$/i.test(label)) adUiEvidence.push("text:SKIP/countdown");
      }
    }
    const text = document.body.innerText;
    let diagnostics = null;
    try {
      const raw = JSON.parse(document.documentElement.getAttribute("data-lae-chzzk-diagnostics"));
      if ([1, 2].includes(raw?.schema) && typeof raw.revision === "string" && /^[\d.]{1,20}$/.test(raw.revision)) {
        // The DOM belongs to the site; log only our fixed primitive schema.
        diagnostics = { schema: raw.schema, revision: raw.revision, installed: {}, active: {}, counts: {} };
        for (const key of ["xhr", "fetch", "parser", "tunnel"]) {
          if (typeof raw.installed?.[key] === "boolean") diagnostics.installed[key] = raw.installed[key];
          if (typeof raw.active?.[key] === "boolean") diagnostics.active[key] = raw.active[key];
        }
        for (const key of ["apiPatches", "publicPlaybacks", "adPolicies", "waterfalls"]) {
          if (Number.isInteger(raw.counts?.[key]) && raw.counts[key] >= 0 && raw.counts[key] <= 1_000_000) {
            diagnostics.counts[key] = raw.counts[key];
          }
        }
        if (raw.schema === 2) {
          diagnostics.playbackChecks = {};
          for (const key of ["candidates", "descriptorRejected", "entitlementRejected",
            "mediaShapeRejected", "mediaUrlRejected", "mediaHostRejected", "noP2pPaths",
            "partiallyPatched", "fullyPatched"]) {
            const count = raw.playbackChecks?.[key];
            if (Number.isInteger(count) && count >= 0 && count <= 1_000_000) {
              diagnostics.playbackChecks[key] = count;
            }
          }
        }
      }
    } catch {}
    return {
      installationGuide: text.includes("설치없이 일반 화질 시청") || text.includes("확장 프로그램을 먼저 설치"),
      loginRequired: /로그인 후 시청|로그인이 필요한|로그인이 필요합니다/.test(text),
      ageGate: /연령 확인이 필요|성인 인증이 필요/.test(text),
      paidGate: /구매 후 시청|구매가 필요/.test(text),
      ended: /방송이 종료되었습니다|방송 중이 아닙니다/.test(text),
      visibleAdUi: adUiEvidence.length > 0,
      adUiEvidence: [...new Set(adUiEvidence)],
      filtering: document.documentElement.getAttribute("data-lae-player"),
      handlerInstalled: Boolean(window[Symbol.for("lae.chzzk.response.v2")]),
      diagnostics,
      videos: [...document.querySelectorAll("video")].map((video) => {
        let identity = identities.nodes.get(video);
        if (!identity) {
          identity = { id: identities.next++, source: video.currentSrc, sourceId: 1 };
          identities.nodes.set(video, identity);
        } else if (identity.source !== video.currentSrc) {
          identity.source = video.currentSrc;
          identity.sourceId += 1;
        }
        const ad = Boolean(video.matches("#midPlayer, #preAdContentPlayer, .midPlayer") ||
          video.closest("#preAdPlayerWrapper, #preAdVideoContainer, #midAdPlayerWrapper, #midAdVideoContainer, .vod_player_wrap"));
        const main = !ad && video.matches(".pzp-pc__video video.webplayer-internal-video");
        return {
          id: identity.id, sourceId: identity.sourceId,
          role: ad ? "ad" : main ? "main" : "unknown", visible: visible(video),
          width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
          ready: video.readyState, paused: video.paused, error: video.error?.code ?? 0,
          frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
        };
      }),
    };
  });

  async function inspect(label, shouldReload) {
    requestTypes.clear();
    adRequestHosts.clear();
    failedRequestHosts.clear();
    pageErrorNames.length = 0;
    if (shouldReload) await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    else await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    let state;
    let adUiObserved = false;
    let adVideoObserved = false;
    const adEvidence = new Set();
    const observeAds = (current) => {
      adUiObserved ||= current.visibleAdUi;
      adVideoObserved ||= current.videos.some((video) => video.role === "ad" && video.visible && video.ready >= 2);
      for (const evidence of current.adUiEvidence) adEvidence.add(evidence);
    };
    for (let i = 0; i < 25; i += 1) {
      await page.waitForTimeout(1_000);
      state = await snapshot();
      observeAds(state);
      if (state.loginRequired || state.ageGate || state.paidGate) {
        throw new Error("Site authorization is required; no access gate was modified");
      }
      if (state.installationGuide || state.ended || (!state.visibleAdUi && state.videos.some((video) =>
        video.role === "main" && video.visible && video.height >= 1080 && !video.paused))) break;
    }
    const before = state;
    for (let i = 0; i < sampleSeconds; i += 1) {
      await page.waitForTimeout(1_000);
      state = await snapshot();
      observeAds(state);
    }
    const progressed = !before.visibleAdUi && !state.visibleAdUi && state.videos.some((video) => {
      const start = before.videos.find((item) => item.id === video.id && item.sourceId === video.sourceId);
      return start?.role === "main" && start.visible && video.role === "main" && video.visible &&
        !video.paused && video.ready >= 2 && video.error === 0 &&
        video.time > start.time + 2 && video.height >= 1080;
    });
    console.log(JSON.stringify({ label, extensionEnabled, before, after: state, progressed,
      sampleSeconds, adUiObserved, adVideoObserved, adEvidence: [...adEvidence],
      requestTypes: [...requestTypes], adRequestHosts: [...adRequestHosts],
      failedRequestHosts: [...failedRequestHosts], pageErrorNames }));
    if (extensionEnabled) {
      assert.equal(state.installationGuide, false, "Native-addon installation guide is still visible");
      assert.equal(progressed, true, "1080p main playback was not confirmed");
      assert.equal(adUiObserved, false, "Advertising UI was visible during the sampled interval");
      assert.equal(adVideoObserved, false, "An identified pre-roll/mid-roll video was visible during the sampled interval");
    } else {
      assert.equal(state.ended, false, "The public broadcast has ended");
      assert.ok(state.installationGuide || progressed,
        "Baseline did not reach the installation guide or meaningful playback");
    }
  }
  await inspect("initial-navigation", false);
  if (reload) await inspect("after-reload", true);
} catch (error) {
  // Stack/URLs may include signed stream values; only emit a scrubbed message.
  console.error(String(error.message).replace(/https?:\/\/\S+/g, "[URL]"));
  process.exitCode = 1;
} finally {
  await context?.close();
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(prefix)) {
    throw new Error("Refusing unexpected temporary profile cleanup");
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
