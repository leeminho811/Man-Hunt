# Man Hunt — 휴대폰 GPS로 하는 진짜 술래잡기 웹사이트

친구들이 링크로 들어와 실제로 밖에서 뛰는 술래잡기를 돕는 사이트. 빌드 없는 정적 사이트, GitHub Pages(`main` 루트) →
https://leeminho811.github.io/Man-Hunt/ . 사용자용 안내는 README.md. 사용자는 한국어로 소통, UI 문구도 모두 한국어, 모바일 기준.

## 구조
- `logic.js` 순수 규칙 (Node 테스트에서도 로드): 방 상태, 모드(classic/zombie/cops), 자기장 `zone()`, 위치 공개 `revealK()`, 잡기/구출/승패, `summary()`.
- `app.js` Firebase(익명 인증 + Realtime Database) 동기화, GPS(watchPosition), Leaflet 지도(CARTO voyager 타일 → 실패하면 OpenStreetMap 타일, 🛰 버튼 = Esri 위성. 선택은 localStorage `mh_style`), 화면.
- 역할: `S` = 술래 편(술래/좀비/경찰), `H` = 숨는 편(숨는 사람/생존자/도둑). `orig` 은 시작할 때 역할(좀비 결과 표시용).

## 동기화
- HO’s Casino 와 **같은 Firebase 프로젝트·같은 보안 규칙** 을 쓴다 (규칙을 바꾸면 사용자가 ho-casino 콘솔에 다시 게시해야 하니 피할 것).
  - `rooms/HZ<CODE>/table` = `{j: JSON(state), t}` — 모든 기기가 `runTransaction` 으로 바꾼다 (호스트 기기가 깨어 있을 필요 없음).
  - `rooms/HZ<CODE>/req/<uid>` = `{j: JSON({lat,lng,acc,at,d,r}), t}` — 각자 자기 GPS 위치(본인만 쓰기 가능).
  - 사용자에게 보이는 코드는 6자, DB 방 이름은 `HZ`+코드(8자) → 카지노 방 코드(6·7자)와 안 겹침.
- 시간은 서버 시계(`.info/serverTimeOffset`). 숨는 시간·게임 끝·자기장 단계·위치 공개 시점은 시작 시각과 설정으로 계산(쓰기 없음).
  위치 공개 스냅샷(`pings`)과 게임 종료(`finish`)는 그 시점을 처음 본 기기가 트랜잭션으로 기록.
- 보이는 것: 같은 편은 실시간, 술래 편은 상대를 공개 시점 위치(+수동 핑, 1분 쿨다운)로만, 자기장 밖에 있는 사람은 모두에게 실시간.
  탈락한 사람(클래식)과 게임 끝은 전부 보임. 숨는 편은 가장 가까운 술래 편 거리만.
- 잡기: 술래 편 기기에서 상대 실시간 위치까지 거리 ≤ 잡기 거리면 CATCH 활성 → `doCatch`. GPS 오차 대비로 숨는 편의 “잡혔어요”(자진 신고).
- 데이터는 공개 읽기(로그인 사용자)라 기술적으로는 위치를 엿볼 수 있음 — 친구끼리 노는 용도라 허용.

## 테스트
- `npm test` (logic), `npm run test:e2e` (에뮬레이터 + Playwright 휴대폰 3대, 가짜 GPS). 프록시 환경에서는 `HTTPS_PROXY=undefined npx firebase emulators:exec …`.
  package.json 의 firebase 버전 = app.js 의 VERSION 유지 (테스트가 gstatic SDK 를 node_modules 파일로 바꿔 치기).
- `?sim` 연습 모드: 지도 클릭 = 내 위치 이동.
