# 사이트 광고 보완 — v1.8.1

확인일: 2026-10-03. 범위: 사용자가 지정한 `sexkbj.tv` 페이지의 광고 기술.
영상·이미지는 수집하거나 표시하지 않았고, 광고 링크를 클릭하지 않았다.
로그인·구독·구매·접근권한과 본영상 API에는 변경을 가하지 않았다.

## 확인된 구조

현재 사이트는 React 기반 화면이며 예전 `.com` 사이트의 KVS 플레이어와 달랐다.
공개 HTML 및 현재 자바스크립트에서 다음 두 광고 계층을 확인했다.

- 제휴 배너: `LinkAd` 컴포넌트가 `rel="sponsored noopener"`와
  `href="https://t.vlmai-5.com/..."`인 링크를 렌더링한다. 광고 이미지나 iframe이
  아니라 일반 링크이므로 광고 서버 요청만 차단해도 화면에 남을 수 있다.
- 플레이어 광고: `go.whitetrafsa.com/api/models/vast`를 fetch하고 VAST XML을
  해석한다. 네트워크/파싱 실패 시 null을 반환하고 광고 대기 플래그를 해제하는
  분기가 있다. 이 코드 관찰은 본영상 실재생 검증과 구분한다.

검사한 공개 소스:

- [LinkAd 렌더링](https://sexkbj.tv/assets/LinkAd-Y-I1KXVo.js)
- [플레이어 광고 요청·실패 처리](https://sexkbj.tv/assets/_slug-C1NRbwQ3.js)
- [광고 링크 설정과 앱 코드](https://sexkbj.tv/assets/index-JzhX0EOy.js)

번들 이름은 해당 시점의 빌드이며 이후 바뀔 수 있다. 사이트 소스 전체를 복제하거나
원격 코드를 확장에 추가하지 않았다.

## 기존 필터와 변경

기존 `rules/easylist.json`에는 이미 `||whitetrafsa.com^` 차단 규칙
(ID 415630, priority 1000)이 있다. 따라서 이 변경을 새로운 기본 영상광고 차단
기능으로 과장해서는 안 된다. 현재 공식
[EasyList 규칙](https://github.com/easylist/easylist/blob/d546f5440a9380d70b523440e22c338adbcdee0f/easylist/easylist_adservers.txt#L39580)에서도
같은 도메인을 확인했다. 기존 EasyList snapshot·해시·라이선스 고지는 변경하지 않았다.

추가한 부분:

1. `sites/sexkbj.css`: 이 사이트에서 확인한 광고 링크만 숨긴다.
   `html.lae-active.lae-specific-active`로 전체/사이트 OFF 및 element-hide 예외를
   존중한다. 일반 링크, 다른 호스트의 sponsored 링크, 영상 조작부는 대상이 아니다.
   CSS이므로 새로 추가된 광고 링크와 페이지 내부 이동에도 적용된다.
2. `rules/ads.json` ID 2: 기본 필터를 사용할 수 없을 때에도 동일 VAST 요청을
   차단한다. `sexkbj.tv`가 시작한 XHR/fetch와 확인된 광고 API 경로에만 적용한다.
   일반 페이지 이동, 본영상 CDN, 로그인·구매 API를 차단하지 않는다.
3. Manifest에 정확한 HTTPS 사이트의 CSS를 추가하고 버전을 1.8.1로 올렸다.
   새 호스트 권한, MAIN-world 훅, 팝업 강제 차단은 추가하지 않았다.

CSS와 제한된 대체 규칙은 관찰된 광고 링크 속성·공개 API를 근거로 작성한 독립
구현이다. 사이트의 소스 코드를 복제하지 않았다. 비교한 EasyList의 출처는
The EasyList authors이며 [공식 라이선스](https://easylist.to/pages/licence.html)는
GPLv3-or-later 또는 CC-BY-SA-3.0-or-later이다. 기존 snapshot의 선택 라이선스 및
고지는 [EASYLIST_NOTICE.md](../rules/EASYLIST_NOTICE.md)를 따른다.

공개 광고 차단 목록에 있던 예전 `adbd`, `cRAds`, `popMagic`, `.happy-sidebar`
대응은 현재 `.tv` 코드·DOM에서 확인되지 않아 이 변경에 사용하지 않았다.
모든 `window.open`이나 새 탭 링크를 막는 식의 광범위한 변경도 하지 않았다.

## 실제 페이지에서 확인한 범위

사용자 프로필과 별개의 임시 Chromium 프로필에 확장을 로드했다. 진단 중 이미지,
폰트, 미디어 스트림과 광고 소재 응답은 차단하여 콘텐츠를 수집하지 않았다.
따라서 이 실행은 **화면 광고 숨김 검사이며 영상광고 재생 성공/실패 시험이 아니다**.

확인한 타깃 광고 링크는 1개였다.

| 상태 | 표시되는 타깃 광고 링크 |
| --- | ---: |
| 차단 ON | 0 |
| 같은 문서에서 사이트 OFF | 1 |
| 같은 문서에서 다시 ON | 0 |
| 새로고침 후 ON | 0 |

검사 중 페이지 자바스크립트 예외는 없었다. 비로그인 검사에서 video 요소는
생성되지 않았으며, 로그인·결제 조건을 우회하거나 본영상을 재생하지 않았다.
광고 API가 사이트 코드에 있다는 것과 실제 사용자에게 광고가 송출됐다는 것은
서로 다른 사실이다. 영상 시작/중간 광고 전체 차단, 사용자 계정의 재생 상태,
다른 도메인으로의 사이트 이동이나 아직 관찰하지 못한 팝업은 검증하지 않았다.

## 회귀 검사

```powershell
node scripts/validate.mjs
node scripts/smoke-tests.mjs
node scripts/sexkbj-tests.mjs --chrome
node scripts/soop-tests.mjs --chrome
node scripts/chrome-load-check.mjs
```

사이트 전용 테스트는 가짜 비성적 HTML에서 CSS 적용 범위·동적 추가·설정 토글과
기본/대체 필터의 DNR 매칭을 검사한다. 실제 사이트에 로그인하거나 미디어를
다운로드하지 않으며, 실재생 검증으로 간주하지 않는다.

사이트 전용 9개 그룹과 기존 SOOP 15개 그룹, 전체 정적 검증·설정 회귀 검사,
YouTube scriptlet의 실제 Chromium 로드 검사가 모두 통과했다.
