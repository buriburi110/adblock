# KoreanList+EasyList 데이터 고지

다음 세 파일은 KoreanList+EasyList 필터 목록을 이 확장 프로그램에서 사용할 수 있도록 변환한 파생 데이터다.

- `easylist.json`: Chrome 정적 DNR 네트워크 규칙
- `cosmetic-generic.css`: 예외와 무관한 범용 요소 숨김 규칙
- `cosmetic-specific.json`: 조건부 범용·도메인별 선택자와 요소 숨김 예외 인덱스

- 원본 저작자 표기: The EasyList authors, <https://easylist.to/>
- 원본 목록: <https://easylist-downloads.adblockplus.org/v3/full/koreanlist+easylist.txt>
- 라이선스: GNU GPL v3 이상 또는 Creative Commons Attribution-ShareAlike 3.0 이상
- 라이선스 안내: <https://easylist.to/pages/licence.html>
- 이 프로젝트가 위 파생 데이터에 선택한 라이선스: CC BY-SA 3.0 이상

이 사본은 설치된 오픈소스 AdBlock 6.44.0.1에 포함된 KoreanList+EasyList snapshot을 연구 기준선으로 사용했다. 네트워크 원본 56,068개 중 `block`, `allow`, `allowAllRequests` 56,058개를 유지했으며, 리다이렉트 7개와 응답 헤더 변경 3개는 안전성과 독립성을 위해 제거했다.

요소 숨김 데이터는 표준 CSS로 표현 가능한 `##` 규칙과 `#@#` 예외를 중심으로 변환했다. 예외와 무관한 범용 선택자 13,360개는 CSS로, 조건부 범용 선택자 301개와 도메인별 참조 16,701개 및 예외 참조 658개는 호스트별 JSON 인덱스로 생성했다. 호스트 단위 `$generichide` 예외 182개를 반영하며, 일반 CSS로 안전하게 표현할 수 없는 확장 `#?#` 274개와 procedural selector·scriptlet은 포함하지 않았다.

변환 과정에서 필터 구문을 분류하고, 지원하지 않는 동작과 선택자를 제외하고, 선택자 목록을 범용·조건부·도메인별 데이터로 재구성했다. 정확한 원본 버전, 가져온 시각, 원본·출력 SHA-256 및 변환 통계는 `easylist.metadata.json`에 기록한다. AdBlock의 프로그램 코드, 이름, 아이콘, UI 문구와 브랜드 자산은 세 파생 파일에 포함하지 않았다.
