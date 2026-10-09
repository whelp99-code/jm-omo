#!/usr/bin/env bash
# Every 60s: refresh the non-sensitive FP5 status record, then print one FP5_STALL line
# per product whose session log has not been written for 10+ minutes (real idle, not the board label).
S="${SENPI_MONITOR_STATE_DIR:-/tmp/fp5-stall-watch}"; mkdir -p "$S"
J="$HOME/.local/state/omonyang/fp5-status.json"
while true; do
  python3 /home/jm/.omo/omonyang/.omo/requests/fp5-status.py >/dev/null 2>&1
  python3 - "$J" "$S" <<'EOF'
import json, os, sys
data = json.load(open(sys.argv[1]))
state_dir = sys.argv[2]
for row in data["products"]:
    flag = os.path.join(state_dir, row["product"] + ".sent")
    idle = row.get("idle_seconds", 0)
    if idle < 600:
        if os.path.exists(flag):
            os.remove(flag)
        continue
    if not os.path.exists(flag):
        open(flag, "w").close()
        print(f"FP5_STALL {row['product']} {row['state']} idle={idle // 60}min next={row.get('next_or_blocker') or '-'}", flush=True)
EOF
  sleep 60
done
