#!/usr/bin/env bash
# Every 5 min: print CHANGE lines when a session's state changes. Never sends messages.
D=/home/jm/.omo/omonyang
prev=""
while true; do
  cur=$(python3 "$D/session-table.py" --state 2>/dev/null | sed -E 's/ \| .*//; s/ [0-9]+\/[0-9]+$//')
  if [ -n "$prev" ] && [ -n "$cur" ] && [ "$cur" != "$prev" ]; then
    diff <(echo "$prev") <(echo "$cur") | grep '^>' | sed 's/^> /CHANGE /'
  fi
  [ -n "$cur" ] && prev="$cur"
  sleep 300
done
