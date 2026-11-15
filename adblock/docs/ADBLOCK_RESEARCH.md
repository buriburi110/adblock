# 설치된 AdBlock 6.44.0.1 분석

분석일: 2026-08-01

## 결론

기술적으로 구현할 수 있다. 다만 설치본과 비슷한 차단율을 결정하는 것은 팝업 UI가 아니라 대규모 필터 데이터와 필터 해석 엔진이다. 이번 연구 단계에서 현재 프로젝트를 KoreanList+EasyList 기반 네트워크 안전 동작 56,058개와 표준 CSS형 범용·도메인별 cosmetic 계층으로 확장하고, YouTube에 필요한 제한적 MAIN-world 처리도 독립 구현했다. 설치된 AdBlock과의 주요 차이는 이제 다른 사이트의 기본 요소 숨김이 아니라 procedural selector, 범용 scriptlet, 사용자 필터와 여러 구독의 갱신 엔진이다.

대상 확장은 소스가 공개된 GPLv3 프로젝트다. 따라서 난독화된 번들을 그대로 복원하는 것보다, 공개된 동일 버전 소스와 설치된 결과물을 대조하는 연구 방식이 정확하고 재현 가능하다.

## 조사 범위

- Chrome 기본 프로필의 확장 목록에서 이름, ID, 버전, manifest를 읽기 전용으로 확인
- 대상 확장 패키지의 manifest, 정적 ruleset 메타데이터, 번들 구조, 소스맵, 팝업과 옵션 화면 구조 확인
- 방문 기록, 쿠키, 로그인 정보, 확장 저장소의 사용자별 허용 목록과 통계는 확인하지 않음
- 보호조치 우회, 서명 우회, 원본 확장 변조는 하지 않음

## 식별한 대상

| 항목 | 값 |
|---|---|
| 이름 | AdBlock — 최고의 광고 차단기 |
| 확장 ID | `gighmmpiobklfepjocnamgkkbiglidom` |
| 설치 버전 | `6.44.0.1` |
| Manifest | V3 |
| 최소 Chrome | 124 |
| 백그라운드 | `abp-background.js` 서비스 워커 |
| 팝업 | `adblock-button-popup.html` |
| 옵션 | `options.html` |

같은 프로필에는 `uBlock 25.5.0`도 있지만, 이름과 확장 ID를 기준으로 이번 대상에서는 제외했다. 치지직 전용 광고 스키퍼 두 개도 범용 광고 차단기 비교 대상에서 제외했다.

## 설치본의 핵심 구조

설치본은 `@eyeo/webext-ad-filtering-solution` 기반 필터 엔진과 AdBlock 전용 UI·설정 계층으로 구성되어 있다. 소스맵 기준으로 백그라운드 번들의 모듈 439개 중 251개가 필터 엔진 계층에 속한다. 즉, 제품의 중심은 팝업보다 규칙 파싱, 구독, 사이트 예외, 요청·프레임 상태, 요소 숨김과 스니펫 처리다.

manifest에는 정적 DNR ruleset 37개가 선언되어 있고, 기본 상태에서는 다음 세 개가 활성화되어 있다.

| 기본 ruleset | DNR 규칙 수 | 주 역할 |
|---|---:|---|
| EasyList | 55,466 | 광고 요청 차단, 예외, 일부 리다이렉트와 헤더 처리 |
| Acceptable Ads | 8,255 | 허용 가능한 광고 예외와 관련 규칙 |
| Anti-circumvention | 1,660 | 광고 차단 회피 대응 |
| 합계 | 65,381 | 기본 활성 네트워크 규칙 |

KoreanList+EasyList 원문에는 네트워크 규칙 외에도 약 2.4만 개의 요소 숨김·예외 규칙이 있다. 이 프로젝트는 이 중 표준 CSS로 표현 가능한 `##`와 `#@#`를 범용·조건부·도메인별 데이터로 컴파일한다. Anti-circumvention 목록과 확장 `#?#`에는 CSS만으로 표현할 수 없는 procedural selector·스니펫·스타일 규칙도 포함되며, 이 계층은 아직 범용 지원하지 않는다.

그 밖에 EasyPrivacy, KoreanList, 소셜·쿠키·방해요소·채굴 방지 목록과 여러 언어 목록이 선택형 ruleset으로 포함되어 있다. 설치 패키지는 약 447개 파일, 약 375MB이며 대부분은 필터 데이터와 소스맵이다.

## 현재 프로젝트와의 차이

| 기능 | 현재 MVP | 설치된 AdBlock | 필요한 작업 |
|---|---|---|---|
| 네트워크 차단 | KoreanList+EasyList 안전 동작 56,058개, 소형 fallback 51개 | 기본 DNR 약 6.5만 개 | Anti-CV 등 선택 목록과 독립 업데이트 파이프라인 |
| 요소 숨김 | 정적 범용 13,360개, 조건부 범용 301개, 도메인별 참조 16,701개, iframe 지원 | 범용·사이트별 규칙 약 2.4만 개 이상과 procedural 처리 | 확장 선택자·scriptlet 런타임과 회귀 테스트 |
| 예외 | 전체·사이트 예외, cosmetic 예외 참조 658개, `$generichide` 호스트 182개 | 필터 예외, 페이지·사이트 일시정지, 허용 목록 | 경로·와일드카드 예외와 더 세밀한 범위 모델 |
| 목록 관리 | 없음 | 기본·언어·개인정보·사용자 구독 | 옵션 화면과 구독 상태 저장 |
| 사용자 규칙 | 없음 | URL 차단·허용, CSS 선택자, 직접 편집 | 파서, 검증, 동적 DNR 동기화 |
| 요소 선택기 | 없음 | 컨텍스트 메뉴 기반 수동 차단 | 오버레이 선택기와 규칙 생성 |
| 통계 | 탭별 차단 수 | 기간·사이트별 광고 및 추적 통계 | 집계 DB와 개인정보 최소화 정책 |
| 스니펫 | YouTube 초기 탐지 패턴과 플레이어 응답만 제한적으로 로컬 처리 | 회피 방지용 범용 스니펫 지원 | 검토된 로컬 스니펫 런타임으로 확장 |
| 부가 서비스 | 없음 | 계정·프리미엄·텔레메트리 포함 | 연구 구현에서는 의도적으로 제외 |

## 권장 구현 방향

### 1. 재현 가능한 기준선

동일한 Chrome 버전에서 `확장 없음 / 설치된 AdBlock / 이 프로젝트` 세 프로필을 사용한다. 테스트 페이지마다 차단된 요청, 남은 광고 요소, 레이아웃 손상, 콘솔 오류, CPU·메모리를 기록한다. 실제 뉴스·동영상 사이트만 쓰면 결과가 자주 변하므로 로컬 고정 fixture도 함께 만든다.

### 2. 필터 엔진

- 공개된 EasyList 원문을 빌드 시점에 고정 버전으로 내려받는다.
- 네트워크 규칙을 정적 DNR JSON 여러 개로 컴파일한다.
- 사용자 규칙과 사용자 구독은 동적 DNR에 넣는다.
- 일시적인 탭·사이트 예외는 세션 DNR에 넣는다.
- DNR로 표현할 수 없는 필터는 명시적으로 미지원 처리하거나 콘텐츠 스크립트 계층으로 보낸다.

### 3. 요소 숨김

현재 구현은 예외와 무관한 범용 선택자 13,360개를 정적 CSS로 적용하고, 조건부 범용 301개와 도메인별 참조 16,701개는 서비스 워커가 현재 호스트의 예외를 계산해 콘텐츠 스크립트에 전달한다. 콘텐츠 스크립트는 선택자 문법을 검사한 뒤 문서 전용 stylesheet로 적용한다. `#@#` 예외 참조 658개와 호스트 단위 `$generichide` 182개를 반영하며, iframe도 같은 경로로 처리한다. DOM이 동적으로 바뀌는 SPA는 CSS가 새 노드에도 적용되므로 전체 DOM을 반복해서 훑는 MutationObserver를 기본 경로로 사용하지 않는다.

### 4. 사용자 기능

우선순위는 사이트 일시정지와 허용 목록, 사용자 URL 필터, 사용자 CSS 필터, 필터 목록 화면, 요소 선택기 순서가 적절하다. 통계는 정확성보다 개인정보 최소화를 먼저 정하고, URL 전체 대신 호스트와 집계값만 저장하는 편이 안전하다.

### 5. 의도적으로 복제하지 않을 부분

- AdBlock 이름, 아이콘, 문구와 픽셀 단위 UI
- 계정, 결제, VPN, 프리미엄 업셀
- 텔레메트리, 원격 실험, 마케팅 식별자
- 설치본에 포함된 키·토큰·서버 설정

## 라이선스 메모

AdBlock 공개 저장소의 `COPYING`은 GPLv3다. 그 코드를 가져와 수정·배포한다면 변경 표시, 라이선스 고지, 대응 소스 제공 등 GPLv3 조건을 따라야 한다. EasyList 저장소 내용은 별도 표시가 없는 한 GPLv3 이상 또는 CC BY-SA 3.0 이상으로 이중 라이선스되며, 외부에서 참조하는 다른 구독 목록은 각각 조건을 다시 확인해야 한다.

연구 결과를 외부에 배포할 계획이 있다면 프로젝트 이름과 그래픽을 독립적으로 만들고, 사용한 코드와 목록의 저작권·라이선스 고지를 함께 제공한다. 이 문서는 기술 조사 기록이며 법률 자문은 아니다.

## 이번 단계에서 구현한 부분

- 설치된 AdBlock에서 KoreanList+EasyList UUID와 버전을 자동으로 찾는 import 스크립트
- 원본 DNR 56,068개 중 `block`, `allow`, `allowAllRequests` 56,058개를 정적 ruleset으로 통합
- 원본 엔진 자산이나 강한 네트워크 변경을 요구하는 redirect 7개와 `modifyHeaders` 3개 제외
- 기본 ruleset 활성화 실패 시 기존 51개 도메인 목록으로 전환하는 fallback
- KoreanList+EasyList 출처, 버전, 원본·출력 SHA-256과 동작별 규칙 수 기록
- 예외와 무관한 범용 cosmetic 선택자 13,360개를 `cosmetic-generic.css`로 생성
- 조건부 범용 301개, 도메인별 참조 16,701개, 예외 참조 658개를 `cosmetic-specific.json`으로 생성하고 현재 호스트에 필요한 선택자만 삽입
- 호스트 단위 `$generichide` 예외 182개를 적용하고, 확장 `#?#` 274개와 procedural selector·scriptlet은 명시적으로 제외
- FM코리아의 공개 목록 `#adpost` 규칙과 현재 광고 컨테이너를 `sites/fmkorea.css`로 보완
- 모든 iframe의 cosmetic filtering과 최상위 사이트 예외 상속
- 공개 목록과 비교해 과도했던 수동 범용 CSS 선택자 축소
- v1.6의 제한적인 자체 YouTube 훅을 등록 대상에서 제외하고, 공식 uBlock Origin Lite 2026.729.1529의 생성된 `ublock-filters` MAIN/ISOLATED 번들을 수정 없이 고정
- 두 번들을 `document_start`, 모든 프레임, origin fallback으로 등록하되 실제 Chrome 주입 범위는 YouTube 호스트로 제한
- MAIN world에서 player fetch/XHR 응답 정리뿐 아니라 `clientScreen`, `lactMilliseconds`, referer 재시도 표식과 clean-realm 우회 방어를 함께 적용
- ISOLATED world에서 현재 `serverContract` 스크립트 치환, 3037019 재생 제한 복구, `onAbnormalityDetected`·`onSnackbarMessage` 처리를 함께 적용
- 공식 릴리스 ZIP과 두 번들의 SHA-256, 원본 경로, GPL-3.0-or-later 고지를 vendor metadata에 기록하고 정적 검증에서 재계산
- 브라우저 실행 중 원격 scriptlet을 내려받아 실행하지 않고, 검토한 공식 Chromium 릴리스만 명시적 import 스크립트로 갱신
- v1.3의 YouTube 탭별 자동 허용을 폐기하고 기존 세션 규칙·마커·배지를 v1.4 업데이트 시 정리
- 설치된 AdBlock의 `ytd-enforcement-message-view-model` 감지 후 탭 단위 `@@||youtube.com^$document` 자동 허용은 광고도 되살리는 fail-open이므로 복제하지 않음
- YouTube 인피드, 검색, Shorts 광고 원소, 플레이어 오버레이 요소 처리
- 전역 및 사이트별 일시정지 상태를 동적 scriptlet 등록·제외에 반영하고 같은 스모크 테스트에서 검증

## 다음 구현 단위

가장 가치가 큰 다음 단계는 YouTube 전용 persistent Chrome 프로필 회귀 테스트다. 여기에는 첫 문서 로드와 여러 번의 SPA 영상 전환, 프리롤·미드롤·Shorts, 3037019 제한 화면, `onAbnormalityDetected` 경로, 로그아웃·로그인 계정 차이를 포함해야 한다. 현재 스모크 테스트는 고정된 uBOL 번들에서 YouTube에 선택되는 scriptlet과 핵심 인자를 검증하지만 서버·계정 판정까지 재현하지는 못한다.

범용 cosmetic의 다음 단계는 현재 생성된 `범용 / 조건부 범용 / 도메인별 / 예외` 인덱스를 고정 fixture와 실제 사이트에서 회귀 테스트하는 것이다. 특히 `$generichide`, 서브도메인 상속, iframe, selector 문법 오류와 사이트별 레이아웃 손상을 기록해야 한다. FM코리아처럼 공개 목록의 선택자가 실제 DOM 변화에 뒤처지는 경우에는 사이트 전용 보완 규칙을 최소 범위로 유지한다.

그다음 일반 CSS로 표현할 수 없어 제외한 확장 `#?#` 274개와 procedural selector·scriptlet을 YouTube 밖에서도 별도 검토된 런타임으로 지원할지 결정한다. 임의 목록의 실행형 규칙을 신뢰하지 않고, 원격 JavaScript를 실행하지 않는 MV3 경계를 유지하면서 사용자 필터, Anti-CV 등 선택 구독과 서명·해시 검증 갱신 파이프라인을 추가하는 순서가 적절하다.

## 공식 자료

- AdBlock/Adblock Plus 공개 저장소: <https://gitlab.com/eyeo/browser-extensions-and-premium/extensions/extensions>
- 공개 릴리스: <https://gitlab.com/eyeo/browser-extensions-and-premium/extensions/extensions/-/releases>
- GPLv3 원문: <https://gitlab.com/eyeo/browser-extensions-and-premium/extensions/extensions/-/raw/main/COPYING>
- Chrome DNR API: <https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest>
- Chrome scripting API: <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- Chrome 콘텐츠 필터링 가이드: <https://developer.chrome.com/docs/extensions/develop/concepts/content-filtering>
- uBlock Origin Lite 고정 릴리스: <https://github.com/uBlockOrigin/uBOL-home/releases/tag/2026.729.1529>
- uBlock Origin 엔진 소스: <https://github.com/gorhill/uBlock>
- uBlock Origin 최신 수정 필터: <https://github.com/uBlockOrigin/uAssets/blob/master/filters/quick-fixes.txt>
- EasyList 저장소: <https://github.com/easylist/easylist>
- EasyList 라이선스: <https://easylist.to/pages/licence.html>
