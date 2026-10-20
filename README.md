# jm-omo — 오모냥(대장) 운영 체계

오모냥은 BLRO 개발·운영을 지휘하는 OmO 세션(Claude Opus 5.5 high 고정)이다. 이 저장소는 그 세션이 쓰는 도구와 규칙을 모아 둔다. 실행 위치는 `/home/jm/.omo/omonyang` (herdr `w5:p1`); 여기 파일은 그 사본이다.

## 구조
| 경로 | 내용 |
|---|---|
| `fleet/fleet.mjs` | 냥이 장부와 지휘 도구. `init / status / report / dispatch / track / verify / tasks / watch` |
| `fleet/routes.json` | 작업 종류별 모델·스킬 기본값 (계획·설계 Astra/Fable, 구현 Sol 6.1/Grok 4.7, 검수 Astra, 보안·돈 Astra xhigh/Opus, 단순 Sonnet 5.5/Codex spark/Haiku) |
| `fleet/VICE-CAPTAIN.md` | 부대장(나희) 대행 런북: 시작 조건, 도구, 그대로인 규칙, 인계 |
| `runtime/` | Slack 수신(`slack-listen.mjs`)·수신함(`inbox.mjs`)·사용량 감시(`usage-watch.mjs`)·세션 상태 감시 |
| `ops/` | 다섯 제품 상태 수집(`fp5-status.py`)·정체 감시 |
| `bin/` | herdr 실행·인계·비밀 전달(tailnet 1회용 드롭) |
| `templates/` | 냥이 지시문 예시와 공통 규칙 |
| `plans/` | 운영 체계 계획(1단계 완료, 2단계 개선 9개) |
| `docs/` | 세션 홈 규칙 |

## 지휘 방식 (fleet)
- **장부**: `~/.local/state/omonyang/fleet.sqlite` — 냥이(창/봇), 작업(스킬·모델·완료 조건·증거·이력), 대장 heartbeat.
- **확인 전송**: 창이 비었는지 본 뒤 모델 전환 → 지시 입력 → 실제로 "Working"이 뜨는지 확인. 압축 실패로 지시가 사라지면 `PROMPT_LOST`.
- **의존 작업**: `dispatch ... --after <KEY>`는 선행 작업이 `verified-done`이고 대상 창이 idle일 때만 자동 전송한다.
- **주장 대조**: Cursor 승인과 `PR READY head=...`는 읽기 전용 Slack/GitHub 근거와 대조하며, 테스트 개수 주장은 검증 근거로 취급하지 않는다.
- **기계 완료**: `--done 'pr:owner/repo#N;url:http://..=200;cmd:<shell>'` 전부 통과해야 `verified-done`. 냥이의 "완료" 줄은 `done-claimed`일 뿐.
- **감시**: `fleet watch 30` — 상태 변화·완료/막힘 줄·PR READY·가재 recovery_hold/suppressed를 `FLEET_*` 이벤트로. 30초마다 `captain-heartbeat.json` 갱신.
- **대장·부대장**: heartbeat 30분 끊김 또는 대장 한도 소진 → 나희가 같은 장부로 대행 (`fleet/VICE-CAPTAIN.md`).

### Fleet configuration

`fleet/fleet.config.json` is loaded when `fleet.mjs` starts. Its `cats` array defines each cat's `id`, display `name`, `role`, `kind`, `pane`, and `product`; `fleet init` upserts these configured panes into the fleet database. The `slack` object holds `reviewChannel`, `cursorUserId`, and `reviewReplyAppId`. `agentMessengerCredentialPath` is the absolute path to the global agent-messenger Slack credential manager. `prLoop` holds the review thread, `enabled` and `autoMerge` kill switches (both default false), `mergePendingTimeoutMs`, `deployTimeoutMs`, a `mergeMethods` map keyed by repository with `merge`, `squash`, or `rebase` values, and an empty-by-default `deploy` map keyed by GitHub repository; each deploy entry has an `argv` array and `healthUrl`.

Draft PRs are automatically readied only when their Tests/Test Plan contains an executed summary with at least one pass and an explicit zero-failure count.

Environment overrides are `FLEET_CAT_<ID>_PANE` (for example, `FLEET_CAT_CRM_PANE`), `FLEET_SLACK_REVIEW_CHANNEL`, `FLEET_CURSOR_USER_ID`, `FLEET_REVIEW_REPLY_APP_ID`, `FLEET_AGENT_MESSENGER_CREDENTIAL_PATH`, `FLEET_PR_LOOP_ENABLED`, and `FLEET_PR_LOOP_AUTO_MERGE`.

Runtime consumers share the side-effect-free loader in `fleet/config.mjs`: Slack startup and hourly reports resolve the SDK beside the configured credential manager, review requests mention the configured Cursor user, and development reports use the configured review channel. The versioned credential path in JSON is an installation default, not a source-code dependency; override it after moving the SDK.

`usageWatch.catIds` selects registered cats to monitor (default: `gajae`); pane overrides apply there too. The obsolete unregistered `w1:p1` target is no longer monitored. The self-policy pane follows `omonyang`, and `SELF_POLICY_ENABLED` remains disabled. `usageWatch.orcaTerminals` holds installation-specific terminal IDs; override that list with a JSON string array in `FLEET_USAGE_ORCA_TERMINALS`.

```bash
cd fleet
bun fleet.mjs init
bun fleet.mjs dispatch crm TASK-X /path/TASK-X.txt --type impl --skill ulw --done 'pr:whelp99-code/ai-crm-project-manager#58'
bun fleet.mjs verify TASK-X
bun fleet.mjs close TASK-X "owner closed stale task"
bun fleet.mjs report
```

`fleet close <KEY> <reason>` manually closes a task, records the reason, releases its pane reservation, and removes it from the cat's active task slot. Closed tasks do not block later dispatches or appear in active PR polling.

## 지켜야 할 규칙 (요약)
- 머지 근거는 `fleet.config.json`에 지정된 Cursor 봇의 본인 글 ACCEPT/APPROVE만, head 고정 머지.
- 결재(돈·세무 전송·외부 발송·Notion 금액/상태)는 재민 직접 승인만.
- 비밀값은 출력·채팅 금지, 파일째 이동(0600). 새 봇 생성 금지. 오모냥 모델 변경 금지.
- 기계 확인은 최소 조건이고, 그 위에 독립 검수와 실사용 확인.
