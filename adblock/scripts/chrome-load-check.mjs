import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.resolve(scriptDirectory, "..");
const temporaryPrefix = path.join(os.tmpdir(), "light-adblock-chrome-check-");
const profileDirectory = fs.mkdtempSync(temporaryPrefix);

function assertSafeTemporaryDirectory(directory) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedTemporaryRoot = path.resolve(os.tmpdir());
  const expectedNamePrefix = "light-adblock-chrome-check-";

  if (
    path.dirname(resolvedDirectory) !== resolvedTemporaryRoot ||
    !path.basename(resolvedDirectory).startsWith(expectedNamePrefix)
  ) {
    throw new Error(`안전하지 않은 임시 경로입니다: ${resolvedDirectory}`);
  }
}

let context;

try {
  const { chromium } = require("playwright");
  context = await chromium.launchPersistentContext(profileDirectory, {
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      "--window-position=-32000,-32000",
      "--window-size=800,600",
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  let [serviceWorker] = context.serviceWorkers();
  serviceWorker ??= await context.waitForEvent("serviceworker", {
    timeout: 15_000,
  });

  const result = await serviceWorker.evaluate(async () => {
    const enabledRulesets =
      await chrome.declarativeNetRequest.getEnabledRulesets();
    const availableStaticRuleCount =
      await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
    const matchResult =
      await chrome.declarativeNetRequest.testMatchOutcome({
        initiator: "https://publisher.example",
        tabId: -1,
        type: "script",
        url: "https://ad.doubleclick.net/ad.js",
      });
    let youtubeScripts = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      youtubeScripts = await chrome.scripting.getRegisteredContentScripts({
        ids: ["youtube-main-world", "youtube-early-guard"],
      });
      if (youtubeScripts.length === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return {
      availableStaticRuleCount,
      enabledRulesets,
      matchedRules: matchResult.matchedRules,
      youtubeScripts,
    };
  });

  if (!result.enabledRulesets.includes("easylist")) {
    throw new Error(
      `Chrome이 EasyList를 활성화하지 않았습니다: ${JSON.stringify(result.enabledRulesets)}`,
    );
  }

  if (
    !result.matchedRules.some((match) => match.rulesetId === "easylist")
  ) {
    throw new Error(
      `EasyList 시험 요청이 일치하지 않았습니다: ${JSON.stringify(result.matchedRules)}`,
    );
  }

  const mainScript = result.youtubeScripts.find(
    (script) => script.id === "youtube-main-world",
  );
  const isolatedScript = result.youtubeScripts.find(
    (script) => script.id === "youtube-early-guard",
  );
  if (
    mainScript?.world !== "MAIN" ||
    mainScript?.runAt !== "document_start" ||
    mainScript?.allFrames !== true ||
    mainScript?.matchOriginAsFallback !== true ||
    mainScript?.js?.[0] !==
      "vendor/ublock-origin-lite/ublock-filters-main.js"
  ) {
    throw new Error(
      `YouTube MAIN scriptlet 등록이 올바르지 않습니다: ${JSON.stringify(mainScript)}`,
    );
  }
  if (
    isolatedScript?.world !== "ISOLATED" ||
    isolatedScript?.runAt !== "document_start" ||
    isolatedScript?.allFrames !== true ||
    isolatedScript?.matchOriginAsFallback !== true ||
    isolatedScript?.js?.[0] !==
      "vendor/ublock-origin-lite/ublock-filters-isolated.js"
  ) {
    throw new Error(
      `YouTube ISOLATED scriptlet 등록이 올바르지 않습니다: ${JSON.stringify(isolatedScript)}`,
    );
  }

  const fixturePage = await context.newPage();
  const fixtureErrors = [];
  fixturePage.on("pageerror", (error) => fixtureErrors.push(String(error)));
  await fixturePage.route(
    "https://www.youtube.com/codex-adblock-fixture",
    (route) =>
      route.fulfill({
        body: `<!doctype html><html><head>
<script>
window.__nativeMapHas = Map.prototype.has;
window.__nativePromiseThen = Promise.prototype.then;
window.ytInitialData = {};
window.ytcfg = { data_: { INNERTUBE_CONTEXT: { client: {
  userAgent: "Mozilla/5.0 (Windows NT 10.0)"
} } } };
</script>
<script>(function serverContract(){ window.__originalServerContractRan = true; })();</script>
<script>window.__fetchGuardExecuted = true; void [window,"fetch"];</script>
</head><body>YouTube scriptlet fixture</body></html>`,
        contentType: "text/html",
        status: 200,
      }),
  );
  await fixturePage.goto(
    "https://www.youtube.com/codex-adblock-fixture",
    { waitUntil: "load" },
  );
  await fixturePage.waitForTimeout(100);
  const fixtureResult = await fixturePage.evaluate(() => ({
    fetchGuardNeutralized: window.__fetchGuardExecuted !== true,
    mapPatched: Map.prototype.has !== window.__nativeMapHas,
    originalServerContractRan: window.__originalServerContractRan === true,
    promisePatched: Promise.prototype.then !== window.__nativePromiseThen,
  }));
  await fixturePage.close();
  if (
    fixtureErrors.length !== 0 ||
    !Object.values(fixtureResult).every(Boolean)
  ) {
    throw new Error(
      `YouTube scriptlet fixture 실패: ${JSON.stringify({ fixtureErrors, fixtureResult })}`,
    );
  }
  result.youtubeFixture = fixtureResult;

  console.log("Chrome 로드 검사 완료");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close();
  assertSafeTemporaryDirectory(profileDirectory);
  fs.rmSync(profileDirectory, { force: true, recursive: true });
}
