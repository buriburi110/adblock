# uBlock Origin Lite vendor notice

이 디렉터리의 `ublock-filters-main.js`와
`ublock-filters-isolated.js`는 uBlock Origin Lite Chromium
[2026.729.1529 릴리스](https://github.com/uBlockOrigin/uBOL-home/releases/tag/2026.729.1529)에서 수정 없이 가져온 생성물입니다.
현재 확장은 이 두 파일을 YouTube 호스트에서만 `document_start`에 실행합니다.

- 원본 엔진: <https://github.com/gorhill/uBlock>
- 필터 원본: <https://github.com/uBlockOrigin/uAssets>
- 라이선스: GPL-3.0-or-later (프로젝트 루트 `LICENSE.txt`)
- 파일별 SHA-256 및 원본 경로: `metadata.json`

브라우저 실행 중에는 원격 JavaScript나 원격 scriptlet 목록을 내려받아 실행하지
않습니다. 업데이트는 검토한 공식 Chromium 릴리스를 압축 해제한 뒤
`node scripts/import-ubol-youtube.mjs <폴더>`를 명시적으로 실행해야 합니다.
