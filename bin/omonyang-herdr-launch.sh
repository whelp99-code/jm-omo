#!/usr/bin/env bash
set -euo pipefail
DIR=/home/jm/.omo/omonyang
LOG=$DIR/handoff.log
if pgrep -f "omo-balance-router.ts --name 오모냥|senpi/dist/bundle/cli.js.*--name 오모냥" >/dev/null; then
  echo "$(date -Is) launch skipped: 오모냥 already running" >> "$LOG"
  exit 0
fi
for _ in $(seq 1 60); do herdr workspace list >/dev/null 2>&1 && break; sleep 2; done
SID=$(tr -d '[:space:]' < "$DIR/session-id")
PANE=$(herdr workspace list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=JSON.parse(s).result.workspaces.find(w=>w.label==="오모냥");console.log(w?w.workspace_id+":p1":"")})')
if [ -z "$PANE" ]; then
  PANE=$(herdr workspace create --cwd "$DIR" --label 오모냥 --no-focus | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi
herdr pane run "$PANE" "bash $DIR/recovery-20261004/run-isolated.sh"
echo "$(date -Is) launched in herdr pane=$PANE sid=$SID" >> "$LOG"
