#!/bin/bash
# 가짜 tailscale로 공개 명령 가드를 시험한다. 실제 tailscale은 부르지 않는다.
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fake=$tmp/tailscale
cat > "$fake" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$TS_LOG"
if [[ ${2:-} == status ]]; then
  cat "$TS_STATUS"
  exit 0
fi
exit 0
EOF
chmod 755 "$fake"
export TAILSCALE=$fake TS_LOG=$tmp/log TS_STATUS=$tmp/status
wrap=$root/tailscale-public.sh

: > "$TS_LOG"
set +e
out=$("$wrap" --allow /health -- funnel --bg --yes 443 2>&1)
code=$?
set -e
[[ $code == 2 && $out == *only\ a\ port* && ! -s $TS_LOG ]] || {
  printf '%s\n' "fail port-only code=$code out=$out" >&2
  exit 1
}
printf '%s\n' 'pass port-only rejected'

printf '%s\n' '/health proxy http://127.0.0.1:443' > "$TS_STATUS"
: > "$TS_LOG"
out=$("$wrap" --allow /health -- funnel --bg --yes 443 /health)
[[ $out == public_ok ]] || { printf '%s\n' "fail allowed out=$out" >&2; exit 1; }
grep -q 'funnel --bg --yes 443 /health' "$TS_LOG" || { printf '%s\n' 'fail allowed did not run' >&2; exit 1; }
printf '%s\n' 'pass allowed path'

printf '%s\n' '/secret proxy http://127.0.0.1:443' > "$TS_STATUS"
: > "$TS_LOG"
set +e
out=$("$wrap" --allow /health -- funnel --bg --yes 443 /health 2>&1)
code=$?
set -e
[[ $code == 2 && $out == *off:\ /secret* ]] || {
  printf '%s\n' "fail outside code=$code out=$out" >&2
  exit 1
}
grep -q 'funnel reset' "$TS_LOG" || { printf '%s\n' 'fail outside did not reset' >&2; exit 1; }
printf '%s\n' 'pass outside allowlist reset'
printf '%s\n' 'tailscale-public 3 passed'
