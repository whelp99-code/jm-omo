#!/bin/bash
# 대상이 불명확한 tailscale funnel/serve 명령을 거부한다.
# 실행 뒤 공개 경로가 허용 목록과 다르면 바로 끈다. 시험은 TAILSCALE로 가짜 명령을 넣는다.
set -euo pipefail

bin=${TAILSCALE:-tailscale}
allows=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --allow)
      [[ $# -ge 2 && $2 == /* ]] || { printf '%s\n' 'rejected: allow path required' >&2; exit 2; }
      allows+=("$2")
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      printf '%s\n' 'usage: tailscale-public.sh --allow /path -- funnel|serve ...' >&2
      exit 2
      ;;
  esac
done
[[ ${#allows[@]} -gt 0 && $# -gt 0 ]] || { printf '%s\n' 'rejected: command or allowlist missing' >&2; exit 2; }
mode=$1
[[ $mode == funnel || $mode == serve ]] || { printf '%s\n' 'rejected: not funnel or serve' >&2; exit 2; }

allowed() {
  local path=$1 item
  for item in "${allows[@]}"; do
    [[ $item == "$path" ]] && return 0
  done
  return 1
}

paths=()
for arg in "$@"; do
  [[ $arg == /* ]] || continue
  paths+=("$arg")
  if ! allowed "$arg"; then
    printf '%s\n' "rejected: $arg is outside the allowlist" >&2
    exit 2
  fi
done
if [[ ${#paths[@]} -eq 0 ]]; then
  printf '%s\n' 'rejected: funnel/serve target is only a port' >&2
  exit 2
fi

"$bin" "$@"

status=$("$bin" "$mode" status)
published=()
while IFS= read -r line; do
  [[ $line =~ (^|[[:space:]])(/[^[:space:]]+) ]] || continue
  published+=("${BASH_REMATCH[2]}")
done <<< "$status"
if [[ ${#published[@]} -eq 0 ]]; then
  printf '%s\n' 'rejected: public status has no path' >&2
  "$bin" "$mode" reset
  exit 2
fi
for path in "${published[@]}"; do
  if ! allowed "$path"; then
    printf '%s\n' "off: $path is outside the allowlist" >&2
    "$bin" "$mode" reset
    exit 2
  fi
done
printf '%s\n' 'public_ok'
