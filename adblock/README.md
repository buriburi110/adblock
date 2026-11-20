# 가벼운 광고 차단기

Chrome Manifest V3의 공식 `declarativeNetRequest` API와 로컬 콘텐츠 스크립트를 사용하는 작은 광고 차단 확장 프로그램입니다. 외부 서버나 빌드 도구 없이 로컬에서 바로 실행할 수 있습니다.

Chrome 122 이상을 지원합니다.

## 지금 들어 있는 기능

- KoreanList+EasyList 기반 네트워크 규칙 56,058개로 국내외 광고 요청 차단
- 예외와 무관한 범용 cosmetic 선택자 13,360개를 정적 CSS로 적용
- 조건부 범용 선택자 301개와 도메인별 선택자 참조 16,701개를 현재 호스트의 예외 658개 및 `$generichide` 호스트 182개와 대조한 뒤 동적으로 적용
- 광고 슬롯 안에서 재생되는 영상·오디오를 멈추고, 광고용 전면 대화상자를 닫아 본문 입력을 복구합니다. 일반 숨김 필터가 꺼진 사이트에서는 이 처리가 중지됩니다.
- 카카오 AdFit 스크립트와 FM코리아의 NHN·자체 광고 프레임을 기본 목록과 소형 대체 목록에서 모두 차단합니다.
- FM코리아처럼 공개 목록만으로 남는 광고 영역은 검증된 사이트 전용 CSS로 보완
- 공식 uBlock Origin Lite 2026.729.1529의 GPL scriptlet 번들을 YouTube에 한정해 사용
- MAIN world에서 player fetch/XHR의 광고 필드와 요청 문맥(`clientScreen`, `lactMilliseconds`, 재시도 표식)을 함께 처리
- ISOLATED world에서 현재 YouTube `serverContract`, 3037019 재생 제한, `onAbnormalityDetected`, `onSnackbarMessage` 대응을 적용
- 인피드·Shorts·플레이어 오버레이 광고 숨김
- 치지직 공개 라이브의 기존 HTTPS 영상 주소로 고화질 재생을 연결하고, 확인된 플레이어 광고 설정을 처리
- SOOP에서 List-KR 기반 보조 규칙 9개로 광고 설정·추천·소재 요청을 차단하고, VOD 응답의 애드벌룬 배너 설정만 제거
- sexkbj.tv에서 확인한 제휴 광고 배너를 사이트 전용 CSS로 숨기고, 영상 광고 API의 대체 필터 차단을 보완
- 재생 제한이 생겨도 YouTube를 조용히 자동 허용하거나 페이지를 무한 새로고침하지 않음
- 전체 광고 차단 켜기/끄기
- 현재 사이트만 허용하기
- 제보된 `div[data-cl-overlay]` 클릭 덮개 숨김(현재 사이트 토글로 해제 가능)
- 별도 사이트별 클릭 납치 방지, 선택형 강화 팝업 차단, 이번 페이지 허용·보호 복구
- 제공 코드로 확인한 `04.avsee.is` 플레이어의 특정 버전 광고 검사 파일만 차단하는 호환 규칙
- 현재 탭의 차단 요청 수를 확장 아이콘 배지와 팝업에 표시
- 설정을 브라우저 로컬 저장소에만 보관

## Chrome에 설치하기

1. 주소창에서 `chrome://extensions`를 엽니다.
2. 오른쪽 위의 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 누릅니다.
4. 이 프로젝트 폴더(`adblock`)를 선택합니다.
5. 툴바의 퍼즐 아이콘에서 **가벼운 광고 차단기**를 고정합니다.
6. 이미 열려 있던 웹페이지를 한 번 새로고침합니다.

코드를 바꾼 뒤에는 `chrome://extensions`의 확장 카드에서 새로고침 버튼을 누르고, 테스트할 웹페이지도 새로고침하세요.

## 빠른 검증

Node.js가 설치되어 있다면 프로젝트 루트에서 다음을 실행할 수 있습니다.

```powershell
node --check background.js
node --check content.js
node --check hijack-patterns.js
node --check hijack-guard.js
node --check hijack-main.js
node --check vendor/ublock-origin-lite/ublock-filters-main.js
node --check vendor/ublock-origin-lite/ublock-filters-isolated.js
node --check popup/popup.js
node --check sites/soop.js
node --check sites/chzzk.js
node scripts/validate.mjs
node scripts/smoke-tests.mjs
node scripts/soop-tests.mjs
node scripts/sexkbj-tests.mjs
node scripts/chzzk-tests.mjs
node scripts/overlay-tests.mjs
node scripts/player-compat-tests.mjs
node scripts/hijack-tests.mjs
```

Playwright와 자동화용 Chromium(`npx playwright install chromium`)이 설치된 개발 환경에서는 브라우저가 ruleset을 실제로 활성화하고 시험 광고 요청을 차단하는지도 확인할 수 있습니다. 검사용 창은 화면 밖에서 잠깐 실행되고 별도 임시 프로필을 사용합니다. 일반 배포판 Chrome은 자동화 실행의 확장 사이드로드 플래그를 무시할 수 있습니다.

```powershell
node scripts/chrome-load-check.mjs
node scripts/soop-tests.mjs --chrome
node scripts/sexkbj-tests.mjs --chrome
node scripts/chzzk-tests.mjs --chrome
node scripts/ad-slot-tests.mjs
node scripts/overlay-tests.mjs --chrome
node scripts/player-compat-tests.mjs --chrome
node scripts/hijack-tests.mjs --chrome
node scripts/hijack-popup-tests.mjs
```

SOOP 검사는 오프라인 가짜 응답으로 XHR/fetch 호환성, 광고 규칙 9개,
본영상 정보 보존, 사이트 예외와 전체 OFF/재활성화를 확인합니다.
실제 SOOP 광고 송출 여부와는 구분해야 합니다.

실제 대상 VOD를 새 임시 프로필에서 재생하려면 아래 진단을 별도로 실행합니다.
외부 네트워크를 사용하며 첫 명령은 광고 차단 없이, 두 번째는 확장 ON 및
새로고침 후 본영상 재생을 확인합니다. 필요하면 `CHROME_PATH`로 자동화용
Chromium 경로를 지정하세요. 검사 후 임시 프로필만 삭제합니다.

```powershell
node scripts/soop-live-check.mjs
node scripts/soop-live-check.mjs --extension --reload
```

## 구조

```text
manifest.json       Chrome 확장 설정과 권한
background.js       차단 규칙 및 사이트 예외 동기화
content.js          광고 영역 숨김의 켜기/끄기 상태 관리
hijack-patterns.js  브라우저 연동과 분리한 작은 팝업 광고 목적지 분류기
hijack-guard.js     덮개·링크 보호, 독립 설정, 문서별 허용·고정 이유 보고
hijack-main.js      분류기를 포함한 MAIN 번들, 제한된 window.open 처리
cosmetic.css        보수적인 광고 요소 선택자
sites/fmkorea.css   FM코리아의 현재 광고 컨테이너 보완 선택자
sites/chzzk.js      치지직 공개 HLS 재생·광고 정책 처리
sites/soop.js       SOOP VOD 애드벌룬 응답 처리 (XHR/fetch)
sites/sexkbj.css    확인된 sponsored 제휴 광고 배너만 숨김
youtube.css         YouTube 인피드·플레이어 광고 선택자
vendor/ublock-origin-lite/ 공식 uBOL MAIN/ISOLATED scriptlet과 해시·고지
rules/easylist.json KoreanList+EasyList 기반 정적 DNR 규칙
rules/cosmetic-generic.css 예외와 무관한 범용 cosmetic 규칙
rules/cosmetic-specific.json 조건부 범용·도메인별·예외 인덱스
rules/easylist.metadata.json 필터 버전·해시·변환 통계
rules/EASYLIST_NOTICE.md     KoreanList+EasyList 출처와 라이선스 고지
rules/ads.json      기본 ruleset을 켤 수 없을 때 쓰는 소형 대체 규칙
rules/soop.json     기본/대체 ruleset과 함께 쓰는 SOOP 광고 보조 규칙
rules/player-compat.json 확인된 플레이어 호스트·검사 파일 버전에 한정한 호환 규칙
rules/hijack-patterns.source.txt 검토한 EasyList 팝업 규칙 10개·출처·라이선스
rules/soop.source.txt 원문 SOOP 필터 10줄 (네트워크 9 + scriptlet 1)
rules/soop.metadata.json List-KR 고정 커밋·원본 해시·변환 정보
rules/SOOP_NOTICE.md     List-KR 출처·GNU GPLv3 고지와 수정 내역
popup/              확장 아이콘을 눌렀을 때 보이는 UI
icons/              툴바와 확장 관리 화면의 아이콘
scripts/validate.mjs 정적 검증 도구
scripts/smoke-tests.mjs 설정과 토글 로직 스모크 테스트
scripts/import-installed-easylist.mjs 설치본에서 KoreanList+EasyList snapshot 생성
scripts/import-ubol-youtube.mjs 검토한 공식 uBOL Chromium 릴리스 가져오기
scripts/chrome-load-check.mjs 자동화용 Chromium 실제 로드 검사
scripts/soop-tests.mjs SOOP 단위·Chrome 오프라인 통합 검사
scripts/sexkbj-tests.mjs 사이트 광고 CSS·대체 필터·설정 토글 검사
scripts/soop-live-check.mjs SOOP 실제 페이지 재생 진단 (네트워크 사용)
scripts/chzzk-tests.mjs 치지직 응답·공개 재생 정보·광고 정책 회귀 검사
scripts/chzzk-live-check.mjs 치지직 실제 공개 방송 재생 진단 (네트워크 사용)
scripts/overlay-tests.mjs 클릭 덮개·클릭 전달·사이트 예외 오프라인 검사
scripts/player-compat-tests.mjs 플레이어 검사 파일 범위·토글·재생 분기 오프라인 검사
scripts/hijack-tests.mjs 납치 패턴·팝업·문서별 허용·프레임·개인정보 오프라인 검사
scripts/hijack-popup-tests.mjs 신규 토글·임시 허용 UI·실패 롤백 오프라인 검사
```

## 클릭 납치 방지 (v1.10.0)

기본 보호는 확인된 `div[data-cl-overlay]` 표식과 공개 EasyList 팝업 규칙 중
검토한 도메인 6개·경로 4개만 사용합니다. 전체 광고 호스트 목록을 납치
목적지로 간주하거나, 투명도·큰 면적만으로 정상 재생 컨트롤을 제거하지 않습니다.

- 덮개: 기존 표식 또는 확인된 광고 목적지 링크가 실제 video/iframe의 60% 이상을
  덮고 위에 놓여 있는 경우만 숨깁니다. 정상 로그인 링크·재생 버튼·대화상자는
  크기가 크다는 이유로 차단하지 않습니다. 동적 변경은 제한된 배치로 검사합니다.
- 링크: 확인된 외부 광고 호스트의 클릭/가운데 클릭은 이동 전에 막습니다.
  다른 목적지의 일반 링크는 유지합니다.
- 팝업: 기본 모드는 확인된 외부 광고 호스트/팝업 경로의 `window.open`만 막습니다.
  같은 호스트, `about:blank`, 인쇄·다운로드, 일반 로그인 팝업은 기본 모드에서
  그대로 전달합니다. 기본 브라우저 팝업 정책과 기존 광고 네트워크 필터는 별개입니다.
- 강화 모드: 해당 사이트에서 직접 켰을 때만, 명시적으로 누른 링크의 목적지와
  일치하지 않는 외부 `window.open`도 막습니다. 정상 로그인·결제 버튼의 팝업도
  차단될 수 있어 기본값은 OFF입니다.

**클릭 납치 방지** 스위치는 현재 최상위 호스트에만 적용되며 다른 광고 필터는
유지합니다. 기존 전체 광고 OFF·사이트 광고 OFF는 납치 보호도 함께 해제합니다.
**차단 내역 · 허용 설정**을 펼치면 강화 모드, 고정 이유·카운트,
**이번 페이지에서 허용**, **보호 복구**가 있습니다.

임시 허용은 실제 다음 클릭 1회 이용권이 아니라, 현재 살아 있는 문서와 확인된
하위 프레임의 납치 방지만 잠시 끄는 동작입니다. 새로고침·새 문서·새 프레임에서는
기본 보호가 다시 적용됩니다. 막은 주소를 저장하거나 자동으로 다시 열지 않습니다.
기존 광고 필터는 계속 적용되므로 임시 허용해도 네트워크 광고가 열리지 않을 수
있습니다. 보호 복구는 숨김을 다시 적용하며 삭제된 DOM을 새로 만들지 않습니다.

추가 권한이나 웹페이지로부터의 임의 명령 실행은 없습니다. 설정은 로컬 저장소에,
차단 이유와 최대 999의 카운터는 문서별 메모리에만 둡니다. 쿠키·영상 주소·클릭
목적지·DOM 텍스트·방문 기록은 진단에 보고하거나 저장소에 보관하지 않습니다.
강화 모드에서만 명시적 링크와 팝업의 일치를 비교하는 동안 주소를 일시적으로
메모리에 사용하며, 유효기간은 500ms이고 사용 또는 만료 타이머 시 폐기합니다.
페이지 MAIN 코드는
고정 이유만 전달하며 설정 변경 권한은 없습니다. 보고 내용은 페이지가 위조할 수
있으므로 보안 감사 기록으로 취급하지 않습니다. 허용·복구는 실제 팝업에서 받은
문서 토큰을 검증하고, 이동 중 바뀐 문서에 과거 명령을 적용하지 않습니다.

분류기는 브라우저 API 없는 `hijack-patterns.js`로 분리했고 MAIN 번들에도 같은
내용을 포함합니다. 서로 다른 실행 환경에서 같은 파일 경로의 중복 주입에 의존하지
않도록 분리했으며 테스트가 두 사본의 일치를 검사합니다.

한계: 페이지가 직접 대입하는 `location`, 이미 저장해 둔 원본 `window.open`,
빈 창을 나중에 다른 주소로 이동시키는 동작, 보호를 우회·변경하는 사이트 코드,
닫힌 Shadow DOM, 초기 설정을 읽기 전에 열린 팝업, 아직 목록에 없는 목적지를
모두 막는다고 보장하지 않습니다.
브라우저의 기본 동작을 손상시키지 않도록 `Location` 등을 전역 변경하거나 모든
외부 링크를 막지 않습니다. 확장 업데이트 후 이미 열린 탭은 새로고침해야 합니다.
사이트별 `ad-gate.js` 호환 규칙은 이 기능과 별도로 유지됩니다.

규칙 출처는 [EasyList 팝업 도메인 목록](https://github.com/easylist/easylist/blob/master/easylist/easylist_adservers_popup.txt)과
[팝업 경로 목록](https://github.com/easylist/easylist/blob/master/easylist/easylist_general_block_popup.txt)입니다.
원저작자는 The EasyList authors이며 선택한 파생 데이터의 라이선스는
GPL-3.0-or-later입니다. 정확히 사용한 10개 규칙과 변경점은
`rules/hijack-patterns.source.txt`에 기록합니다. 원격 규칙을 자동 실행하지 않습니다.
검증은 격리 Chromium의 로컬 합성 페이지에서만 수행합니다.

## 특정 플레이어 호환 처리 (v1.9.5)

사용자가 제공한 `ad-gate.js?v=1790860982`, `player.js?v=1791207311` 코드를
분석한 결과, 광고 검사 요소 4개 중 2개 이상이 반복해서 숨겨지면 `blocked`를
반환합니다. 일반 숨김 규칙의 `.ad-slot`, `.sponsored-link`, `[id^="div-gpt-ad"]`가
서로 다른 검사 요소 2개에 걸리는 것을 오프라인에서 재현했습니다.
`div[data-cl-overlay]` 전용 규칙은 이 검사 요소에 적용되지 않습니다.

이 버전의 재생 코드는 검사 객체가 없거나 결과가 `unknown`이면 재생 초기화를
허용하며, `clear`일 때만 등록된 광고 코드를 실행합니다. 따라서 검사 성공을
위조하거나 일반 광고 숨김을 해제하지 않고, 아래 요청 하나만 차단합니다.

```text
https://04.avsee.is/player/ad-gate.js?v=1790860982
```

`player_compat` ruleset은 대소문자를 구분하는 고정 URL과 `script` 유형에만
적용됩니다. 시작 문서 도메인도 `04.avsee.is`로 제한합니다(Chrome의
`initiatorDomains`는 그 하위 도메인도 포함하지만, 요청 대상 호스트는 위 주소와
정확히 같아야 합니다). 다른 호스트·버전·추가 쿼리·HTTP에는 적용하지 않습니다.
광고 검사 미끼, 실제 광고 스크립트, 영상 주소를 수정하거나 다른 사이트의
검사 함수를 일괄 덮어쓰지 않습니다. 추가 권한·쿠키 접근·외부 통신은 없습니다.

기본/대체 광고 목록과 함께 켜고 끄며, 기존 전체 OFF 및 사이트 OFF를 따릅니다.
사이트 OFF 시에는 이 호환 규칙과 클릭 덮개 차단도 해제됩니다. 이미 실행된
검사 객체나 광고 코드는 제거하지 않으므로 업데이트 후 확장과 페이지를
새로고침해야 합니다. 기존 `광고 차단`/`이 사이트에서 차단` 토글을 그대로 씁니다.

검증은 격리된 Chromium과 로컬 가짜 응답으로만 수행합니다. 대상 사이트 접속,
로그인 쿠키 사용, 실제 영상 재생은 하지 않습니다. 테스트에 원본 재생 코드를
추가하려면 `PLAYER_SOURCE` 환경변수에 로컬 `player.js` 경로를 지정해
`node scripts/player-compat-tests.mjs --chrome`을 실행하세요. 실제 제공 코드를
사용했는지는 테스트 출력에 구분됩니다. 광고 코드는 무해한 카운터로 대체하고
JWPlayer도 테스트 대역을 사용하므로 실제 사이트에서의 재생 성공을 보장하는
검사는 아닙니다. 사이트의 파일 버전이나 재생 분기가 바뀌면 재검토해야 합니다.

## 클릭 덮개 차단 (v1.9.4)

사용자가 제보한 두 HTML 예시의 공통 표식 `div[data-cl-overlay]`를 일반 웹페이지에서
숨깁니다. 바뀌는 클래스명이나 투명 GIF 주소에 의존하지 않아 같은 표식의 덮개가
나중에 추가되거나 클래스명이 바뀌어도 적용됩니다. DOM과 이벤트 등록은 삭제하지 않습니다.

팝업의 기존 **이 사이트에서 차단** 스위치가 ON이면 광고 차단과 이 규칙을 함께
적용하고, OFF이면 해당 사이트에서 모두 해제합니다. 전체 **광고 차단** OFF도
따릅니다. 현재 페이지의 숨김은 설정 변경 시 해제되며 팝업은 기존 방식대로
현재 탭도 새로고침합니다. 사이트 예외는 정확한 호스트 단위로 로컬에 저장됩니다.

이 규칙은 공개 필터 목록의 `$generichide`, `$elemhide`, `#@#` 숨김 예외와 별개인
명시적 로컬 기능입니다. 같은 속성을
정상 클릭 영역에 쓰는 사이트에서는 오탐할 수 있으므로 사이트 스위치로 끄고
테스트하세요. 페이지 전체 클릭, `window.open`, 외부 링크는 일괄 차단하지 않습니다.
덮개가 아닌 document/부모 요소에 붙은 팝업 스크립트까지 해결한다고 보장하지 않습니다.
제공된 구글 `ea0Lbe` 필터는 별개 예시로 취급해 적용하지 않았습니다.

추가 권한이나 외부 통신 없이 기존 상태 관리와 정적 CSS를 이용합니다. 검사는
제보 HTML을 재현한 합성 페이지에서 수행하며 실제 문제 사이트의 검증은 별도입니다.

## 알아둘 점

네트워크 차단은 설치된 오픈소스 AdBlock 6.44.0.1의 KoreanList+EasyList 변환 결과를 연구 기준선으로 사용합니다. 원본 56,068개 중 안전한 `block`, `allow`, `allowAllRequests` 규칙 56,058개를 유지했고, 리다이렉트 7개와 응답 헤더 변경 3개는 제외했습니다. 출처, 정확한 버전과 해시는 [필터 데이터 고지](rules/EASYLIST_NOTICE.md)와 `rules/easylist.metadata.json`에 기록되어 있습니다.

같은 설치본에서 snapshot을 다시 만들려면 다음 명령을 실행합니다. 경로 인수를 생략하면 Chrome 기본 프로필의 최신 AdBlock 설치본을 자동으로 찾습니다.

```powershell
node scripts/import-installed-easylist.mjs
```

범용 cosmetic 계층은 표준 CSS로 표현할 수 있는 `##` 요소 숨김과 `#@#` 예외를 중심으로 동작합니다. 예외와 무관한 13,360개는 정적 CSS에 두고, 사이트에 따라 달라지는 조건부 범용 301개와 도메인별 참조 16,701개는 현재 문서에 필요한 부분만 삽입합니다. 호스트 단위 `$generichide` 예외 182개도 적용합니다. 일반 사이트의 확장 `#?#` 274개와 범용 procedural selector·scriptlet 엔진은 아직 지원하지 않습니다. YouTube에는 검토하고 버전 고정한 uBOL 번들, 치지직과 SOOP에는 제한된 사이트 전용 코드를 사용합니다.

v1.7의 YouTube 계층은 자체 prototype 훅을 더 늘리는 대신 공식 [uBlock Origin Lite 2026.729.1529 릴리스](https://github.com/uBlockOrigin/uBOL-home/releases/tag/2026.729.1529)의 생성된 `ublock-filters` MAIN/ISOLATED 번들을 수정 없이 포함합니다. 실제 등록 범위는 YouTube 호스트뿐이며, 사이트별 OFF 상태도 동적 콘텐츠 스크립트의 `excludeMatches`에 반영됩니다. 원본 경로, 릴리스 ZIP과 파일별 SHA-256, 라이선스는 [vendor 고지](vendor/ublock-origin-lite/NOTICE.md)와 `metadata.json`에 기록했습니다.

이 번들은 현재 [uAssets Quick fixes](https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt)의 YouTube 계층처럼 player 요청·응답 처리와 서버 측 재생 제한 복구를 한 묶음으로 적용합니다. 임의 원격 scriptlet을 브라우저에서 받아 실행하지 않습니다. 새 공식 Chromium 릴리스를 검토해 업데이트하려면 압축을 푼 경로를 다음 명령에 넘깁니다.

```powershell
node scripts/import-ubol-youtube.mjs C:\path\to\uBOLite-release
```

설치된 AdBlock은 YouTube 차단벽이 생기면 해당 탭을 자동 허용하고 다시 로드하는 fail-open도 갖고 있습니다. 이 프로젝트는 그 동작을 복제하지 않으므로 복구에 실패하면 제한 화면이 남을 수 있지만, 사용자 모르게 광고 차단을 끄지는 않습니다. v1.3이 만들었던 탭별 세션 허용 규칙과 `sessionStorage` 마커는 업데이트할 때 제거합니다.

현재 Chrome 프로필에 설치된 AdBlock 6.44.0.1의 구조, 규칙 규모, 기능 차이와 단계별 구현 방향은 [연구 문서](docs/ADBLOCK_RESEARCH.md)에 정리했습니다.

사이트별 예외는 높은 우선순위의 동적 `allowAllRequests` 규칙으로 구현되어 있으며 브라우저를 다시 시작해도 유지됩니다. 다른 광고 차단 확장 프로그램이 만든 규칙에는 영향을 주지 않습니다.

## SOOP VOD 대응 (v1.8)

기본 KoreanList+EasyList snapshot에는 현재 SOOP 광고 서버용 규칙이 없어,
List-KR의 2026-09-30 커밋에서 확인한 SOOP 규칙만 별도로 포함했습니다.
전체 List-KR이나 다른 광고 차단 확장을 가져온 것은 아닙니다.
원본 필터와 변경 범위는 [SOOP 고지](rules/SOOP_NOTICE.md), 동작 분석과
검증 범위는 [SOOP 연구 기록](docs/SOOP_RESEARCH.md)에 있습니다.

- `get_ad.php` 광고 설정 API와 `reqde`/`deapi` 광고 추천 서버를 함께 차단합니다. 설정 API만 막으면 대체 광고 서버로 재시도할 수 있습니다.
- `data.adballoon`은 애드벌룬 배너 설정입니다. 정확한 VOD 정보 API의 이 필드만 지우며, 영상 파일·로그인·구독·접근권한·광고 편성 플래그는 변경하지 않습니다.
- 네트워크 규칙은 SOOP가 시작한 요청에만 적용하고 최상위 페이지 이동은 제외합니다. VOD 응답 처리는 `vod.sooplive.com`에만 등록됩니다.
- 전체 OFF와 현재 사이트 예외가 적용됩니다. 이미 열린 SOOP 문서의 후속 응답도 OFF 상태를 따릅니다. 이미 소비한 응답이나 차단한 요청을 되돌리지는 않으므로 현재 페이지를 새로고침하세요.
- 기본 필터가 용량 제한 등으로 소형 목록으로 전환되어도 SOOP 보조 규칙은 유지합니다. 브라우저 실행 중 외부 코드를 가져와 실행하지 않습니다.

업데이트 후 확장 관리 화면과 SOOP 영상 페이지를 모두 새로고침해야 새 코드가 적용됩니다.
광고 송출은 계정·지역·시점에 따라 달라지므로 한 영상의 시험 결과를 모든 광고 유형에 일반화하지 않습니다.
2026-10-03 대상 영상의 실제 Chromium 비교에서는 미설치 시 30초 광고,
v1.8 ON과 새로고침 후에는 광고 요청 차단 및 본영상 시간 증가를 확인했습니다.
중간광고 시점까지 재생한 검증은 아니며, 차단된 광고 요청 때문에 사이트가 남기는
Network Error 로그는 본영상 미디어 오류와 구분해야 합니다.

## 추가 사이트 광고 보완 (v1.8.1)

`sexkbj.tv`에서는 확인된 sponsored 제휴 배너를 사이트 전용 CSS로 숨깁니다.
사이트 내부 이동으로 새로 생긴 광고에도 적용되며 전체/사이트 OFF에서는 복원됩니다.
영상 광고 서버는 기존 EasyList에 이미 포함되어 있어, 이번에는 소형 대체 목록에서도
확인된 광고 API만 차단하도록 보완했습니다. 로그인·구독·결제·본영상 정보는 변경하지 않습니다.

실제 페이지의 배너 ON/OFF 및 새로고침은 확인했지만 영상 콘텐츠를 재생한 검증은
아닙니다. 광고 구조·검사 범위는 [사이트 연구 기록](docs/SEXKBJ_RESEARCH.md)에 있습니다.

## 치지직 라이브 복구 (v1.9)

기존의 URL 기반 fetch 처리만으로는 현재의 XHR·암호화 전송 경로를 놓쳤습니다.
고화질 설치 안내와 광고 정책은 별개의 원인이므로 각각 처리합니다.

- 공개·무료·방송 중인 재생 정보에서 사이트가 이미 제공한 HTTPS HLS 주소와 화질 목록을 유지하고 P2P 경로 표식만 제거합니다. 확인된 영상 CDN 네 곳에만 적용합니다.
- 정상 응답의 알려진 화질 상한과 광고 boolean, 그리고 브라우저가 정상 복호화한 응답 중 식별자·구조가 정확히 일치하는 광고 정책만 처리합니다.
- 로그인·연령·구매·재생 권한, 영상 주소와 토큰은 변경하지 않습니다. 네이버 프로그램을 설치하거나 설치된 것처럼 위장하지 않습니다.
- 전체/사이트 OFF를 따릅니다. 이미 플레이어가 읽은 정보는 되돌릴 수 없으므로 설정 변경 후에는 방송 페이지를 새로고침하세요.

2026-10-03 제공된 방송을 새 임시 프로필에서 비교했습니다. 미설치 상태에서는
고화질 설치 안내가 나타났고, v1.9 ON의 첫 접속과 새로고침에서는 안내 없이
1920×1080 본영상 재생과 프레임 증가를 확인했습니다. 검사 구간에 플레이어 광고
UI가 나타나지 않았으며, 비교군에서 관찰한 Google 광고 호스트 요청도 없었습니다.
페이지의 다른 광고 관련 요청까지 모두 없어진 것은 아니며, 긴 중간광고 구간과
로그인 계정별 동작은 검증하지 않았습니다. [원인·검사 기록](docs/CHZZK_RESEARCH.md).

```powershell
node scripts/chzzk-tests.mjs --chrome
node scripts/chzzk-live-check.mjs
node scripts/chzzk-live-check.mjs --extension --reload
```

마지막 두 명령은 외부 네트워크에서 실제 공개 방송을 재생하는 선택적 진단입니다.
자동화용 Chromium과 Playwright가 필요하며 사용자 Chrome 프로필은 사용하지 않습니다.
실방송 검사는 본영상과 광고 video를 구분하며 기본 20초 동안 추가 관찰합니다.
`--seconds=45`처럼 관찰 시간을 지정할 수 있습니다(5~180초). 특정 방송 URL을
마지막 인수로 지정할 수 있으며, 짧은 검사 성공이 모든 중간광고 차단을 뜻하지 않습니다.
업데이트 적용은 `chrome://extensions`에서 확장 새로고침 → 방송 페이지 새로고침 순서입니다.

### v1.9.1: 후속 영상 광고 목록과 실행 진단

처음 광고 정책 처리가 빗나간 경우를 위해, 실제 확인한 Naver SSP 영상 광고
목록도 별도로 처리합니다. 알려진 터널 식별자와 정확한 응답 구조가 일치할 때만
광고 후보 목록을 비우며 본영상·권한·응답의 나머지 정보는 유지합니다.
플레이어의 정상적인 광고 없음 경로를 이용하고 광고 시청/노출 이벤트를 만들지 않습니다.

현재 문서에서 실행한 코드 버전·처리 함수 상태·변경 횟수만 문서의 진단 속성에
기록합니다. 쿠키·영상 주소·응답 본문·암호 키·계정 정보는 기록하지 않으며 외부로
전송하지 않습니다. 확장 관리 화면의 버전과 이미 열려 있는 페이지의 실행 코드가
항상 같은 것은 아니므로 업데이트 후 페이지 새로고침까지 필요합니다.

이 보완은 첫 정책 처리를 일부러 끈 분리 시험에서 후속 광고 요청 억제와 본영상
진행을 확인한 것입니다. 사용자가 제보한 간헐적 광고의 정확한 원인을 확정하거나
모든 계정·중간광고를 검증한 것은 아닙니다.

### v1.9.2: 고화질 안내 재발 진단 보강

2026-10-04 제보된 실제 탭에서는 1.9.1이 ON 상태로 실행 중인데도 고화질 처리가
0회이고 설치 안내가 보였습니다. 같은 방송은 새 프로필의 첫 접속·새로고침에서
모두 1080p로 재생돼, 아직 사용자 탭의 정확한 실패 조건은 확정하지 못했습니다.

이번 버전은 해결을 확정한 패치가 아닌 진단 보강판입니다. 재생 정보의 구조,
공개 재생 조건, 미디어 주소·CDN 조건 중 어디서 처리가 빠졌는지 고정된 횟수로
구분합니다. 일부 미디어만 처리된 경우도 따로 기록합니다. 주소·응답 내용·계정
정보는 기록하지 않으며, 로그인·유료 조건과 CDN 허용 범위를 넓히지 않았습니다.

적용하려면 확장 관리 화면에서 **가벼운 광고 차단기 새로고침** 후 방송 페이지도
새로고침하세요. 안내가 다시 뜨면 그 탭을 그대로 두고 알려주세요.

### v1.9.3: 소규모 방송에서 확인한 추가 영상 서버 지원

제보된 이타eatha 방송에서 기존 목록에 없는 `fcdn-livecloud.pstatic.net` 서버를
사용해 고화질 설치 안내가 나타나는 문제를 재현했습니다. 이 정확한 호스트만
추가했으며 공개·무료·방송 중 조건, HTTPS·미디어 주소 검사와 권한 보호는 유지합니다.
시청자 수에 따라 서버가 배정된다고 확인한 것은 아니며 소규모 방송만의 문제라고
단정하지 않습니다. 광고 처리·확장 권한·다른 사이트 동작은 변경하지 않았습니다.

## 참고한 공식 문서

- [Chrome declarativeNetRequest API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome scripting API와 동적 콘텐츠 스크립트](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome 콘텐츠 필터링 가이드](https://developer.chrome.com/docs/extensions/develop/concepts/content-filtering)
- [Manifest V3의 요청 차단 변경점](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [uBlock Origin Lite 공식 릴리스](https://github.com/uBlockOrigin/uBOL-home/releases)
- [uBlock Origin 소스](https://github.com/gorhill/uBlock)
- [uAssets Quick fixes](https://github.com/uBlockOrigin/uAssets/blob/master/filters/quick-fixes.txt)
