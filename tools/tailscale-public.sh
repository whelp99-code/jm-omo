#!/bin/bash
# 대상이 불명확한 tailscale funnel/serve 명령을 거부한다.
# 실행 뒤 새로 생긴 경로만 허용 목록과 비교하고, --set-path로 그 경로만 끈다.
# reset은 쓰지 않는다. 시험은 TAILSCALE로 가짜 명령을 넣는다.
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

collect_paths() {
  local port=443 line
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    if [[ $line =~ ^https=([0-9]+)[[:space:]]+(/[^[:space:]]*) ]]; then
      printf '%s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
      continue
    fi
    if [[ $line =~ ^https://[^[:space:]]+:([0-9]+) ]]; then
      port=${BASH_REMATCH[1]}
      continue
    fi
    if [[ $line =~ ^https://[^[:space:]:]+ ]]; then
      port=443
      continue
    fi
    if [[ $line =~ ^\|--[[:space:]]+(/[^[:space:]]*) ]]; then
      printf '%s %s\n' "$port" "${BASH_REMATCH[1]}"
    fi
  done
}

path_already() {
  local want=$1 line
  while IFS= read -r line; do
    [[ $line == "$want" ]] && return 0
  done <<< "$before"
  return 1
}

take_public_path() {
  local arg=$1
  if [[ $arg == --set-path=* ]]; then
    printf '%s\n' "${arg#--set-path=}"
    return 0
  fi
  if [[ $arg == /* ]]; then
    printf '%s\n' "$arg"
    return 0
  fi
  return 1
}

paths=()
pending_set_path=0
for arg in "$@"; do
  if [[ $pending_set_path == 1 ]]; then
    pending_set_path=0
    [[ $arg == /* ]] || { printf '%s\n' 'rejected: set-path requires a path' >&2; exit 2; }
    paths+=("$arg")
    if ! allowed "$arg"; then
      printf '%s\n' "rejected: $arg is outside the allowlist" >&2
      exit 2
    fi
    continue
  fi
  if [[ $arg == --set-path ]]; then
    pending_set_path=1
    continue
  fi
  if [[ $arg =~ ^[A-Za-z0-9._-]+:[0-9]+$ ]]; then
    continue
  fi
  path=$(take_public_path "$arg") || continue
  [[ $path == /* ]] || { printf '%s\n' 'rejected: set-path requires a path' >&2; exit 2; }
  paths+=("$path")
  if ! allowed "$path"; then
    printf '%s\n' "rejected: $path is outside the allowlist" >&2
    exit 2
  fi
done
if [[ $pending_set_path == 1 || ${#paths[@]} -eq 0 ]]; then
  printf '%s\n' 'rejected: funnel/serve target is only a port' >&2
  exit 2
fi

before=$(printf '%s\n' "$("$bin" "$mode" status)" | collect_paths)
"$bin" "$@"
after=$(printf '%s\n' "$("$bin" "$mode" status)" | collect_paths)
turned_off=0
while read -r port path; do
  [[ -n ${path:-} ]] || continue
  if path_already "$port $path"; then
    continue
  fi
  if allowed "$path"; then
    continue
  fi
  printf '%s\n' "off: $path is outside the allowlist" >&2
  "$bin" "$mode" --https="$port" --set-path="$path" off
  turned_off=1
done <<< "$after"
if [[ $turned_off == 1 ]]; then
  exit 2
fi
printf '%s\n' 'public_ok'
