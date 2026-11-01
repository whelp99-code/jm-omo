#!/bin/bash
# release_ready의 네 경우. 운영 포트는 열지 않는다.
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=release-ready.sh
source "$root/release-ready.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
probe=$tmp/probe
cat > "$probe" <<'EOF'
#!/bin/bash
printf '%s\n' ran >> "$PROBE_MARK"
exit "${PROBE_CODE:-0}"
EOF
chmod 755 "$probe"

run_case() {
  local name=$1 listeners=$2 commit=$3 want_code=$4 want_text=$5 code
  : > "$tmp/mark"
  set +e
  out=$(RELEASE_READY_LISTENERS="$listeners" PROBE_MARK="$tmp/mark" release_ready 4382 "$commit" "$probe")
  code=$?
  set -e
  [[ $code == "$want_code" && $out == "$want_text" ]] || {
    printf '%s\n' "fail $name code=$code out=$out" >&2
    exit 1
  }
  if [[ $want_text != response_ok && $want_text != response_fail && -s $tmp/mark ]]; then
    printf '%s\n' "fail $name judged the response early" >&2
    exit 1
  fi
  printf '%s\n' "pass $name"
}

printf '%s\n' '' > "$tmp/empty"
run_case not_ready "$tmp/empty" abcdef12 2 not_ready

printf '%s\n' '100.64.0.8:4382 9 /srv/releases/abcdef12' > "$tmp/tailnet"
run_case tailnet_only "$tmp/tailnet" abcdef12 2 tailnet_only

printf '%s\n' '127.0.0.1:4382 9 /srv/releases/ffff0000' > "$tmp/other"
run_case cwd_mismatch "$tmp/other" abcdef12 2 cwd_mismatch

printf '%s\n' '127.0.0.1:4382 9 /srv/releases/abcdef12' > "$tmp/ok"
run_case normal "$tmp/ok" abcdef12 0 response_ok
[[ $(cat "$tmp/mark") == ran ]] || { printf '%s\n' 'fail normal did not judge the response' >&2; exit 1; }
printf '%s\n' '127.0.0.1:5999 9 /srv/releases/abcdef12' > "$tmp/fail"
set +e
out=$(RELEASE_READY_LISTENERS="$tmp/fail" release_ready 5999 abcdef12 false)
code=$?
set -e
[[ $code == 1 && $out == response_fail ]] || {
  printf '%s\n' "fail response_fail code=$code out=$out" >&2
  exit 1
}
printf '%s\n' 'pass response_fail'

for addr in '0.0.0.0:5999' '*:5999' '[::]:5999'; do
  printf '%s\n' "$addr 9 /srv/releases/abcdef12" > "$tmp/wild"
  set +e
  out=$(RELEASE_READY_LISTENERS="$tmp/wild" PROBE_MARK="$tmp/mark" release_ready 5999 abcdef12 "$probe")
  code=$?
  set -e
  [[ $code == 0 && $out == response_ok ]] || {
    printf '%s\n' "fail wildcard $addr code=$code out=$out" >&2
    exit 1
  }
done
printf '%s\n' 'pass wildcard bind'

printf '%s\n' 'release-ready 6 passed'
