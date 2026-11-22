# runtime

**Score:** 9 (distinct domain: live session watchers). 24 files here plus `fixtures/` and `omonyang-pump/`, code ratio 100%, 66 `export` lines, no package entry.

## OVERVIEW

Bun ESM watchers and pumps for the live 오모냥 session. This tree is a copy; the running home is `/home/jm/.omo/omonyang`.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Slack listen | `slack-listen.mjs` | Imports `Inbox`, `accept`, `processIdentity`, `guardParent` from `inbox.mjs` |
| Inbox | `inbox.mjs` | Crash is replay/reconcile, never inferred completion |
| Usage | `usage-watch.mjs`, `usage-policy.mjs` | `SELF_POLICY_ENABLED` is `false`. Fleet config comes from `../fleet/config.mjs` |
| Hourly / dev report | `hourly.mjs`, `development-report.mjs` | Stamps are `Asia/Seoul`. Report cap `REPORT_LIMIT=3500` |
| Recovery | `fleet-recovery*.mjs` | Stage A and store are separate modules; do not fold them into `fleet/fleet.mjs` |
| Approval token | `owner-approval.mjs` | `approvalAccepted` only |
| Session watch | `session-watch.mjs`, `session-state-watch.sh`, `session-table.py` | Read-only. Never send |
| Keepalive | `keepalive.sh` | Lock file `keepalive.pid`. One copy |
| Pumps | `omonyang-pump/` | In-tree copies. The shell execs `/home/jm/.local/lib/omonyang/slack-inbox-pump.py`, not the sibling `.py` |
| Test preloads | `fixtures/*-preload.mjs` | Spawned by `routing.test.mjs`, not imported as a library |

## CONVENTIONS

- No `index.mjs`. Callers import the file they need. `slack-listen.mjs`, `hourly.mjs`, `usage-watch.mjs`, and `development-report.mjs` are libraries; shebang CLIs are `fleet-recovery.mjs` and `bot-response-watchdog.mjs`.
- Tests are colocated `*.test.mjs` using `bun:test`. `routing.test.mjs` spawns the preload with a temp `HOME`.
- Several scripts hard-code `/home/jm/.omo/omonyang`, `/home/jm/.local/state/omonyang`, and `/home/jm/.local/bin/herdr`. Those are install paths, not repo-relative paths.
- `ops/fp5-stall-watch.sh` does not call `ops/fp5-status.py`. It calls `/home/jm/.omo/omonyang/.omo/requests/fp5-status.py`.

## ANTI-PATTERNS

- Do not start a second `keepalive.sh`. The lock exits 0 if the pid is alive.
- Do not send Slack or Discord from `session-state-watch.sh`, `session-table.py`, or `session-watch.mjs`. Never forward terminal text; previews can hold tokens.
- Do not treat a usage lookup failure as 0% idle. Do not switch this session to another model, and do not return to Opus on usage headers alone.
- Do not retry a failed or uncertain post from the recovery scripts. Log it.
- Do not set `SELF_POLICY_ENABLED` true to "enable" the self pane. The flag stays disabled; the self pane follows cat `omonyang`.

## COMMANDS

```bash
bun test runtime/routing.test.mjs runtime/slack-listen.test.mjs runtime/fleet-recovery.test.mjs runtime/bot-response-watchdog.test.mjs
```

No package script. README names these files and does not give a dev command.
