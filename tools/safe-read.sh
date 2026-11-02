#!/bin/bash
# 비밀·인증 파일 읽기 가드. 패턴이 있으면 내용을 출력하지 않고 거부한다.
# --allow-name은 그 정확한 경로만 예외로 열고, 내용은 출력하지 않은 채 기록만 남긴다.
set -euo pipefail

allows=()
record=${SAFE_READ_LOG:-}
while [[ $# -gt 0 ]]; do
  case $1 in
    --allow-name)
      [[ $# -ge 2 && -n $2 ]] || { printf '%s\n' 'refused' >&2; exit 2; }
      allows+=("$2")
      shift 2
      ;;
    --record)
      [[ $# -ge 2 && -n $2 ]] || { printf '%s\n' 'refused' >&2; exit 2; }
      record=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf '%s\n' 'refused' >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done
[[ $# -eq 1 && -n $1 ]] || { printf '%s\n' 'refused' >&2; exit 2; }
requested=$1

sensitive() {
  local lower
  lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  local pattern
  for pattern in secret token credential password otp totp challenge .env private-key id_rsa api_key apikey api-key id_ed25519 id_ecdsa id_dsa creds secrets keychain cookie; do
    [[ $lower == *"$pattern"* ]] && return 0
  done
  local suffix
  for suffix in .pem .key .p12; do
    [[ $lower == *"$suffix" || $lower == *"$suffix/"* ]] && return 0
  done
  return 1
}

allowed_exact() {
  local item
  for item in "${allows[@]}"; do
    [[ $item == "$1" ]] && return 0
  done
  return 1
}

targets=("$requested")
if [[ -L $requested || -e $requested ]]; then
  resolved=$(readlink -f "$requested" 2>/dev/null || true)
  if [[ -n $resolved && $resolved != "$requested" ]]; then
    targets+=("$resolved")
  fi
fi

exception=0
for target in "${targets[@]}"; do
  sensitive "$target" || continue
  if allowed_exact "$target"; then
    exception=1
    continue
  fi
  printf '%s\n' 'refused' >&2
  exit 2
done

if [[ $exception == 1 ]]; then
  [[ -n $record ]] || { printf '%s\n' 'refused' >&2; exit 2; }
  printf '%s\n' "allowed-name $requested" >> "$record"
  exit 0
fi

[[ -f $requested && ! -L $requested ]] || { printf '%s\n' 'refused' >&2; exit 2; }
cat -- "$requested"
