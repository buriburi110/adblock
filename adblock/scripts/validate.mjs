import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");

function readJson(relativePath) {
  const absolutePath = path.join(rootDirectory, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

const manifest = readJson("manifest.json");
const errors = [];
const ruleResources = manifest.declarative_net_request?.rule_resources ?? [];

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((script) => [
    ...(script.css ?? []),
    ...(script.js ?? []),
  ]),
  ...(manifest.declarative_net_request?.rule_resources ?? []).map(
    (ruleset) => ruleset.path,
  ),
  "rules/cosmetic-specific.json",
  "rules/hijack-patterns.source.txt",
  "sites/chzzk.js",
  "sites/soop.js",
  "rules/soop.source.txt",
  "rules/soop.metadata.json",
  "rules/SOOP_NOTICE.md",
  "vendor/ublock-origin-lite/ublock-filters-main.js",
  "vendor/ublock-origin-lite/ublock-filters-isolated.js",
  "vendor/ublock-origin-lite/metadata.json",
  "vendor/ublock-origin-lite/NOTICE.md",
  "LICENSE.txt",
].filter(Boolean);

for (const relativePath of referencedFiles) {
  if (!fs.existsSync(path.join(rootDirectory, relativePath))) {
    errors.push(`Manifest가 가리키는 파일이 없습니다: ${relativePath}`);
  }
}

for (const [declaredSize, relativePath] of Object.entries(
  manifest.icons ?? {},
)) {
  const absolutePath = path.join(rootDirectory, relativePath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }

  const image = fs.readFileSync(absolutePath);
  const isPng = image.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const size = Number.parseInt(declaredSize, 10);

  if (
    !isPng ||
    image.length < 24 ||
    image.readUInt32BE(16) !== size ||
    image.readUInt32BE(20) !== size
  ) {
    errors.push(`아이콘 크기 또는 형식이 잘못됐습니다: ${relativePath}`);
  }
}

if (manifest.manifest_version !== 3) {
  errors.push("manifest_version은 3이어야 합니다.");
}

if (Number.parseInt(manifest.minimum_chrome_version, 10) < 101) {
  errors.push("requestDomains 사용을 위해 Chrome 101 이상이 필요합니다.");
}

const mainWorldScripts = (manifest.content_scripts ?? []).filter(
  (script) => script.world === "MAIN",
);
if (Number.parseInt(manifest.minimum_chrome_version, 10) < 122) {
  errors.push("uBOL Chromium 번들과 matchOriginAsFallback을 위해 Chrome 122 이상이 필요합니다.");
}

for (const script of mainWorldScripts) {
  if (script.run_at !== "document_start" || script.all_frames !== true) {
    errors.push("YouTube MAIN world 스크립트는 document_start/all_frames여야 합니다.");
  }
}

const ubolMetadataPath = path.join(
  rootDirectory,
  "vendor",
  "ublock-origin-lite",
  "metadata.json",
);
if (fs.existsSync(ubolMetadataPath)) {
  const ubolMetadata = readJson("vendor/ublock-origin-lite/metadata.json");
  if (
    ubolMetadata.schemaVersion !== 1 ||
    ubolMetadata.project !== "uBlock Origin Lite" ||
    ubolMetadata.license !== "GPL-3.0-or-later" ||
    !/^\d{4}\.\d+\.\d+$/.test(ubolMetadata.release) ||
    !Array.isArray(ubolMetadata.files) ||
    ubolMetadata.files.length !== 2
  ) {
    errors.push("uBOL vendor 메타데이터가 올바르지 않습니다.");
  } else {
    for (const file of ubolMetadata.files) {
      const absolutePath = path.join(rootDirectory, file.path ?? "");
      if (!fs.existsSync(absolutePath)) {
        errors.push(`uBOL vendor 파일이 없습니다: ${file.path}`);
        continue;
      }
      const actualHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(absolutePath))
        .digest("hex");
      if (actualHash !== file.sha256) {
        errors.push(`uBOL vendor 해시가 다릅니다: ${file.path}`);
      }
    }

    const mainBundle = fs.readFileSync(
      path.join(
        rootDirectory,
        "vendor",
        "ublock-origin-lite",
        "ublock-filters-main.js",
      ),
      "utf8",
    );
    const isolatedBundle = fs.readFileSync(
      path.join(
        rootDirectory,
        "vendor",
        "ublock-origin-lite",
        "ublock-filters-isolated.js",
      ),
      "utf8",
    );
    for (const marker of [
      "trustedJsonEditXhrRequest",
      "trustedPreventDomBypass",
      '"www.youtube.com"',
    ]) {
      if (!mainBundle.includes(marker)) {
        errors.push(`uBOL MAIN 번들에 YouTube 표식이 없습니다: ${marker}`);
      }
    }
    for (const marker of [
      "(function serverContract()",
      "onAbnormalityDetected",
      '"www.youtube.com"',
    ]) {
      if (!isolatedBundle.includes(marker)) {
        errors.push(`uBOL ISOLATED 번들에 YouTube 표식이 없습니다: ${marker}`);
      }
    }
  }
}

for (const requiredPermission of ["activeTab", "scripting", "storage"]) {
  if (!manifest.permissions?.includes(requiredPermission)) {
    errors.push(`필수 권한 누락: ${requiredPermission}`);
  }
}

for (const requiredYoutubeHost of [
  "https://www.youtube.com/*",
  "https://www.youtube-nocookie.com/*",
]) {
  if (!manifest.host_permissions?.includes(requiredYoutubeHost)) {
    errors.push(`YouTube 호스트 권한 누락: ${requiredYoutubeHost}`);
  }
}

if (
  !manifest.permissions?.some((permission) =>
    ["declarativeNetRequest", "declarativeNetRequestWithHostAccess"].includes(
      permission,
    ),
  )
) {
  errors.push("DNR 권한이 필요합니다.");
}

if (!ruleResources.length) {
  errors.push("정적 DNR ruleset이 하나 이상 필요합니다.");
}

const soopResource = ruleResources.find((resource) => resource.id === "soop");
if (soopResource?.path !== "rules/soop.json" || soopResource.enabled !== true) {
  errors.push("SOOP 보조 ruleset 선언이 없거나 잘못됐습니다.");
}
if (!manifest.host_permissions?.includes("https://vod.sooplive.com/*")) {
  errors.push("SOOP VOD MAIN script 등록을 위한 호스트 권한이 없습니다.");
}

const playerCompatResource = ruleResources.find((resource) => resource.id === "player_compat");
if (playerCompatResource?.path !== "rules/player-compat.json" || playerCompatResource.enabled !== true) {
  errors.push("버전 고정 플레이어 호환 ruleset 선언이 없거나 잘못됐습니다.");
}
try {
  const expectedPlayerRules = [{
    id: 1,
    priority: 1000,
    action: { type: "block" },
    condition: {
      regexFilter: "^https://04\\.avsee\\.is/player/ad-gate\\.js\\?v=1790860982$",
      isUrlFilterCaseSensitive: true,
      initiatorDomains: ["04.avsee.is"],
      resourceTypes: ["script"],
    },
  }];
  if (JSON.stringify(readJson("rules/player-compat.json")) !== JSON.stringify(expectedPlayerRules)) {
    errors.push("플레이어 호환 규칙은 확인된 HTTPS 호스트·경로·버전의 script 요청 1개로 제한해야 합니다.");
  }
} catch (error) {
  errors.push(`플레이어 호환 규칙을 읽지 못했습니다: ${error.message}`);
}

try {
  const metadata = readJson("rules/soop.metadata.json");
  const source = fs.readFileSync(path.join(rootDirectory, "rules/soop.source.txt"), "utf8");
  const filterLines = source.split(/\r?\n/).filter((line) => line && !line.startsWith("!"));
  const networkFilters = filterLines.filter((line) => line.startsWith("||"));
  const scriptletFilters = filterLines.filter((line) => line.includes("##+js("));
  const ruleText = fs.readFileSync(path.join(rootDirectory, "rules/soop.json"), "utf8");
  const rules = JSON.parse(ruleText);
  if (
    metadata.schemaVersion !== 1 || metadata.project !== "List-KR" ||
    metadata.license !== "GPL-3.0" || !/^[a-f0-9]{40}$/.test(metadata.commit) ||
    !source.includes(metadata.commit) ||
    metadata.output?.rulesetId !== "soop" || metadata.output?.path !== "rules/soop.json" ||
    metadata.output?.ruleCount !== rules.length ||
    metadata.output?.sha256 !== crypto.createHash("sha256").update(ruleText).digest("hex")
  ) {
    errors.push("SOOP 출처 메타데이터 또는 DNR 해시가 올바르지 않습니다.");
  }
  if (
    networkFilters.length !== 9 || scriptletFilters.length !== 1 ||
    scriptletFilters[0] !== metadata.scriptlet?.sourceFilter ||
    metadata.scriptlet?.removedPath !== "data.adballoon"
  ) {
    errors.push("SOOP 원본 선택 규칙이 메타데이터와 일치하지 않습니다.");
  }
  const expectedRules = networkFilters.map((urlFilter, index) => ({
    id: index + 1,
    priority: 1000,
    action: { type: "block" },
    condition: {
      urlFilter,
      initiatorDomains: ["sooplive.com"],
      excludedResourceTypes: ["main_frame"],
    },
  }));
  if (JSON.stringify(rules) !== JSON.stringify(expectedRules)) {
    errors.push("SOOP DNR 변환이 원본 필터 또는 제한된 SOOP 적용 범위와 다릅니다.");
  }
} catch (error) {
  errors.push(`SOOP 출처 및 규칙 검증 실패: ${error.message}`);
}

const rulesetIds = new Set();
let totalRuleCount = 0;
const actionCounts = new Map();
let easyListRules = null;
let easyListText = "";

for (const resource of ruleResources) {
  if (rulesetIds.has(resource.id)) {
    errors.push(`중복 ruleset ID: ${resource.id}`);
  }
  rulesetIds.add(resource.id);

  const absolutePath = path.join(rootDirectory, resource.path);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }

  let rules;
  try {
    easyListText = resource.id === "easylist"
      ? fs.readFileSync(absolutePath, "utf8")
      : easyListText;
    rules = resource.id === "easylist"
      ? JSON.parse(easyListText)
      : readJson(resource.path);
  } catch (error) {
    errors.push(`${resource.path} JSON을 읽지 못했습니다: ${error.message}`);
    continue;
  }

  if (!Array.isArray(rules) || rules.length === 0) {
    errors.push(`${resource.id} ruleset에 규칙이 하나 이상 필요합니다.`);
    continue;
  }

  totalRuleCount += rules.length;
  if (resource.id === "easylist") {
    easyListRules = rules;
  }
  const ruleIds = new Set();

  for (const rule of rules) {
    if (!Number.isInteger(rule.id) || rule.id <= 0) {
      errors.push(`${resource.id}의 잘못된 규칙 ID: ${rule.id}`);
    }

    if (ruleIds.has(rule.id)) {
      errors.push(`${resource.id}의 중복 규칙 ID: ${rule.id}`);
    }
    ruleIds.add(rule.id);

    const actionType = rule.action?.type;
    if (!actionType) {
      errors.push(`${resource.id} 규칙 ${rule.id}에 action.type이 없습니다.`);
    } else {
      actionCounts.set(actionType, (actionCounts.get(actionType) ?? 0) + 1);
    }
  }
}

const easyListMetadataPath = path.join(
  rootDirectory,
  "rules",
  "easylist.metadata.json",
);
const easyListNoticePath = path.join(
  rootDirectory,
  "rules",
  "EASYLIST_NOTICE.md",
);
const cosmeticGenericPath = path.join(
  rootDirectory,
  "rules",
  "cosmetic-generic.css",
);
const cosmeticSpecificPath = path.join(
  rootDirectory,
  "rules",
  "cosmetic-specific.json",
);

if (!fs.existsSync(easyListMetadataPath)) {
  errors.push("EasyList 메타데이터가 없습니다.");
} else if (easyListRules) {
  const metadata = readJson(path.join("rules", "easylist.metadata.json"));
  const actualHash = crypto
    .createHash("sha256")
    .update(easyListText)
    .digest("hex");

  if (metadata.output?.ruleCount !== easyListRules.length) {
    errors.push("EasyList 메타데이터의 규칙 수가 실제 파일과 다릅니다.");
  }
  if (metadata.output?.sha256 !== actualHash) {
    errors.push("EasyList 메타데이터의 SHA-256이 실제 파일과 다릅니다.");
  }

  if (metadata.filter?.title !== "KoreanList+EasyList") {
    errors.push("기본 필터는 KoreanList+EasyList여야 합니다.");
  }

  if (
    !fs.existsSync(cosmeticGenericPath) ||
    !fs.existsSync(cosmeticSpecificPath)
  ) {
    errors.push("생성된 cosmetic 필터 파일이 없습니다.");
  } else {
    const genericCssText = fs.readFileSync(cosmeticGenericPath, "utf8");
    const specificRulesText = fs.readFileSync(cosmeticSpecificPath, "utf8");
    const cosmeticMetadata = metadata.output?.cosmetic;
    let specificRules;
    try {
      specificRules = JSON.parse(specificRulesText);
    } catch (error) {
      errors.push(`cosmetic-specific.json을 읽지 못했습니다: ${error.message}`);
    }

    if (
      cosmeticMetadata?.genericCssSha256 !==
      crypto.createHash("sha256").update(genericCssText).digest("hex")
    ) {
      errors.push("범용 cosmetic CSS 해시가 메타데이터와 다릅니다.");
    }
    if (
      cosmeticMetadata?.specificRulesSha256 !==
      crypto.createHash("sha256").update(specificRulesText).digest("hex")
    ) {
      errors.push("도메인별 cosmetic 규칙 해시가 메타데이터와 다릅니다.");
    }
    if (
      specificRules &&
      (specificRules.schemaVersion !== 2 ||
        !Array.isArray(specificRules.conditionalGeneric) ||
        typeof specificRules.include !== "object" ||
        typeof specificRules.exception !== "object" ||
        !Array.isArray(specificRules.genericHideDisabledDomains) ||
        !Array.isArray(specificRules.elementHideDisabledDomains))
    ) {
      errors.push("도메인별 cosmetic 규칙 스키마가 올바르지 않습니다.");
    }
    if (
      specificRules &&
      specificRules.conditionalGeneric.length !==
        cosmeticMetadata?.conditionalGenericSelectorCount
    ) {
      errors.push("조건부 범용 cosmetic 규칙 수가 메타데이터와 다릅니다.");
    }
    if (
      !genericCssText.includes(
        "html.lae-active.lae-generic-active .adpost {",
      )
    ) {
      errors.push("KoreanList 범용 .adpost 선택자가 누락됐습니다.");
    }
    const generatedGenericRules = genericCssText
      .split(/\r?\n/)
      .filter((line) => line.includes("{ display: none !important; }"));
    if (
      generatedGenericRules.length !== cosmeticMetadata?.genericSelectorCount
    ) {
      errors.push("정적 범용 cosmetic 규칙 수가 메타데이터와 다릅니다.");
    }
    if (
      generatedGenericRules.some(
        (line) => !line.startsWith("html.lae-active.lae-generic-active"),
      )
    ) {
      errors.push("활성 클래스 밖에 있는 범용 cosmetic 규칙이 있습니다.");
    }
  }

  const unsafeActions = easyListRules.filter(
    (rule) => !["allow", "allowAllRequests", "block"].includes(rule.action?.type),
  );
  if (unsafeActions.length) {
    errors.push(`EasyList에 제외 대상 동작이 ${unsafeActions.length}개 있습니다.`);
  }
}

if (!fs.existsSync(easyListNoticePath)) {
  errors.push("EasyList 출처와 라이선스 고지가 없습니다.");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `검증 완료: Manifest V${manifest.manifest_version}, ruleset ${ruleResources.length}개, 규칙 ${totalRuleCount.toLocaleString("en-US")}개`,
  );
  console.log(`동작 분포: ${JSON.stringify(Object.fromEntries(actionCounts))}`);
}
