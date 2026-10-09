#!/usr/bin/env bash
# Resume wrapper for the 오모냥 OmO session. Do not start a second copy.
set -u
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
DIR="/home/jm/.omo/omonyang"
cd "$DIR"
LOG="$DIR/keepalive.log"
LOCK="$DIR/keepalive.pid"
if [ -f "$LOCK" ]; then
  old=$(cat "$LOCK" 2>/dev/null || true)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "$(date -Is) already running pid=$old" >> "$LOG"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

fail=0
while true; do
  start=$(date +%s)
  if [ ! -f "$DIR/prompt-delivered" ]; then
    echo "$(date -Is) first-launch" >> "$LOG"
    touch "$DIR/prompt-delivered"
    omo --name "오모냥" --approve @prompt.md "이 파일의 사용자 요청을 지금 그대로 수행해. 플랫폼은 사용자에게 물어본 뒤에만 정해. 봇 세팅 후 프로세스를 종료하지 말고 메신저 모니터를 유지한 채 대기해. 새 메시지는 agent-discord 로 보내지 말고 봇 명의로만 보내."
    code=$?
  else
    sid=""
    if [ -f "$DIR/session-id" ]; then
      sid=$(tr -d '[:space:]' < "$DIR/session-id")
    fi
    echo "$(date -Is) resume session=${sid:-unknown}" >> "$LOG"
    if [ -n "$sid" ]; then
      omo --name "오모냥" --session-id "$sid" --approve "플랫폼은 이미 Slack으로 정했다. 기존 agent-slackbot 봇과 구독을 그대로 유지하고, 플랫폼을 다시 묻거나 봇을 중복 생성하지 마라. /home/jm/.omo/omonyang/prompt.md 의 OmOMeow mode를 읽고 이어서 수행하라. 새 메시지는 기존 봇 명의로만 보내고 agent-discord 는 사용하지 마라. 현재 세션을 끊거나 Herdr에 병렬 봇을 만들지 마라."
      code=$?
    else
      omo --name "오모냥" --approve --continue "플랫폼은 이미 Slack으로 정했다. 기존 agent-slackbot 봇과 구독을 그대로 유지하고, 플랫폼을 다시 묻거나 봇을 중복 생성하지 마라. /home/jm/.omo/omonyang/prompt.md 의 OmOMeow mode를 읽고 이어서 수행하라. 새 메시지는 기존 봇 명의로만 보내고 agent-discord 는 사용하지 마라. 현재 세션을 끊거나 Herdr에 병렬 봇을 만들지 마라."
      code=$?
    fi
  fi
  dur=$(( $(date +%s) - start ))
  echo "$(date -Is) exit=$code dur=${dur}s" >> "$LOG"
  if [ "$dur" -lt 20 ]; then
    fail=$((fail + 1))
  else
    fail=0
  fi
  if [ "$fail" -ge 3 ]; then
    echo "$(date -Is) stop after 3 fast failures" >> "$LOG"
    exit 1
  fi
  sleep 5
done
