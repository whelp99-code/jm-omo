#!/usr/bin/env bash
# Run DETACHED (systemd-run --user): stopping omonyang.service kills the caller.
set -euo pipefail
DIR=/home/jm/.omo/omonyang
echo "$(date -Is) handoff start" >> "$DIR/handoff.log"
sleep 8
systemctl --user stop omonyang.service
systemctl --user disable omonyang.service
pkill -f "/home/jm/.omo/omonyang/slack-listen.mjs" || true
sleep 2
systemctl --user enable omonyang-herdr.service
bash "$DIR/bin/omonyang-herdr-launch.sh"
