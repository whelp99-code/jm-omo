# fleet

**Score:** 10 (distinct domain: ledger CLI). Files 6, one fixture subdir, code ratio 100%, own JSON config, 58 exports in `fleet.mjs`, 47 symbols imported by `fleet.test.mjs`.

## OVERVIEW

Bun ESM ledger and dispatch CLI for 냥이 panes. Done is machine-checked; a worker "완료" line is only `done-claimed`.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| CLI | `fleet.mjs` | `import.meta.main`; `init status report dispatch track verify tasks watch close` |
| Config load | `config.mjs` | Side-effect-free. Runtime imports `loadFleetConfig` from here, not from `fleet.mjs` |
| Cats, Slack, prLoop | `fleet.config.json` | Env overrides win; booleans are the string `"true"` only |
| Model/skill defaults | `routes.json` | Captain model is `fixed: true` |
| Vice-captain runbook | `VICE-CAPTAIN.md` | Same ledger; not a second schema |
| Completion fixtures | `fixtures/completion/` | Plain-text task prompts |

## CONVENTIONS

- Importing `fleet.mjs` is not free: top level `mkdirSync`s `~/.local/state/omonyang` and opens `fleet.sqlite` (WAL, `busy_timeout=10000`). Tests set `process.env.HOME` to a temp dir before the dynamic import, then restore it. Extra workers bust the module cache with `./fleet.mjs?worker=...`.
- Seams are default parameters (`runCommand`, `fetchImpl`, `dbHandle`, `sleep`), not a container.
- `--done 'pr:owner/repo#N;url:http://..=200;cmd:<shell>'` must all pass for `verified-done`. `--after <KEY>` sends only when the predecessor is `verified-done` and the pane is idle.
- `prLoop.enabled` and `prLoop.autoMerge` default false. Draft PRs are readied only when Tests/Test Plan has an executed summary, at least one pass, and an explicit zero-failure count.

## ANTI-PATTERNS

- Do not import `fleet.mjs` from runtime code. Use `config.mjs`. A live import writes the operator ledger.
- Do not treat a test count, a "완료" line, or `done-claimed` as completion.
- Do not add a `package.json` bin. Dispatch is the `process.argv` map under `import.meta.main`.

## COMMANDS

```bash
cd fleet
bun fleet.mjs init
bun fleet.mjs dispatch <cat> <KEY> /path/TASK.txt --type impl --skill ulw --done 'pr:owner/repo#N'
bun fleet.mjs verify <KEY>
bun fleet.mjs close <KEY> "reason"
bun test fleet.test.mjs
```

`bun test` is the runner (`bun:test`). README does not name it. Set `HOME` away from the operator home before any import of `fleet.mjs`.
