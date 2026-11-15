import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TARGET_EXTENSION_ID = "gighmmpiobklfepjocnamgkkbiglidom";
const TARGET_FILTER_TITLE = "KoreanList+EasyList";
const SAFE_ACTION_TYPES = new Set(["allow", "allowAllRequests", "block"]);
const UNSUPPORTED_SELECTOR_MARKERS = [
  ":-abp-",
  ":contains(",
  ":has-text(",
  ":matches-attr(",
  ":matches-css(",
  ":matches-media(",
  ":min-text-length(",
  ":others(",
  ":remove(",
  ":remove-attr(",
  ":remove-class(",
  ":style(",
  ":upward(",
  ":watch-attr(",
  ":xpath(",
  "[-abp-properties=",
  "::shadow",
  "/deep/",
];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function findInstalledExtension() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      "LOCALAPPDATA를 찾지 못했습니다. AdBlock 설치 폴더를 인수로 지정해 주세요.",
    );
  }

  const versionsDirectory = path.join(
    localAppData,
    "Google",
    "Chrome",
    "User Data",
    "Default",
    "Extensions",
    TARGET_EXTENSION_ID,
  );
  if (!fs.existsSync(versionsDirectory)) {
    throw new Error(`설치된 AdBlock을 찾지 못했습니다: ${versionsDirectory}`);
  }

  const candidates = fs
    .readdirSync(versionsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(versionsDirectory, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, "manifest.json")))
    .sort((left, right) =>
      path.basename(left).localeCompare(path.basename(right), undefined, {
        numeric: true,
      }),
    );

  if (!candidates.length) {
    throw new Error("AdBlock 버전 폴더에서 manifest.json을 찾지 못했습니다.");
  }
  return candidates.at(-1);
}

function readFilterHeaders(contents) {
  const headers = {};
  for (const line of contents.split(/\r?\n/).slice(0, 80)) {
    const match = /^!\s*([^:]+):\s*(.+)$/.exec(line);
    if (match) {
      headers[match[1].trim().toLowerCase()] = match[2].trim();
    }
  }
  return headers;
}

function countBy(values, keySelector) {
  const counts = {};
  for (const value of values) {
    const key = keySelector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort());
}

function normalizeFilterDomain(value) {
  const candidate = value.trim().toLowerCase();
  if (
    !candidate ||
    candidate.length > 253 ||
    /[*/:@\s]/.test(candidate)
  ) {
    return "";
  }

  try {
    return new URL(`https://${candidate}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function splitSelectorList(value) {
  const selectors = [];
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote = "";
  let escaped = false;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === "(") {
      parenthesisDepth += 1;
    } else if (character === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    } else if (
      character === "," &&
      bracketDepth === 0 &&
      parenthesisDepth === 0
    ) {
      selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  selectors.push(value.slice(start).trim());
  return selectors.filter(Boolean);
}

function hasNestedHasPseudo(selector) {
  const lowerSelector = selector.toLowerCase();
  const parenthesisStack = [];
  let quote = "";
  let escaped = false;

  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      const isHas = lowerSelector.slice(0, index).trimEnd().endsWith(":has");
      if (isHas && parenthesisStack.includes("has")) {
        return true;
      }
      parenthesisStack.push(isHas ? "has" : "other");
    } else if (character === ")") {
      parenthesisStack.pop();
    }
  }
  return false;
}

function isSupportedSelector(selector) {
  if (
    !selector ||
    selector.length > 4096 ||
    selector.startsWith("^") ||
    /[{}\u0000-\u001f]/.test(selector) ||
    hasNestedHasPseudo(selector)
  ) {
    return false;
  }

  const lowerSelector = selector.toLowerCase();
  return !UNSUPPORTED_SELECTOR_MARKERS.some((marker) =>
    lowerSelector.includes(marker),
  );
}

function parseElementHidingExceptions(contents) {
  const genericHideDisabledDomains = new Set();
  const elementHideDisabledDomains = new Set();
  let parsedFilterCount = 0;
  let skippedFilterCount = 0;

  function addDomains(target, rawDomains) {
    let added = 0;
    for (const rawDomain of rawDomains) {
      if (rawDomain.startsWith("~")) {
        continue;
      }
      const domain = normalizeFilterDomain(rawDomain);
      if (domain) {
        target.add(domain);
        added += 1;
      }
    }
    return added;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("@@") || !/\$(?:[^,]*,)*(?:generic|elem)hide(?:,|$)/.test(line)) {
      continue;
    }

    const optionIndex = line.lastIndexOf("$");
    const pattern = line.slice(0, optionIndex);
    const options = line.slice(optionIndex + 1).split(",");
    const disablesElementHiding = options.includes("elemhide");
    const disablesGenericHiding =
      disablesElementHiding || options.includes("generichide");
    const target = disablesElementHiding
      ? elementHideDisabledDomains
      : genericHideDisabledDomains;
    let added = 0;

    if (pattern === "@@") {
      const domainOption = options.find((option) => option.startsWith("domain="));
      if (domainOption) {
        added = addDomains(target, domainOption.slice(7).split("|"));
      }
    } else {
      const domainMatch = /^@@\|\|([A-Za-z0-9.-]+)\^$/.exec(pattern);
      if (domainMatch) {
        added = addDomains(target, [domainMatch[1]]);
      }
    }

    if (added) {
      parsedFilterCount += 1;
      if (disablesElementHiding && disablesGenericHiding) {
        // elemhide는 범용 규칙도 함께 끄므로 별도 generic 목록에 중복 저장하지 않습니다.
      }
    } else {
      // URL 경로나 와일드카드가 붙은 예외를 호스트 전체 예외로 넓히지 않습니다.
      skippedFilterCount += 1;
    }
  }

  return {
    elementHideDisabledDomains: [...elementHideDisabledDomains].sort(),
    genericHideDisabledDomains: [...genericHideDisabledDomains].sort(),
    parsedFilterCount,
    skippedFilterCount,
  };
}

function parseCosmeticFilters(contents) {
  const rules = [];
  let droppedFilterCount = 0;
  const uncertainExceptionSelectors = new Set();
  const skippedBySyntax = {
    extended: 0,
    invalidDomain: 0,
    unsupportedSelector: 0,
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) {
      continue;
    }

    if (line.includes("#?#") || line.includes("#$#") || line.includes("#%#")) {
      skippedBySyntax.extended += 1;
      continue;
    }

    const exceptionIndex = line.indexOf("#@#");
    const hidingIndex = exceptionIndex < 0 ? line.indexOf("##") : -1;
    const delimiterIndex = exceptionIndex >= 0 ? exceptionIndex : hidingIndex;
    if (delimiterIndex < 0) {
      continue;
    }

    const delimiterLength = exceptionIndex >= 0 ? 3 : 2;
    const domainText = line.slice(0, delimiterIndex).trim();
    const selectorCandidates = splitSelectorList(
      line.slice(delimiterIndex + delimiterLength).trim(),
    );
    const selectors = selectorCandidates.filter(isSupportedSelector);
    skippedBySyntax.unsupportedSelector +=
      selectorCandidates.length - selectors.length;
    if (!selectors.length) {
      droppedFilterCount += 1;
      continue;
    }

    const includeDomains = [];
    const excludeDomains = [];
    if (domainText) {
      for (const rawDomain of domainText.split(",")) {
        const excluded = rawDomain.startsWith("~");
        const normalized = normalizeFilterDomain(
          excluded ? rawDomain.slice(1) : rawDomain,
        );
        if (!normalized) {
          skippedBySyntax.invalidDomain += 1;
          continue;
        }
        (excluded ? excludeDomains : includeDomains).push(normalized);
      }
      if (!includeDomains.length) {
        // 전역 규칙+도메인 예외는 정적 CSS에서 안전하게 되돌릴 수 없으므로 보수적으로 생략합니다.
        if (exceptionIndex >= 0) {
          for (const selector of selectors) {
            uncertainExceptionSelectors.add(selector);
          }
        }
        droppedFilterCount += 1;
        continue;
      }
    }

    rules.push({
      exception: exceptionIndex >= 0,
      excludeDomains: [...new Set(excludeDomains)].sort(),
      includeDomains: [...new Set(includeDomains)].sort(),
      selectors,
    });
  }

  const globalExceptionSelectors = new Set(
    rules
      .filter((rule) => rule.exception && !rule.includeDomains.length)
      .flatMap((rule) => rule.selectors),
  );
  const domainExceptionSelectors = new Set(
    rules
      .filter((rule) => rule.exception && rule.includeDomains.length)
      .flatMap((rule) => rule.selectors),
  );
  const genericHideSelectors = new Set(
    rules
      .filter((rule) => !rule.exception && !rule.includeDomains.length)
      .flatMap((rule) => rule.selectors),
  );
  const genericSelectors = new Set();
  const conditionalGenericSelectors = new Set();
  const includeIndex = new Map();
  const exceptionIndex = new Map();

  function addDomainEntry(index, domain, selector, excludeDomains) {
    let entries = index.get(domain);
    if (!entries) {
      entries = new Map();
      index.set(domain, entries);
    }
    const key = `${selector}\u0000${excludeDomains.join(",")}`;
    entries.set(key, [selector, excludeDomains]);
  }

  for (const rule of rules) {
    if (!rule.includeDomains.length) {
      continue;
    }

    const targetIndex = rule.exception ? exceptionIndex : includeIndex;
    for (const domain of rule.includeDomains) {
      for (const selector of rule.selectors) {
        addDomainEntry(
          targetIndex,
          domain,
          selector,
          rule.excludeDomains,
        );
      }
    }
  }

  for (const selector of genericHideSelectors) {
    if (
      globalExceptionSelectors.has(selector) ||
      uncertainExceptionSelectors.has(selector)
    ) {
      continue;
    }
    if (domainExceptionSelectors.has(selector)) {
      conditionalGenericSelectors.add(selector);
    } else {
      genericSelectors.add(selector);
    }
  }

  function serializeIndex(index) {
    return Object.fromEntries(
      [...index.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([domain, entries]) => [
          domain,
          [...entries.values()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ]),
    );
  }

  return {
    conditionalGenericSelectors: [...conditionalGenericSelectors].sort(),
    droppedFilterCount,
    exceptionIndex: serializeIndex(exceptionIndex),
    genericSelectors: [...genericSelectors].sort(),
    exceptionSensitiveSelectorCount:
      domainExceptionSelectors.size + globalExceptionSelectors.size,
    includeIndex: serializeIndex(includeIndex),
    parsedFilterCount: rules.length,
    skippedBySyntax,
    uncertainExceptionSelectorCount: uncertainExceptionSelectors.size,
  };
}

function scopeSelector(selector) {
  if (/^:root(?=$|[\s.#:[>+~])/i.test(selector)) {
    return `html.lae-active.lae-generic-active${selector.slice(5)}`;
  }
  if (/^html(?=$|[\s.#:[>+~])/i.test(selector)) {
    return `html.lae-active.lae-generic-active${selector.slice(4)}`;
  }
  return `html.lae-active.lae-generic-active ${selector}`;
}

function buildGenericCss(selectors, filter, headers) {
  const header = [
    "/* Generated from the installed public filter subscription.",
    ` * Filter: ${filter.title}`,
    ` * Version: ${headers.version ?? "unknown"}`,
    ` * License: ${headers.licence ?? "https://easylist.to/pages/licence.html"}`,
    " * Regenerate with scripts/import-installed-easylist.mjs.",
    " */",
  ].join("\n");
  const rules = selectors.map(
    (selector) => `${scopeSelector(selector)} { display: none !important; }`,
  );
  return `${header}\n${rules.join("\n")}\n`;
}

function countIndexEntries(index) {
  return Object.values(index).reduce((total, entries) => total + entries.length, 0);
}

const extensionDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : findInstalledExtension();
const manifest = readJson(path.join(extensionDirectory, "manifest.json"));
const subscriptions = readJson(
  path.join(extensionDirectory, "data", "rules", "index.json"),
);
const filter = subscriptions.find(
  (subscription) =>
    subscription.title === TARGET_FILTER_TITLE && subscription.type === "ads",
);
if (!filter) {
  throw new Error(
    `설치된 AdBlock 패키지에서 ${TARGET_FILTER_TITLE} 메타데이터를 찾지 못했습니다.`,
  );
}

const dnrPath = path.join(
  extensionDirectory,
  "data",
  "rules",
  "dnr",
  filter.id,
);
const abpPath = path.join(
  extensionDirectory,
  "data",
  "rules",
  "abp",
  filter.id,
);
const sourceDnrText = fs.readFileSync(dnrPath, "utf8");
const sourceRules = JSON.parse(sourceDnrText);
const sourceFilterText = fs.readFileSync(abpPath, "utf8");
const filterHeaders = readFilterHeaders(sourceFilterText);

if (!Array.isArray(sourceRules) || sourceRules.length !== filter.rule_count) {
  throw new Error(
    `${filter.title} 규칙 수가 메타데이터와 다릅니다: ${sourceRules.length} / ${filter.rule_count}`,
  );
}

const seenRuleIds = new Set();
for (const rule of sourceRules) {
  if (!Number.isInteger(rule.id) || rule.id <= 0) {
    throw new Error(`잘못된 DNR 규칙 ID: ${rule.id}`);
  }
  if (seenRuleIds.has(rule.id)) {
    throw new Error(`중복 DNR 규칙 ID: ${rule.id}`);
  }
  seenRuleIds.add(rule.id);
}

const retainedRules = sourceRules.filter((rule) =>
  SAFE_ACTION_TYPES.has(rule.action?.type),
);
const droppedRules = sourceRules.filter(
  (rule) => !SAFE_ACTION_TYPES.has(rule.action?.type),
);
const cosmetic = parseCosmeticFilters(sourceFilterText);
const elementHidingExceptions = parseElementHidingExceptions(sourceFilterText);
const outputText = `${JSON.stringify(retainedRules)}\n`;
const genericCssText = buildGenericCss(
  cosmetic.genericSelectors,
  filter,
  filterHeaders,
);
const specificRules = {
  schemaVersion: 2,
  filter: {
    id: filter.id,
    title: filter.title,
    version: filterHeaders.version ?? null,
  },
  conditionalGeneric: cosmetic.conditionalGenericSelectors,
  include: cosmetic.includeIndex,
  exception: cosmetic.exceptionIndex,
  genericHideDisabledDomains:
    elementHidingExceptions.genericHideDisabledDomains,
  elementHideDisabledDomains:
    elementHidingExceptions.elementHideDisabledDomains,
};
const specificRulesText = `${JSON.stringify(specificRules)}\n`;
const outputPath = path.join(rootDirectory, "rules", "easylist.json");
const genericCssPath = path.join(rootDirectory, "rules", "cosmetic-generic.css");
const specificRulesPath = path.join(
  rootDirectory,
  "rules",
  "cosmetic-specific.json",
);
const metadataPath = path.join(rootDirectory, "rules", "easylist.metadata.json");
const metadata = {
  schemaVersion: 2,
  importedAt: new Date().toISOString(),
  sourceExtension: {
    id: TARGET_EXTENSION_ID,
    version: manifest.version,
  },
  filter: {
    id: filter.id,
    title: filter.title,
    version: filterHeaders.version ?? null,
    lastModified: filterHeaders["last modified"] ?? null,
    homepage: filter.homepage,
    license: filterHeaders.licence ?? "https://easylist.to/pages/licence.html",
    url: filter.url,
  },
  source: {
    ruleCount: sourceRules.length,
    actionCounts: countBy(sourceRules, (rule) => rule.action?.type ?? "unknown"),
    dnrSha256: sha256(sourceDnrText),
    filterLineCount: sourceFilterText.split(/\r?\n/).length,
    filterSha256: sha256(sourceFilterText),
  },
  output: {
    ruleCount: retainedRules.length,
    actionCounts: countBy(retainedRules, (rule) => rule.action.type),
    droppedActionCounts: countBy(
      droppedRules,
      (rule) => rule.action?.type ?? "unknown",
    ),
    sha256: sha256(outputText),
    cosmetic: {
      parsedFilterCount: cosmetic.parsedFilterCount,
      droppedFilterCount: cosmetic.droppedFilterCount,
      skippedBySyntax: cosmetic.skippedBySyntax,
      exceptionSensitiveSelectorCount:
        cosmetic.exceptionSensitiveSelectorCount,
      uncertainExceptionSelectorCount:
        cosmetic.uncertainExceptionSelectorCount,
      genericSelectorCount: cosmetic.genericSelectors.length,
      conditionalGenericSelectorCount:
        cosmetic.conditionalGenericSelectors.length,
      specificSelectorCount: countIndexEntries(cosmetic.includeIndex),
      exceptionSelectorCount: countIndexEntries(cosmetic.exceptionIndex),
      elementHidingExceptions: {
        parsedFilterCount: elementHidingExceptions.parsedFilterCount,
        skippedFilterCount: elementHidingExceptions.skippedFilterCount,
        genericHideDisabledDomainCount:
          elementHidingExceptions.genericHideDisabledDomains.length,
        elementHideDisabledDomainCount:
          elementHidingExceptions.elementHideDisabledDomains.length,
      },
      genericCssSha256: sha256(genericCssText),
      specificRulesSha256: sha256(specificRulesText),
    },
  },
  notes: [
    "원본 AdBlock 코드와 브랜드 자산은 복사하지 않습니다.",
    "redirect와 modifyHeaders DNR 규칙은 안전한 독립 구현을 위해 제외합니다.",
    "표준 CSS로 표현 가능한 기본 element-hiding 규칙만 가져오며 procedural/scriptlet 규칙은 제외합니다.",
    "예외가 선언된 범용 선택자는 현재 문서의 도메인 예외를 계산한 뒤에만 적용합니다.",
    "$generichide와 $elemhide의 호스트 단위 예외를 적용하며 경로·와일드카드 예외는 범위를 넓히지 않고 생략합니다.",
    "생성 데이터의 출처와 라이선스는 rules/EASYLIST_NOTICE.md를 확인하세요.",
  ],
};

fs.writeFileSync(outputPath, outputText, "utf8");
fs.writeFileSync(genericCssPath, genericCssText, "utf8");
fs.writeFileSync(specificRulesPath, specificRulesText, "utf8");
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

console.log(`${filter.title} ${filterHeaders.version ?? "버전 미상"}`);
console.log(`네트워크 규칙: ${retainedRules.length.toLocaleString("en-US")}개`);
console.log(
  `cosmetic 선택자: 정적 범용 ${cosmetic.genericSelectors.length.toLocaleString("en-US")}개, 조건부 범용 ${cosmetic.conditionalGenericSelectors.length.toLocaleString("en-US")}개, 도메인별 ${metadata.output.cosmetic.specificSelectorCount.toLocaleString("en-US")}개`,
);
console.log(
  `제외한 DNR 동작: ${JSON.stringify(metadata.output.droppedActionCounts)}`,
);
