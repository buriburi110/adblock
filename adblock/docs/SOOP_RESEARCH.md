# SOOP VOD 광고 대응 — v1.8

확인일: 2026-10-03. 대상: <https://vod.sooplive.com/player/206062537>.
사용자 Chrome 프로필·로그인 쿠키를 읽거나 변경하지 않고 새 임시 프로필로 검사했다.
영상 파일을 따로 저장하지 않았다. 진단 로그에는 광고 API의 쿼리 값이나 본영상의
서명된 주소를 남기지 않는다.

## 확인한 광고 흐름

SOOP는 본영상과 광고를 별도 video 요소(`#video`, `#adVideo`)로 재생한다.
이 페이지의 공개 코드와 네트워크에서 다음을 확인했다.

1. `live.sooplive.com/api/get_ad.php?type=vod`가 광고 설정을 반환한다.
   서버 이름이 `live`여도 VOD에서 사용된다. 확인한 응답의 `prerollUrl`과
   `midrollUrl`은 모두 `https://reqde.sooplive.com/api/v1/recommend`였다.
2. 광고 설정 API가 실패하면 광고 요청 주소를 만드는 함수는 기본값인
   `deapi.sooplive.com/api/v1/recommend`를 사용할 수 있다. 설정 API만 차단하는
   것으로는 충분하지 않다.
3. 플레이어 코어는 광고 응답의 VAST 정보에서 광고 소재와 추적 정보를 읽는다.
   광고 요청이 Network Error로 실패하면 `AD_BLOCK`·`AD_API_ERROR`를 보고한 뒤
   `closeAd()`를 호출한다. 이 함수가 `AD_ENDED` 이벤트를 보내는 경로를 확인했다.
   광고 응답이 `exist=false`인 경우도 `NO_AD` 뒤 같은 종료 경로로 간다.
4. 영상 정보 API `api.m.sooplive.com/station/video/a/view`의 `data.adballoon`은
   애드벌룬 배너·프로모션 설정이다. 프리롤/미드롤 동영상 주소나 재생 권한은 아니다.

근거가 된 사이트의 공개 자바스크립트:

- [광고 설정 API와 실패 시 상태](https://static.sooplive.com/asset/app/vodplayer/view/static/js/main.b9adf0b2.js)
- [기본 광고 서버로의 대체 요청](https://static.sooplive.com/asset/app/vodplayer/view/static/js/894.f13f43c3.chunk.js)
- [광고 응답 처리와 종료 이벤트](https://static.sooplive.com/asset/app/vodplayer/core/vodplayer-core-3.1.38.min.js)
- [애드벌룬 배너 렌더링](https://static.sooplive.com/asset/app/vodplayer/view/static/js/999.e7732e25.chunk.js)

이 코드는 사이트가 공개 배포한 특정 빌드에 대한 관찰이며, SOOP의 영구적인 API
계약이나 향후 동작 보장이 아니다. 사이트 코드를 확장에 복제하지 않았다.

## 오픈소스 활용 범위

List-KR 커밋 `9c2eab0a382be0d9c8716fcc363ba32b3ff36e62`의 SOOP 네트워크 필터
9개와 애드벌룬 scriptlet 규칙 1개를 선택했다. 원본 줄·라이선스·해시는
[SOOP_NOTICE.md](../rules/SOOP_NOTICE.md)와 [메타데이터](../rules/soop.metadata.json)에 있다.

네트워크 규칙은 Chrome DNR로 변환하되 SOOP가 시작한 요청에만 적용하고
최상위 페이지 이동은 제외했다. VOD 응답 처리는 독립 구현이며 정확한 API의
`data.adballoon`만 제거한다. XHR text/JSON와 fetch를 지원하고 나머지 영상 정보,
구독 여부, 접근권한, 프리롤/미드롤 편성 플래그 및 시점은 그대로 둔다.

SOOP 전용 콘텐츠 스크립트는 `document_start`에 MAIN world로 등록한다.
전역/사이트 OFF는 등록 해제·제외 목록과 기존 `content.js`의 상태 전달을 함께
사용한다. 이미 열린 다른 탭의 후속 요청도 OFF를 따른다. 이미 소비된 응답은
복구하지 않으므로 설정 변경 뒤 새로고침이 가장 확실하다.

## 재현 시 주의점

이 영상은 최초 진입 때 재생을 시작하지 않고 `VOD 보기` 화면을 보여주었다.
따라서 두 video 요소의 `src`가 비어 있는 초기 상태만 보고 실패로 판단하면 안 된다.
실제 보이는 `VOD 보기`를 클릭한 뒤 재생 상태를 확인했다.

확장 없는 설치 Chrome의 깨끗한 프로필에서는 클릭 후 `#adVideo`에서 약 30초 광고가
재생되었고, 7.64초에서 12.65초로 재생 시간이 증가했다. `reqde` 추천 응답과 별도
광고 MP4의 HTTP 206 응답을 관찰했다. 이 기록은 해당 실행에서 광고가 송출됐다는
증거이며, 모든 실행에 광고가 나온다는 의미는 아니다.

처음 로그에서 보인 `https://vod.sooplive.comhttps://vod.sooplive.com/...`는 요청 실패가
아니라 `blob:` URL의 `origin`과 `pathname`을 잘못 합친 표시 오류였다. 진단 도구에서
blob 주소를 별도로 처리한다. H.264/AAC/VP9 지원 여부도 확인했다.

## 자동 검사

- `node scripts/validate.mjs`: Manifest, 기존 필터 해시, SOOP 원문→DNR 변환,
  SOOP 적용 범위 및 출처 메타데이터 검사.
- `node scripts/smoke-tests.mjs`: 기존 기능과 SOOP 등록·설정·배지 카운트,
  EasyList 실패 시 보조 규칙 유지 검사.
- `node scripts/chrome-load-check.mjs`: 실제 Chromium 확장 로드와 기존 YouTube
  MAIN/ISOLATED scriptlet 회귀 검사.
- `node scripts/soop-tests.mjs --chrome`: 15개 그룹 통과. XHR/fetch의 정확한 필드
  삭제·응답 보존·캐시·중복 설치·실패 경로, 광고 규칙 9개와 본영상 요청의 구분,
  전체/사이트 OFF·재활성화·기본 목록 fallback, 새로고침 없는 기존 탭 설정 반영을
  검증한다. 이 검사는 SOOP 서버에 접속하지 않는 가짜 응답 검사이다.

## 실제 페이지 A/B 결과

동일한 자동화용 Chromium 배포 revision 1228에서 새 임시 프로필을 각각 사용했다.
확장 ON에서는 실제 로드된 버전 `1.8.0`, `easylist`+`soop` 규칙,
`soop-vod-main-world` 등록을 먼저 확인했다. 네트워크 응답을 가로채거나 가짜
영상 정보를 주입하지 않고 링크의 실제 페이지를 재생했다.

| 조건 | 광고 관측 | 본영상 재생 시간 | 광고 API |
| --- | --- | --- | --- |
| 확장 미설치 | 30.03초 광고 | 광고 후 2.35 → 5.36초 | get_ad·reqde·deapi HTTP 200 |
| v1.8 ON | 상업 광고 재생 관측 없음 | 4.47 → 7.49초 | get_ad·deapi ERR_BLOCKED_BY_CLIENT |
| v1.8 ON 후 새로고침 | 상업 광고 재생 관측 없음 | 4.78 → 7.79초 | get_ad·deapi 다시 차단 |

세 경우 본영상의 `readyState=4`, `paused=false`, 미디어 오류 코드 `0`을 확인했다.
ON에서는 설정 API가 차단되어 `deapi` 대체 요청을 사용했으므로 `reqde` 요청 자체는
발생하지 않았다. `reqde` 차단 규칙은 실제 Chromium DNR 매칭 검사로 확인했다.
광고 요소에는 약 0.128초의 짧은 자료가 정지 상태로 남았다. 따라서 `adVideo.src`
존재만으로 광고 재생 여부를 판단하지 않고 재생 시간·정지 상태를 함께 확인했다.

확장 ON에서는 사이트 `ui-navigation` 코드가 광고 요청 실패 관련
`soop-navigation-error: AxiosError: Network Error`를 탐색당 2건 기록했다.
실제 본영상 진행에는 영향이 없었지만 **페이지 오류 로그가 전혀 없었다는 뜻은 아니다**.
이 사이트 오류를 숨기거나 성공 응답으로 위조하지 않았다. 미설치 실행은 pageerror 0이었다.

재현 명령 (Playwright와 자동화용 Chromium 필요):

```powershell
node scripts/soop-live-check.mjs
node scripts/soop-live-check.mjs --extension --reload
```

필요하면 `CHROME_PATH`에 자동화용 Chromium 실행 파일 경로를 지정한다.
일반 설치 Chrome은 확장 사이드로드 옵션을 제한할 수 있으므로 확장 ON 검사는
Playwright용 Chromium에서 실행한다. `--headed`는 창을 화면 밖에서 실행하는
추가 진단 옵션이다. 실재생 검사는 외부 네트워크를 사용하며 광고 캠페인·지역·
사이트 상태에 따라 결과가 달라진다. 로그인이나 CAPTCHA가 필요하면 이를 우회하지
말고 검증 불가로 기록한다.

로그인 사용자, 모든 VOD,
모든 지역과 광고 캠페인, 긴 영상의 전체 미드롤 편성, 라이브 및 모바일 앱은
이 검증 범위에 포함하지 않는다. YouTube 광고 문제가 이번 SOOP 변경으로 해결됐다고
주장하지 않는다.
