# Fleet

`config.mjs` loads cat and pane settings from `fleet.config.json` with environment overrides.
`pane-classification.mjs` parses herdr screen text without I/O.
`fleet.mjs` exposes pane lookup and reading, classification, and the `routes` CLI.
Legacy `dispatch` and `verify` callers receive a retirement notice; they do not send or verify work.

Run `bun test` from the repository root.
