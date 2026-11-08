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
if [[ $* == *off ]]; then
  exit 0
fi
if [[ -f ${TS_AFTER:-} ]]; then
  cp "$TS_AFTER" "$TS_STATUS"
fi
exit 0
EOF
chmod 755 "$fake"
export TAILSCALE=$fake TS_LOG=$tmp/log TS_STATUS=$tmp/status TS_AFTER=$tmp/after
wrap=$root/tailscale-public.sh
existing=$'https://host.ts.net:4180 (Funnel on)\n|-- / proxy http://127.0.0.1:3000\nhttps://host.ts.net:8787 (tailnet)\n|-- /tailnet proxy http://127.0.0.1:8787'

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

printf '%s\n' "$existing" > "$TS_STATUS"
printf '%s\n%s\n' "$existing" 'https://host.ts.net (Funnel on)' '|-- /health proxy http://127.0.0.1:443' > "$TS_AFTER"
: > "$TS_LOG"
out=$("$wrap" --allow /health -- funnel --bg --yes 443 /health)
[[ $out == public_ok ]] || { printf '%s\n' "fail kept out=$out" >&2; exit 1; }
grep -q ' off' "$TS_LOG" && { printf '%s\n' 'fail kept turned something off' >&2; exit 1; }
grep -q reset "$TS_LOG" && { printf '%s\n' 'fail kept used reset' >&2; exit 1; }
printf '%s\n' 'pass existing two plus allowed one kept'

printf '%s\n' "$existing" > "$TS_STATUS"
printf '%s\n%s\n' "$existing" 'https://host.ts.net:443 (Funnel on)' '|-- /secret proxy http://127.0.0.1:443' > "$TS_AFTER"
: > "$TS_LOG"
set +e
out=$("$wrap" --allow /health -- funnel --bg --yes 443 /health 2>&1)
code=$?
set -e
[[ $code == 2 && $out == *off:\ /secret* ]] || {
  printf '%s\n' "fail outside code=$code out=$out" >&2
  exit 1
}
grep -q 'funnel --https=443 --set-path=/secret off' "$TS_LOG" || { printf '%s\n' 'fail outside did not off only the new path' >&2; exit 1; }
grep -q reset "$TS_LOG" && { printf '%s\n' 'fail outside used reset' >&2; exit 1; }
grep -q ' off' "$TS_LOG" && grep -v '/secret off' "$TS_LOG" | grep -q ' off' && {
  printf '%s\n' 'fail outside turned off an existing path' >&2
  exit 1
}
printf '%s\n' 'pass new disallowed path off only'

printf '%s\n' $'https://host.ts.net:443 (Funnel on)\n|-- /health proxy https://127.0.0.1:3000' > "$TS_STATUS"
printf '%s\n' $'https://host.ts.net:443 (Funnel on)\n|-- /health proxy https://127.0.0.1:3000' > "$TS_AFTER"
: > "$TS_LOG"
out=$("$wrap" --allow /health -- funnel --set-path=/health localhost:3000)
[[ $out == public_ok ]] || { printf '%s\n' "fail set-path backend out=$out" >&2; exit 1; }
grep -q ' off' "$TS_LOG" && { printf '%s\n' 'fail set-path backend turned a path off' >&2; exit 1; }
printf '%s\n' 'pass set-path with backend is not a new path'

printf '%s\n' $'https://host.ts.net:443 (Funnel on)\n|-- /health proxy http://127.0.0.1:443' > "$TS_STATUS"
printf '%s\n%s\n' $'https://host.ts.net:443 (Funnel on)\n|-- /health proxy http://127.0.0.1:443' '|-- /he.lth proxy http://127.0.0.1:443' > "$TS_AFTER"
: > "$TS_LOG"
set +e
out=$("$wrap" --allow /health -- funnel --bg --yes 443 /health 2>&1)
code=$?
set -e
[[ $code == 2 && $out == *off:\ /he.lth* ]] || { printf '%s\n' "fail regex path code=$code out=$out" >&2; exit 1; }
grep -q 'funnel --https=443 --set-path=/he.lth off' "$TS_LOG" || { printf '%s\n' 'fail dotted path was treated as already present' >&2; exit 1; }
printf '%s\n' 'pass dotted path is not a regex match'
printf '%s\n' 'tailscale-public 5 passed'
