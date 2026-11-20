import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const extension = fileURLToPath(new URL("../", import.meta.url));
const context = await chromium.launchPersistentContext("", {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const cases = [
    ["https://t1.kakaocdn.net/kas/static/ba.min.js?v=1", "script", true],
    ["https://t1.daumcdn.net/kas/static/ba.min.js", "script", true],
    ["https://t1.kakaocdn.net/kas/static/editor.js", "script", false],
    ["https://cdn.nhnace.com/libs/aceadlib.html", "sub_frame", true],
    ["https://loader.fmkorea.com/_loader/loader.php?slot=3", "sub_frame", true],
    ["https://cdn.nhnace.com/libs/aceadlib.html", "sub_frame", false, "https://other.example"],
  ];
  // Isolate the supplemental list so EasyList cannot mask a missing rule.
  await worker.evaluate(() => chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ["easylist"] }));
  for (const [url, type, expected, initiator = "https://www.fmkorea.com"] of cases) {
    const matches = await worker.evaluate(async request => {
      const result = await chrome.declarativeNetRequest.testMatchOutcome(request);
      return result.matchedRules.some(rule => rule.rulesetId === "publisher_slots");
    }, { url, type, initiator });
    assert.equal(matches, expected, url);
  }
  await worker.evaluate(() => chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ["easylist"] }));

  const page = await context.newPage();
  await page.route("https://publisher.example/", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><meta charset=utf-8><main><button id="read">본문</button><div id="slot"><video muted></video></div><dialog aria-label="광고"></dialog><dialog id="login"></dialog></main>',
  }));
  await page.goto("https://publisher.example/");
  const genericActive = () => page.waitForSelector("html.lae-active.lae-generic-active");
  await genericActive();
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    const video = document.querySelector("video");
    video.srcObject = canvas.captureStream();
    canvas.getContext("2d").fillRect(0, 0, 10, 10);
    await video.play();
  });
  assert.equal(await page.locator("video").evaluate(el => el.paused), false);
  await page.locator("#slot").evaluate(el => el.classList.add("video-ad-container"));
  await page.waitForFunction(() => document.querySelector("video").paused);
  assert.equal(await page.locator("#slot").isVisible(), false);
  const ad = page.locator('dialog[aria-label="광고"]');
  await ad.evaluate(el => el.showModal());
  await page.waitForFunction(() => !document.querySelector("dialog").open);
  await page.locator("#read").click();
  await page.locator("#login").evaluate(el => el.showModal());
  assert.equal(await page.locator("#login").evaluate(el => el.matches(":modal")), true);
  await page.locator("#login").evaluate(el => el.close());

  // Site allowlist applies immediately; removing it also cleans up an existing modal.
  await worker.evaluate(() => chrome.storage.local.set({ disabledSites: ["publisher.example"] }));
  await page.waitForSelector("html:not(.lae-active)");
  assert.equal(await page.locator("#slot").isVisible(), true);
  await ad.evaluate(el => el.showModal());
  assert.equal(await ad.evaluate(el => el.matches(":modal")), true);
  await worker.evaluate(() => chrome.storage.local.set({ disabledSites: [] }));
  await genericActive();
  await page.waitForFunction(() => !document.querySelector("dialog").open);
  console.log("PASS: publisher DNR, late ad video, modal focus, ordinary content and site allowlist");
} finally {
  await context.close();
}
