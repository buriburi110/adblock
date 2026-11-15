# 치지직 공개 라이브 재생·광고 대응 — v1.9~v1.9.3

확인일: 2026-10-03. 대상 방송: <https://chzzk.naver.com/live/ec857bee6cded06df19dae85cf37f878>.
별도 임시 Chromium 프로필만 사용했다. 사용자의 Chrome 쿠키·프로필을 읽지 않았고,
네이버 확장이나 네이티브 커넥터를 설치하지 않았다. 미디어 파일을 별도로 저장하지
않았으며 API 키, 암호문, 쿠키, 서명된 영상 주소는 진단 로그에 남기지 않는다.

## 두 문제를 분리한 원인

사용자 화면은 고화질용 확장 설치 안내였다. 광고 차단 경고와는 다른 화면이다.
네이버도 [고화질/그리드 설치 문제](https://help.naver.com/service/23946/contents/23231?lang=ko&osType=COMMONOS)와
[광고 차단 경고](https://help.naver.com/service/30044/contents/23806?lang=ko&osType=COMMONOS)를 별도로 설명한다.
이 프로젝트의 처리는 네이버의 공식 지원 방식이 아니며 사이트 변경에 따라 달라질 수 있다.

기존 코드는 URL을 보고 fetch 응답만 변경했다. 현재 페이지에서 상태 polling은
XHR로도 전송되고, 초기 재생·광고 설정은 `/service/t/...` 전송을 사용한다.
논리 API 경로의 이름만 검사하는 것으로 초기 설정을 잡을 수 없었다.

확인한 논리 경로에는 다음이 있었다.

- `/service/v3.3/channels/{id}/live-detail-meta`
- `/service/v1.1/channels/{id}/live-playback-json-meta`
- `/polling/v3.1/channels/{id}/live-status`
- `seoraksan` 광고 정책

고화질 안내는 HLS/LLHLS의 P2P 경로를 발견한 플레이어가 네이티브 커넥터 상태를
검사하면서 발생했다. 공개 재생 정보에는 일반 HTTPS master playlist와 1080p
화질 목록도 이미 존재했다. 해당 P2P 경로 표식만 제거한 실험에서는 플레이어가
일반 영상 주소로 재생했다. `meta.p2p` 값을 그대로 둬도 동작했다.

## 구현 범위

`sites/chzzk.js`는 HTTPS `chzzk.naver.com`에만 MAIN/document_start로 등록된다.
다음 세 처리는 독립적으로 설치되며 중복 설치는 막는다.

### 일반 API 응답

정확한 API 호스트와 live-detail/live-status/seoraksan 경로의 성공 응답만 대상으로
fetch와 XHR(text/json)을 함께 처리한다. 다른 엔드포인트로 redirect된 응답은 제외한다.

상태 변환은 방송 중이며 `FORCE_LOW_RESOLUTION`이고 유한한 숫자 상한이 있는
알려진 경우로 제한한다. 로그인·연령·구매 제한, 종료, 알 수 없는 상태를 PLAYABLE로
덮어쓰지 않는다. `skipPreRollAd` 및 광고 정책의 기존 boolean만 바꾼다.
문자열·숫자 형태의 실제 live/chat ID는 그대로 둔다.

### 공개 영상 정보

사이트가 전송 해석 후 `JSON.parse`로 읽는 공개 영상 정보만 처리한다.
다음 조건을 모두 만족해야 한다.

- `meta.paidLive === false`, `meta.playbackAuthType === "NONE"`
- `serviceMeta.contentType === "VIDEO"`, `live.status === "STARTED"`
- mediaId가 HLS 또는 LLHLS, protocol이 HLS, encodingTrack 배열 존재
- 기존 media.path가 HTTPS `.m3u8` 주소이며 관찰된 CDN 호스트와 정확히 일치

v1.9의 허용 CDN은 `nvelop-livecloud.pstatic.net`, `ex-nlive-streaming.navercdn.com` 두 곳이었다.
실험 중 같은 방송에서 CDN이 변경되어 첫 호스트만 허용한 통합 시험은 실패했다.
두 번째 실제 관측 호스트를 추가한 뒤 두 경로가 모두 검사에 통과했다.
알 수 없는 CDN은 자동 허용하지 않는다.

대상 media와 track의 문자열 `p2pPath`, `p2pPathUrlEncoding`만 제거한다.
영상 주소·쿼리·토큰·화질 목록·비트레이트·모든 meta 값은 유지한다.
주소를 합성하지 않으며 추가 프로그램 설치 상태를 위조하지 않는다.
사용자가 reviver를 전달한 JSON.parse 호출과 비대상 JSON은 수정하지 않는다.

### 현재 전송 경로의 광고 정책

광고 정책은 일반 JSON.parse가 아니라 사이트의 바이트 JSON 파서로 읽힌다.
브라우저가 성공적으로 수행한 native WebCrypto decrypt 결과 중 다음 조건만 처리한다.

- AES-GCM 알고리즘
- AAD가 정확히 40바이트: 2바이트 길이 + `gfp-tunnel-response-v1` 식별자 + 16바이트 nonce
- UTF-8 JSON이며 최대 64KiB
- 최상위 키가 code/message/content뿐이고 값은 code 200, message null
- content 키가 livePlaybackJson 하나뿐이고 내부 키가 liveId/chatChannelId 두 개뿐
- 내부 값 두 개가 모두 boolean

이 특정 스키마의 두 광고 boolean을 false로 바꾼다. 실제 재생 ID나 일반 재생
응답을 이 스키마로 취급하지 않는다. 원래 native 호출의 this, 키, IV, 암호문,
추가 데이터는 그대로 전달하며 실패한 복호화는 성공으로 바꾸지 않는다.
키를 보관·추출·전송하거나 자체적으로 서버 응답을 복호화하지 않는다.
비대상 결과는 같은 ArrayBuffer를 돌려준다. 인증·구매 정보는 대상이 아니다.

## 호환성 및 OFF

- fetch status/headers/URL/type/redirected 및 여러 단계 clone 동작을 보존한다.
- XHR JSON 원본은 수정하지 않고 새 결과를 캐시한다. 같은 XHR 재사용 시 캐시를 비운다.
- 잘못된 responseType 접근과 WebCrypto/JSON.parse의 native 오류는 유지한다.
- 문서의 `data-lae-player="off"`를 확인해 기존 탭의 후속 처리를 중지한다.
- fetch 본문 읽기나 decrypt 완료 전에 OFF로 바뀌는 경우도 원본을 반환한다.
- 이미 소비한 재생 정보·광고 정책을 소급 복원하지는 않으므로 ON/OFF 후 새로고침이 필요하다.

## 검증 결과

### 오프라인 회귀 검사

`scripts/chzzk-tests.mjs --chrome`: 18개 그룹 통과.
VM 응답 검사와 실제 확장 설치 Chromium 검사를 함께 수행했다.
WebCrypto 검사는 일회성 테스트 키로 실제 AES-GCM encrypt/decrypt를 실행했다.

범위는 XHR/fetch, 정확한 주소·스키마, 공개 영상 정보 보존, 두 CDN·유사 도메인,
reviver, 인증/연령/유료/종료/알 수 없는 상태, AAD와 BufferSource offset,
잘못된 UTF-8·JSON·큰 버퍼, 원본 동일성, native 오류, 중복 설치와 진행 중 OFF다.

SOOP 15그룹, 추가 사이트 9그룹, 전체 smoke·manifest·Chromium 로드 검사도 통과했다.
다른 사이트의 라이브 광고를 다시 재생한 검증은 아니다.

### 실제 공개 방송

단위 검사와 달리, `scripts/chzzk-live-check.mjs`는 실제 방송을 재생한다.
headless가 아닌 자동화용 Chromium을 화면 밖에서 실행했다.
headless 모드는 사이트가 다른 UI를 반환해 이 문제 재현에 적합하지 않았다.

| 조건 | 고화질 설치 안내 | 본영상 결과 | 플레이어 광고 관찰 |
| --- | --- | --- | --- |
| 새 프로필, 확장 없음 | 표시 | 본영상 시작 전 안내 | Google 광고 호스트 요청 있음 |
| v1.9 첫 접속 | 없음 | 1920×1080, 28.021→34.046초, 프레임 13→375 | 검사 구간 UI 없음, 해당 Google 요청 없음 |
| v1.9 새로고침 | 없음 | 1920×1080, 28.119→34.150초, 프레임 20→382 | 검사 구간 UI 없음, 해당 Google 요청 없음 |

ON 두 경우 모두 readyState 4, paused false, 미디어 오류 0이었다.
별도 분리 실험에서는 고화질 처리만 적용할 때 Google 광고 호스트 요청이 3건이었고,
정확한 광고 정책 처리까지 적용할 때는 0건이었다.

`nam.veta.naver.com`, `siape.veta.naver.com` 등 다른 광고 관련 페이지 요청은
남아 있었다. 따라서 모든 광고 관련 통신을 없앴다고 주장하지 않는다.
짧은 첫 접속/새로고침 구간만 검사했으며 긴 중간광고 전체 구간, 로그인 계정,
모든 채널·지역·광고 실험군에 대한 보장은 아니다.

## 재현과 업데이트

### v1.9 이후 다른 채널의 광고 재제보

사용자가 `e14259667937be6e561d28ab156718be` 방송에서 `광고 페이지 보기`와
SKIP 카운트다운이 표시된 스크린샷을 제공했다. 이는 실제 영상 광고 노출 증거이며,
앞선 짧은 구간의 성공을 모든 사용 환경의 해결로 일반화할 수 없다.

같은 채널을 현재 v1.9 확장으로 새 프로필에서 다시 검사했을 때 첫 접속과
새로고침은 1080p로 재생됐다. 별도 페이지 내 방송 이동과 뒤로 가기 검사에서도
같은 광고 정책 구조가 처리됐으며 Google 영상 광고 요청은 재현되지 않았다.
사용자의 실제 브라우저에서는 차단 ON과 480p 본영상 재생을 읽기 전용으로 확인했다.
해당 방송 탭만 한 번 새로고침한 뒤에도 본영상은 480p로 재생됐고 관찰 순간의
광고 버튼·SKIP 안내는 없었다. 확장 설정과 다른 탭은 변경하지 않았다.
480p 자체가 확장 구버전 또는 오류의 증거는 아니다. 설치 버전과 광고가 발생한
이동 경로는 사용자 확인이 필요하다. 추가 원인이 확인되지 않아 차단 로직을
무작정 확장하거나 해결 완료로 처리하지 않았다.

기존 진단의 한계도 확인했다. 임의의 video가 1080p로 시간만 진행하는 조건은
광고 동영상을 본영상으로 오인할 수 있다. 본영상 컨테이너와 광고 표시·미디어
요소를 구분하고 동일한 video·소스의 시간 진행을 확인하도록 진단을 보완했다.
광고 페이지 버튼·SKIP 표시도 기록한다. 기본 관찰은 20초이며 `--seconds=45`처럼
5~180초의 관찰 시간을 지정할 수 있다. 진단 개선과 실제 차단 로직 수정은 구분한다.
보완된 진단으로 제보 채널을 15초 추가 관찰한 시험도 통과했다: 동일 main video의
시간 27.026→42.077초, 1080p, 광고 UI/video 관찰 없음. 이는 제보 원인의 해결 증거가
아니며 해당 새 프로필·검사 구간에서 재현되지 않았다는 결과다.

### 실행 방법

```powershell
node scripts/chzzk-tests.mjs --chrome
node scripts/chzzk-live-check.mjs
node scripts/chzzk-live-check.mjs --extension --reload
```

실방송 검사는 선택 사항이며 외부 네트워크를 쓴다. Chromium과 Playwright가 필요하다.
필요하면 CHROME_PATH로 자동화용 Chromium을 지정한다. 일반 Chrome은 자동화 실행의
확장 사이드로드 플래그를 무시할 수 있다. 방송이 종료되었거나 권한이 필요하면
성공으로 처리하지 않으며, 권한 화면을 자동 통과하지 않는다.
임시 프로필은 끝나면 검증된 임시 디렉터리만 삭제한다.

사용자 Chrome에는 확장 관리 화면에서 새로고침한 후 방송 페이지도 새로고침해야
적용된다. 새 배포판·CDN·정책 구조가 나오면 관찰과 검사 fixture를 함께 갱신한다.

## v1.9.1 후속 대응

사용자는 최신 버전에서도 광고가 나온다고 확인했다. 업데이트 누락을 원인으로
단정하지 않는다. 실제 사용자 브라우저에서 제보 방송으로 이동했다 돌아오는
검사에서는 두 방송이 1080p로 재생됐고 관찰 순간 광고 표시가 없었다.
제보한 광고의 정확한 원인은 아직 재현·확정되지 않았다.

v1.9.1 새로고침 통합 시험에서는 고화질 설치 안내도 재현됐다. 진단의 모든 처리
함수는 설치·유지 상태였지만 publicPlaybacks가 0이었다. 실제 재생 정보에서
`livecloud.pstatic.net`이 선택되었으며 나머지 공개 재생 조건은 일치했다.
이 세 번째 실제 관측 CDN을 정확히 허용하도록 보완했다. 포괄적인 도메인 허용은
추가하지 않았다. 이는 광고 노출과 구분되는 별도 재현 문제다.

### 2차 차단: 실제 영상 광고 후보 목록

1차 광고 정책 처리를 의도적으로 제외한 새 임시 프로필 실험에서 다음 응답을
관찰했다. 성공한 native decrypt 출력이며 기존 정책과 동일한 40바이트 AAD
식별자를 사용했다. 관찰 크기는 8,357~8,397바이트였다.

- 최상위 키: requestId, head, eventTracking, adUnit, randomNumber, adDivId,
  videoSkipMin, videoSkipAfter, ads
- head는 version `0.0.1`, description `Naver SSP Waterfall List`의 두 문자열
- requestId/adUnit/adDivId는 문자열, randomNumber/videoSkipMin/videoSkipAfter는 숫자,
  eventTracking은 객체, ads는 배열
- 실제 광고 후보에는 creativeType VIDEO, renderType GOOGLE_IMA 또는 EMPTY가 있었다.

공식 SDK는 같은 후보 목록에서 GV renderer도 지원하며, 빈 목록 확인이 renderer
선택보다 앞에 있다. 최종 후보 식별 조건은 객체·creativeType VIDEO·renderType
GV/GOOGLE_IMA/EMPTY·adInfo 객체로 제한한다. renderer마다 달라질 수 있는 공급자·
추적 필드의 존재를 광고 식별의 필수 조건으로 삼지 않는다. GV는 공식 소스와
오프라인 fixture로 확인한 범위이며 실제 GV 광고 송출을 재현한 것은 아니다.

이 알려진 응답 구조에만 `ads=[]`를 적용하고 나머지 메타데이터는 보존한다.
기존 boolean 정책, AES-GCM/AAD 검사, 64KiB 상한, HTTP/API 일반 처리,
OFF/진행 중 OFF 및 비대상 원본 보존 규칙은 유지한다.

공식 플레이어 번들의 `processNextAd`는 빈 후보 목록을 일반적인 `NO_FILL`로
처리한다. 광고 추적 객체 생성 전 이 경로로 빠진다. EMPTY 후보만 남기는 방식은
SDK가 노출 관련 이벤트를 만들기 때문에 사용하지 않는다. 광고 완료·노출·클릭을
위조하거나 시청한 것처럼 서버에 보고하지 않는다.

분리 실험에서는 기존 정책이 true/true인 채로 이 목록 처리만 적용해도 본영상이
1080p로 30→50초 진행했다. 광고/설치/차단 문구와 페이지 오류가 없었고 비교군의
`pubads.g.doubleclick.net` 광고 호출은 사라졌다. Google SDK 자체의 로딩은 남으므로
Google 관련 통신이 전부 없다고 해석하지 않는다.

List-KR의 별도 미디어 광고 규칙도 검토했지만 격리 실험에서 그 규칙에 해당하는
광고 요청이 발생하지 않아 이번에는 추가하지 않았다. 실제 관찰하지 못한
광고 일정 응답이나 일반적인 `ads` 필드 전체를 변경하지 않는다.

### 실행 진단

`data-lae-chzzk-diagnostics` 속성은 문서에 다음 값만 담는다.

- schema 1, 실행 코드 revision 1.9.1
- XHR/fetch/parser/tunnel 설치 확인 boolean
- 마지막 진단 갱신 시 함수 참조 동일성을 확인한 active boolean
- 실제 변경 횟수(최대 1,000,000)

주소·쿠키·계정·응답 내용·키·IV·nonce·토큰을 넣지 않는다. 로컬 저장소에도 남기지
않고 외부로 전송하지 않는다. DOM 생성, 페이지 표시 상태 변경, 차단 설정 이벤트,
실제 응답 수정 시 갱신하며 별도 주기 타이머는 없다.
페이지가 이 속성을 수정할 수 있으므로 신뢰/권한 판단에는 쓰지 않는다.

active는 마지막 갱신 시점의 참조 비교이며, false가 곧 차단 실패라는 뜻은 아니다.
다른 코드가 기존 함수를 다시 감싸면서 원래 처리를 유지할 수도 있다.
설치 여부, 처리 횟수, 실제 광고 관찰을 함께 해석한다.

격리 확장 lifecycle 실험에서는 등록된 파일을 갱신해도 이미 열린 문서와 SPA 이동은
기존 함수를 유지하고 전체 페이지 새로고침 후에 새 소스가 실행되는 것을 확인했다.
이는 최신 확장 버전과 현재 문서의 실행 버전이 다를 수 있음을 설명하지만,
사용자의 이번 광고 원인이라고 확정한 증거는 아니다.

### v1.9.1 최종 검사

실제 확장 설치 상태에서 제보 채널의 첫 접속과 새로고침을 다시 검사했다.
각각 15초 관찰했으며 두 경우 모두 설치 안내/광고 UI/광고 video 없이 1080p
본영상이 진행했다(27.525→42.666초, 28.057→43.204초). 실행 진단 revision은
1.9.1이고 설치/참조 확인 항목이 모두 true였다.

별도 fallback 시험은 실제 확장 전체를 설치한 시험이 아니라 production
`sites/chzzk.js`를 격리 페이지에 주입한 시험이다. 디스크 파일은 그대로 두고
메모리의 boolean 정책 처리 한 곳만 건너뛰어 첫 방어의 실패를 모사했다.
실제 정책 true/true가 유지된 상태에서 waterfalls 1, adPolicies 0이 기록됐고
1080p 본영상이 30.930→50.984초 진행했다. 광고 후보를 SDK가 받기 전에 빈 목록으로
바뀌었으며 광고 UI/설치 안내/페이지 오류가 없었다.

이 결과는 두 방어의 분리 검증이지 제보된 모든 광고 유형의 재현 또는 해결 보장이
아니다. 로그인·지역·광고 편성에 따른 차이와 장시간 중간광고는 계속 별도 확인이 필요하다.
단위·실제 Chromium 오프라인 검사는 24개 그룹을 통과했다. 기존 SOOP 15개,
추가 사이트 9개 및 전체 smoke/정적/Chromium 로드 검사도 통과했다.

### 출처 및 범위

이번 추가 분기는 공식 플레이어 소스와 정상 수신 응답을 근거로 독립 구현했다.
[List-KR 공식 배포 안내](https://github.com/List-KR/List-KR)와 공개 사용자 스크립트도
비교했지만, 새 원격 스크립트를 설치하거나 AGPL 사용자 스크립트 코드를 복사하지 않았다.
확장 권한과 기존 DNR 목록은 변경하지 않는다.

## v1.9.2 실제 탭 재발과 진단 한계 (2026-10-04)

제보 방송 `c0d9723cbb75dc223c6aa8a9d4f56002`의 사용자 Chrome 탭을
새로고침하거나 이동하지 않고 먼저 관찰했다. 설치 안내가 표시된 상태에서
본영상은 853×480, readyState 4, paused false, error 0이었다. 진단은
revision 1.9.1, filtering on, installed/active 네 항목 모두 true였고,
apiPatches 5, publicPlaybacks 0, adPolicies 1, waterfalls 0이었다.
최신 버전 미실행이라고 단정할 수 없는 사례다.

동일 방송의 격리된 새 Chromium에서 정상 수신 재생 정보는 공개·무료·방송 중
조건을 모두 만족했다. HLS/LLHLS 주소는 기존 허용 호스트
`nvelop-livecloud.pstatic.net`의 HTTPS/default port/`.m3u8`였고,
미디어와 각 두 트랙에 P2P 경로가 있었다. 실제 unpacked 1.9.1 확장으로
첫 접속·새로고침을 각각 10초 추가 관찰한 결과 설치 안내/광고 표시 없이
1080p 본영상이 28.78→38.83초, 28.18→38.24초 진행했다.
따라서 새 CDN이나 재생 구조 변경은 입증하지 못했다.

v1.9.2는 진단 보강판이며 이 사용자 탭 문제의 해결을 확정한 버전이 아니다.
기존 URL/공개 재생 범위를 유지하고, URL에 사용자명/비밀번호가 포함된 비정상
미디어 주소는 추가로 제외한다. 광고 처리와 확장 권한은 변경하지 않는다.

진단 schema 2에 playbackChecks 고정 카운터를 추가했다. candidates,
descriptorRejected, entitlementRejected, mediaShapeRejected, mediaUrlRejected,
mediaHostRejected, noP2pPaths, partiallyPatched, fullyPatched만 기록한다.
각 값은 1,000,000으로 제한하며 조건별로 한 후보당 최대 한 번 증가한다.
원본 주소·호스트·응답 값·권한 값·계정 정보는 포함하지 않는다. OFF나 reviver
호출은 기존처럼 통과시키며 추가 카운터도 갱신하지 않는다.

후보는 기존의 두 문자열 표식(p2pPath/playbackAuthType)을 포함한 파싱 결과이므로
일반적인 포장 응답도 후보로 세어질 수 있다. noP2pPaths는 적합한 미디어는 있으나
문자열 P2P 경로를 제거하지 못한 경우다. fullyPatched는 모든 미디어가 검사 조건을
통과했다는 뜻이지 실제 재생 성공의 증명이 아니다. 카운터는 문서 전체 누적값이며
SPA 이동 시 특정 방송의 값으로 단정하지 않는다. 호출 전 OFF 또는 다른 파싱 경로는
여전히 후보 0과 구분하지 못한다. 실제 영상의 해상도·진행·안내 표시를 함께 확인한다.

사용자의 문제가 난 탭은 변경하지 않았다. 새 코드를 적용하려면 사용자 측의
확장 다시 로드와 문서 새로고침이 필요하며, 재발할 경우 schema 2 진단을 먼저 읽는다.

### v1.9.2 검증

단위·실제 unpacked Chromium 오프라인 검사는 28개 그룹을 통과했다.
혼합 CDN/잘못된 미디어가 있는 형제 항목, 일부만 처리한 경우, 공개 재생 조건
누락·권한 제한, URL 사용자 정보, 한 후보 내 중복 거절 카운트, 비문자열 P2P,
OFF/reviver/표식 미일치 통과 및 고정 진단 스키마를 검사했다.
기존 SOOP 15개·추가 사이트 9개·전체 smoke·정적 검사도 통과했다.

새 임시 프로필에 실제 1.9.2 확장을 로드한 같은 방송의 첫 접속·새로고침에서
각각 15초 추가 관찰했다. 두 경우 모두 안내/광고 UI/광고 video 없이 1920×1080
본영상이 28.688→43.758초, 27.123→42.200초 진행했고 페이지 오류가 없었다.
두 진단 모두 candidates 2, fullyPatched 2, 나머지 playbackChecks 0이었다.
이 결과는 격리 환경의 회귀 검사 통과이며 문제 사용자 탭에서의 해결 검증은 아니다.

## v1.9.3 추가 영상 CDN 재현 (2026-10-04)

사용자는 소규모 방송에서 안내가 뜨는 것 같다는 관찰과 함께
`df32d91dcd3282c997a616f8a7b74543`(이타eatha) 방송을 제보했다.
실제 사용자 탭은 페이지 이동·새로고침 없이 읽었으며 설치 안내가 있고 video가
없었다. revision 1.9.2, filtering on, installed/active 모두 true였고,
문서 누적 candidates 108, fullyPatched 96, mediaHostRejected 12였다.
다른 거절/부분 처리 항목은 모두 0이었다. 이 값은 여러 SPA 방송 이동을 포함하므로
12회를 현재 방송의 실패 횟수로 해석하지 않았다.

같은 방송을 별도의 새 Chromium에서 관찰한 결과 HLS·LLHLS 미디어 모두
`fcdn-livecloud.pstatic.net`을 사용했다. HTTPS, 기본 포트, 기존 `.m3u8` 주소였고
paidLive false, playbackAuthType NONE, contentType VIDEO, live.status STARTED였다.
각 미디어는 6개 트랙 중 2개에 문자열 P2P 경로가 있었고 일반 트랙 주소도 같은
호스트였다. 1.9.2 소스를 적용한 격리 실험에서 설치 안내가 보이고
publicPlaybacks 0, mediaHostRejected 1로 실패가 재현됐다.

따라서 1.9.3에서는 이 네 번째 관측 호스트 하나만 정확히 추가했다.
공개 재생 여부·주소·화질·토큰은 보존하며 임의 CDN 전체나 도메인 접미사를
포괄 허용하지 않는다. 시청자 수나 스트리머 등급에 따른 서버 배정 정책은
검증하지 않았으므로 소규모 방송만의 결함으로 일반화하지 않는다.
이는 고화질 설치 안내 문제이며 기존의 별도 광고 처리 경로를 바꾸지 않는다.

### 호스트 단일 차이 실험 및 실제 확장 검사

같은 1.9.3 소스를 메모리에서 고정하고 위 호스트 한 줄만 제외한 비교에서는
설치 안내가 재현되고 본영상 video가 없었다(publicPlaybacks 0, candidates 1,
mediaHostRejected 1). 원래 목록을 유지하면 안내 없이 1920×1080 본영상이
readyState 4로 재생됐다(publicPlaybacks 2, fullyPatched 2, 거절 0).
별도의 12초 진행 관찰에서도 시간 33.526→45.538초, 프레임 24→745로 증가했고
플레이어 오류·광고 UI가 없었다. 이 비교는 페이지에 사이트 처리 소스를 주입한
격리 실험이며 사용자의 Chrome을 변경한 것이 아니다.

이어 실제 unpacked 1.9.3 확장을 설치한 새 임시 프로필에서 같은 방송을
첫 접속·새로고침하고 각각 15초 추가 관찰했다. 두 경우 모두 설치 안내와
광고 UI/광고 video 없이 1920×1080 본영상이 진행했다. 첫 접속에서는 프레임
0→907로 증가했고, 새로고침에서는 시간 34.123→49.320초, 프레임 54→965로
증가했다. 두 경우 모두 fullyPatched 2, mediaHostRejected 0, 페이지 오류 0이었다.

단위·실제 Chromium fixture 검사는 29개 그룹을 통과했다. 새 호스트의 HLS/LLHLS,
기존→새 호스트→기존 전환, 경로·화질 보존, HTTP·유사 도메인·비표준 포트·URL
인증정보 제외를 검사했다. 사용자 탭은 읽기만 했으므로 설치된 확장/방송 페이지
새로고침은 별도로 필요하다. 모든 규모·지역·미래 서버 배정에 대한 보장은 아니다.

## 1차 출처와 코드 재사용

- [치지직 메인 번들](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-VdvK-ysl.js)
- [치지직 플레이어 번들](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-B7YwD4RF.js)
- [치지직 광고·전송 번들](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/vendor-rOHzekiX.js)

사이트가 공개 배포한 이 빌드와 정상 브라우저 응답을 분석한 기록이다.
사이트 번들을 확장에 복사하지 않았다. 치지직 부분은 제한된 독립 구현이며
기존 오픈소스 필터와 uBOL 번들의 버전·라이선스·범위를 변경하지 않았다.
