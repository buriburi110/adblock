import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");
const sourceDirectoryArgument = process.argv[2];

if (!sourceDirectoryArgument || sourceDirectoryArgument.startsWith("--")) {
  throw new Error(
    "사용법: node scripts/import-ubol-youtube.mjs <압축을 푼 uBOL Chromium 릴리스 폴더> [--archive-sha256=<해시>]",
  );
}

const sourceDirectory = path.resolve(sourceDirectoryArgument);
const archiveHashArgument = process.argv.find((argument) =>
  argument.startsWith("--archive-sha256="),
);
const archiveSha256 = archiveHashArgument
  ? archiveHashArgument.slice("--archive-sha256=".length).toLowerCase()
  : null;

function readJson(absolutePath) {
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function sha256(absolutePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(absolutePath))
    .digest("hex");
}

function assertFileContains(absolutePath, markers) {
  const source = fs.readFileSync(absolutePath, "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(`${absolutePath}에 필요한 표식이 없습니다: ${marker}`);
    }
  }
}

const upstreamManifestPath = path.join(sourceDirectory, "manifest.json");
const upstreamLicensePath = path.join(sourceDirectory, "LICENSE.txt");
const upstreamMainPath = path.join(
  sourceDirectory,
  "rulesets",
  "scripting",
  "scriptlet",
  "main",
  "ublock-filters.js",
);
const upstreamIsolatedPath = path.join(
  sourceDirectory,
  "rulesets",
  "scripting",
  "scriptlet",
  "isolated",
  "ublock-filters.js",
);

for (const absolutePath of [
  upstreamManifestPath,
  upstreamLicensePath,
  upstreamMainPath,
  upstreamIsolatedPath,
]) {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`uBOL 릴리스 파일이 없습니다: ${absolutePath}`);
  }
}

const upstreamManifest = readJson(upstreamManifestPath);
const release = String(upstreamManifest.version ?? "");
if (!/^\d{4}\.\d+\.\d+$/.test(release)) {
  throw new Error(`알 수 없는 uBOL 릴리스 버전입니다: ${release || "없음"}`);
}
if (
  upstreamManifest.short_name !== "uBO Lite" ||
  !upstreamManifest.declarative_net_request?.rule_resources?.some(
    (ruleset) => ruleset.id === "ublock-filters",
  )
) {
  throw new Error("uBlock Origin Lite Chromium 릴리스가 아닙니다.");
}
if (Number.parseInt(upstreamManifest.minimum_chrome_version, 10) < 122) {
  throw new Error("예상보다 오래된 uBOL Chromium 빌드입니다.");
}
if (archiveSha256 && !/^[0-9a-f]{64}$/.test(archiveSha256)) {
  throw new Error("--archive-sha256 값은 64자리 SHA-256이어야 합니다.");
}

assertFileContains(upstreamMainPath, [
  "uBlock Origin Lite",
  "// ruleset: ublock-filters",
  "trustedJsonEditXhrRequest",
  "trustedPreventDomBypass",
  '"www.youtube.com"',
]);
assertFileContains(upstreamIsolatedPath, [
  "uBlock Origin Lite",
  "// ruleset: ublock-filters",
  "(function serverContract()",
  "onAbnormalityDetected",
  '"www.youtube.com"',
]);

const vendorDirectory = path.join(rootDirectory, "vendor", "ublock-origin-lite");
fs.mkdirSync(vendorDirectory, { recursive: true });

const outputs = [
  {
    source: upstreamMainPath,
    target: path.join(vendorDirectory, "ublock-filters-main.js"),
    upstreamPath:
      "rulesets/scripting/scriptlet/main/ublock-filters.js",
  },
  {
    source: upstreamIsolatedPath,
    target: path.join(vendorDirectory, "ublock-filters-isolated.js"),
    upstreamPath:
      "rulesets/scripting/scriptlet/isolated/ublock-filters.js",
  },
];

for (const output of outputs) {
  fs.copyFileSync(output.source, output.target);
}
fs.copyFileSync(upstreamLicensePath, path.join(rootDirectory, "LICENSE.txt"));

const metadata = {
  schemaVersion: 1,
  project: "uBlock Origin Lite",
  release,
  releaseUrl: `https://github.com/uBlockOrigin/uBOL-home/releases/tag/${release}`,
  sourceRepository: "https://github.com/gorhill/uBlock",
  filterRepository: "https://github.com/uBlockOrigin/uAssets",
  license: "GPL-3.0-or-later",
  sourceArchiveSha256: archiveSha256,
  files: outputs.map((output) => ({
    path: path.relative(rootDirectory, output.target).replaceAll("\\", "/"),
    upstreamPath: output.upstreamPath,
    sha256: sha256(output.target),
  })),
};

fs.writeFileSync(
  path.join(vendorDirectory, "metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
  "utf8",
);

const notice = `# uBlock Origin Lite vendor notice

이 디렉터리의 \`ublock-filters-main.js\`와
\`ublock-filters-isolated.js\`는 uBlock Origin Lite Chromium
[${release} 릴리스](${metadata.releaseUrl})에서 수정 없이 가져온 생성물입니다.
현재 확장은 이 두 파일을 YouTube 호스트에서만 \`document_start\`에 실행합니다.

- 원본 엔진: <${metadata.sourceRepository}>
- 필터 원본: <${metadata.filterRepository}>
- 라이선스: GPL-3.0-or-later (프로젝트 루트 \`LICENSE.txt\`)
- 파일별 SHA-256 및 원본 경로: \`metadata.json\`

브라우저 실행 중에는 원격 JavaScript나 원격 scriptlet 목록을 내려받아 실행하지
않습니다. 업데이트는 검토한 공식 Chromium 릴리스를 압축 해제한 뒤
\`node scripts/import-ubol-youtube.mjs <폴더>\`를 명시적으로 실행해야 합니다.
`;

fs.writeFileSync(path.join(vendorDirectory, "NOTICE.md"), notice, "utf8");

console.log(`uBlock Origin Lite ${release} scriptlet 번들을 가져왔습니다.`);
for (const file of metadata.files) {
  console.log(`${file.sha256}  ${file.path}`);
}
