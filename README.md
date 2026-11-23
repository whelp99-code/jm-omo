# jm-omo — 오모냥(대장) 운영 체계

오모냥은 BLRO 개발·운영을 지휘하는 OmO 세션(Claude Opus 5.5 high 고정)이다. 이 저장소는 그 세션이 쓰는 도구와 규칙을 모아 둔다. 실행 위치는 `/home/jm/.omo/omonyang` (herdr `w5:p1`); 여기 파일은 그 사본이다.

## 구조
| 경로 | 내용 |
|---|---|
| `fleet/fleet.mjs` | 창 분류 및 라우팅 조회. `dispatch`와 `verify`는 폐기 안내만 반환. |
| `fleet/routes.json` | 작업 종류별 모델·스킬 기본값 (계획·설계 Astra/Fable, 구현 Sol 6.1/Grok 4.7, 검수 Astra, 보안·돈 Astra xhigh/Opus, 단순 Sonnet 5.5/Codex spark/Haiku) |
| `fleet/VICE-CAPTAIN.md` | 폐기된 부대장 원장 런북의 기록. |
| `runtime/` | Slack 수신(`slack-listen.mjs`)·수신함(`inbox.mjs`)·사용량 감시(`usage-watch.mjs`)·세션 상태 감시 |
| `ops/` | 다섯 제품 상태 수집(`fp5-status.py`)·정체 감시 |
| `bin/` | herdr 실행·인계·비밀 전달(tailnet 1회용 드롭) |
| `templates/` | 냥이 지시문 예시와 공통 규칙 |
| `plans/` | 운영 체계 계획(1단계 완료, 2단계 개선 9개) |
| `docs/` | 세션 홈 규칙 |

## Fleet 작업 원장 폐기

2026-11-23에 작업 원장과 현황판을 폐기했다. 2026-11-10 이후 갱신되지 않았고, 냥이 14마리 중 12마리는 `unknown`, 작업 27건은 `blocked` 상태로 남아 있었다. `dispatch`와 `verify`는 기존 호출 호환을 위해 폐기 안내만 출력하고 종료한다. 작업을 보내거나 완료 처리하지 않는다.

### Fleet configuration

`fleet/fleet.config.json`의 `cats` 배열은 창과 냥이 매핑을 정의한다. `FLEET_CAT_<ID>_PANE`으로 창을 덮어쓸 수 있다. `fleet/config.mjs`는 원장을 열지 않고 설정을 불러온다. Slack 시작 및 시간별 보고는 설정된 SDK 경로를, 개발 보고는 `FLEET_SLACK_REVIEW_CHANNEL`을 사용한다. SDK 경로는 `FLEET_AGENT_MESSENGER_CREDENTIAL_PATH`로 덮어쓸 수 있다.

`usageWatch.catIds`는 사용량 감시 대상을 정한다(기본값 `gajae`). `FLEET_USAGE_ORCA_TERMINALS`는 터미널 ID의 JSON 배열이다. 오모냥의 `SELF_POLICY_ENABLED`는 꺼져 있다.

```bash
bun fleet/fleet.mjs routes
bun test
```

## 지켜야 할 규칙 (요약)
- 머지 근거는 `fleet.config.json`에 지정된 Cursor 봇의 본인 글 ACCEPT/APPROVE만, head 고정 머지.
- 결재(돈·세무 전송·외부 발송·Notion 금액/상태)는 재민 직접 승인만.
- 비밀값은 출력·채팅 금지, 파일째 이동(0600). 새 봇 생성 금지. 오모냥 모델 변경 금지.
- 기계 확인은 최소 조건이고, 그 위에 독립 검수와 실사용 확인.
- `tools/safe-read.sh`는 이름에 password가 있으면 `note-password-reset.md` 같은 문서도 거부한다. 열어야 하면 `--allow-name`에 그 정확한 경로를 준다. 예외는 내용을 출력하지 않고 기록만 남긴다.
