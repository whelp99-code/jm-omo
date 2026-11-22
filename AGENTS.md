# PROJECT KNOWLEDGE BASE

**Generated:** 2026-11-21T13:21:36Z
**Commit:** 139ff0c
**Branch:** main

## OVERVIEW

Copy of the live Omonyang session at `/home/jm/.omo/omonyang` (herdr `w5:p1`). Bun scripts watch Slack, recover sessions, and record fleet work in SQLite. No `package.json`, lockfile, or Makefile.

## STRUCTURE

```
jm-omo/
├── fleet/       # ledger CLI; side-effecting fleet.mjs vs side-effect-free config.mjs
├── runtime/     # live-session watchers, inbox, usage, recovery
├── tools/       # shell/py/mjs helpers sourced by tools/test-*.sh
├── scripts/     # omonyang-recovery.py only
├── ops/         # in-tree fp5-status.py is not what live stall watch calls
├── bin/         # herdr handoff, launch, secret-drop.ts
├── templates/   # common-rules.md, TASK-example-migrate.txt
├── plans/       # dated 2026-10 notes, not current code policy
└── docs/        # session-home-AGENTS.md only
```

Child files: `fleet/AGENTS.md` (score 10), `runtime/AGENTS.md` (score 9). Do not copy the Memory or Self-improvement sections into children.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Dispatch, verify, close, report | `fleet/fleet.mjs` | `#!/usr/bin/env bun`. Importing it mkdir's state and opens SQLite. |
| Config without side effects | `fleet/config.mjs` | `resolveFleetConfig`, `loadFleetConfig`. |
| Ledger path | `~/.local/state/omonyang/fleet.sqlite` | Machine-checked done lives here. |
| Session watch, inbox, usage | `runtime/*.mjs` | Shebangs: `fleet-recovery.mjs`, `bot-response-watchdog.mjs`, `keepalive.sh`. |
| Libraries | `runtime/slack-listen.mjs`, `inbox.mjs`, `hourly.mjs`, `usage-watch.mjs`, `development-report.mjs` | |
| Usage policy flag | `runtime/usage-policy.mjs` | `SELF_POLICY_ENABLED` is the constant `false`. README says it stays disabled. |
| Secrets | `bin/secret-drop.ts` | Do not log secret values. |
| Shared memory | `/home/jm/.local/lib/dori-guard/bot-memory.py` | See Memory below. |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `fleet.mjs` | CLI entry | `fleet/fleet.mjs` | Opens SQLite; mkdir state dir on import. |
| `resolveFleetConfig` / `loadFleetConfig` | export | `fleet/config.mjs` | Side-effect-free config. |
| `SELF_POLICY_ENABLED` | const `false` | `runtime/usage-policy.mjs` | Must stay disabled. |

Env overrides: `FLEET_CAT_<ID>_PANE`, `FLEET_SLACK_REVIEW_CHANNEL`, `FLEET_CURSOR_USER_ID`, `FLEET_REVIEW_REPLY_APP_ID`, `FLEET_AGENT_MESSENGER_CREDENTIAL_PATH`, `FLEET_PR_LOOP_ENABLED`, `FLEET_PR_LOOP_AUTO_MERGE`, `FLEET_USAGE_ORCA_TERMINALS` (JSON string array). Boolean env is `"true"` only.

Done signal: `--done 'pr:…;url:…;cmd:…'` all pass → `verified-done`. Worker completion text is `done-claimed`.

## CONVENTIONS

- Runner is Bun. Tests are `bun:test`.
- README command block is `cd fleet` plus `bun fleet.mjs init|dispatch|verify|close|report`. Structure table also names `status`, `tasks`, `watch`.
- Search history with `bot-memory` before answering from memory. If the answer is not there, answer from source, then `remember`.

## ANTI-PATTERNS (THIS PROJECT)

- No second keepalive.
- Session watchers never send and never forward terminal text.
- Failed or uncertain posts are not retried.
- Usage lookup failure is not 0% idle.
- Do not auto-switch this session's model.
- Do not log secret values (`bin/secret-drop.ts`).
- Do not treat `plans/*.md` "do not" lines as live fleet rules. They are older notes (no new customer ledger; voice alone does not approve payment).
- Importing `fleet.mjs` is not a pure read. Use `fleet/config.mjs` for config without side effects.

## UNIQUE STYLES

- Machine-checked done is the ledger state `verified-done`, not worker prose.
- This tree is a copy of the live session, not a package with its own install step.

## COMMANDS

```bash
cd fleet && bun fleet.mjs init|dispatch|verify|close|report
bun test fleet/fleet.test.mjs
bun test runtime/*.test.mjs
# tools/: sourced by tools/test-*.sh
bot-memory search "<topic>"
bot-memory search "<topic>" --t2
bot-memory remember "<topic>"   # body from stdin
bot-memory recent
```

## NOTES

- `plans/`, `tools/`, `scripts/`, `ops/`, `bin/`, `templates/`, `docs/`, and fixture dirs scored below the file threshold. Parent covers them. No child AGENTS.md there.
- Live stall watch does not call in-tree `ops/fp5-status.py`.
- `scripts/omonyang-recovery.py` is 586 lines and the only file in `scripts/`.

## Memory: one command, shared by every bot

`bot-memory` reads and writes the shared dev-wiki, so anything recorded by Dori, Dinobot or Gajae is visible here and the reverse holds too.

    bot-memory search "<topic>"        ranked hits, internal notes excluded
    bot-memory search "<topic>" --t2   include internal notes
    bot-memory remember "<topic>"      reads the body from stdin
    bot-memory recent                   what other bots recorded lately

Search before answering anything that depends on history. When the answer is not there, answer from the source and then `remember` what you learned.

Path: `/home/jm/.local/lib/dori-guard/bot-memory.py`.

## Self-improvement

When a task reveals that these rules produced a wrong answer, revise this file in the same turn. A rule that has never been corrected is a rule nobody checked.
