#!/bin/bash
# 반영 대상 등록부. 운영 서비스는 부르지 않고, 대상을 고르거나 재시작하지 않는다.
# 같은 제품의 현재 대상 SHA가 둘이면 반영을 멈추고 하나를 고르지 않는다.
# 패키지 스모크가 비었거나 DB·데몬이 unavailable이면 활성화 후보에서 뺀다.

_activation_registry_rows() {
  local registry=$1 line product sha state
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    IFS=$'\t' read -r product sha state <<< "$line"
    [[ -n $product && -n $sha ]] || continue
    state=${state:-current}
    printf '%s\t%s\t%s\n' "$product" "$sha" "$state"
  done < "$registry"
}

_activation_current_products() {
  local registry=$1 product sha state
  local -A seen=()
  while IFS=$'\t' read -r product sha state; do
    [[ $state == current ]] || continue
    if [[ -z ${seen[$product]+x} ]]; then
      seen[$product]=1
      printf '%s\n' "$product"
    fi
  done < <(_activation_registry_rows "$registry")
}

_activation_current_shas() {
  local registry=$1 want=$2 product sha state
  local -A seen=()
  while IFS=$'\t' read -r product sha state; do
    [[ $state == current && $product == "$want" ]] || continue
    [[ -n ${seen[$sha]+x} ]] && continue
    seen[$sha]=1
    printf '%s\n' "$sha"
  done < <(_activation_registry_rows "$registry")
}

_activation_products_from_rows() {
  local rows=$1 product sha state
  local -A seen=()
  while IFS=$'\t' read -r product sha state; do
    [[ $state == current ]] || continue
    if [[ -z ${seen[$product]+x} ]]; then
      seen[$product]=1
      printf '%s\n' "$product"
    fi
  done <<< "$rows"
}

_activation_shas_from_rows() {
  local rows=$1 want=$2 product sha state
  local -A seen=()
  while IFS=$'\t' read -r product sha state; do
    [[ $state == current && $product == "$want" ]] || continue
    [[ -n ${seen[$sha]+x} ]] && continue
    seen[$sha]=1
    printf '%s\n' "$sha"
  done <<< "$rows"
}

_activation_field() {
  local file=$1
  [[ -f $file ]] || return 0
  tr -d '[:space:]' < "$file"
}

_activation_identity_fields() {
  local file=$1
  [[ -f $file ]] || return 0
  python3 - "$file" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
observer = data.get("observer") or {}
database = observer.get("database") or {}
daemon = data.get("daemon") or {}
print(database.get("status") or "")
print(daemon.get("status") or "")
print(daemon.get("reason") or "")
PY
}

_activation_evidence_reasons() {
  local dir=$1
  local smoke=$dir/cli-smoke.log
  local db daemon_status daemon_reason
  if [[ ! -s $smoke ]]; then
    printf '%s\n' empty-smoke
  fi
  if [[ -f $dir/runtime-identity.json ]]; then
    local fields
    fields=$(_activation_identity_fields "$dir/runtime-identity.json")
    db=$(printf '%s\n' "$fields" | sed -n '1p')
    daemon_status=$(printf '%s\n' "$fields" | sed -n '2p')
    daemon_reason=$(printf '%s\n' "$fields" | sed -n '3p')
  else
    db=$(_activation_field "$dir/db.status")
    daemon_status=$(_activation_field "$dir/daemon.status")
    daemon_reason=$(_activation_field "$dir/daemon.reason")
  fi
  [[ $db == unavailable ]] && printf '%s\n' db-unavailable
  if [[ $daemon_status == unavailable || $daemon_reason == unavailable ]]; then
    printf '%s\n' daemon-unavailable
  fi
}

activation_apply() {
  local registry=$1
  [[ -n ${registry:-} && -f $registry ]] || {
    printf '%s\n' 'usage: activation_apply REGISTRY' >&2
    return 2
  }
  local rows product shas count stopped=0
  rows=$(_activation_registry_rows "$registry")
  while IFS= read -r product; do
    [[ -n $product ]] || continue
    shas=$(_activation_shas_from_rows "$rows" "$product")
    count=$(printf '%s\n' "$shas" | grep -c .)
    if [[ $count -ne 1 ]]; then
      printf '%s\n' "conflict $product $(printf '%s\n' "$shas" | paste -sd ' ' -)"
      stopped=1
    fi
  done < <(_activation_products_from_rows "$rows")
  [[ $stopped == 0 ]] || return 2
  while IFS= read -r product; do
    [[ -n $product ]] || continue
    printf '%s\n' "apply $product $(_activation_shas_from_rows "$rows" "$product")"
  done < <(_activation_products_from_rows "$rows")
}

activation_candidates() {
  local registry=$1 evidence=$2
  [[ -n ${registry:-} && -f $registry && -n ${evidence:-} ]] || {
    printf '%s\n' 'usage: activation_candidates REGISTRY EVIDENCE' >&2
    return 2
  }
  local rows product shas count reasons reason_line
  rows=$(_activation_registry_rows "$registry")
  while IFS= read -r product; do
    [[ -n $product ]] || continue
    shas=$(_activation_shas_from_rows "$rows" "$product")
    count=$(printf '%s\n' "$shas" | grep -c .)
    if [[ $count -ne 1 ]]; then
      printf '%s\n' "excluded $product conflict $(printf '%s\n' "$shas" | paste -sd ' ' -)"
      continue
    fi
    reasons=$(_activation_evidence_reasons "$evidence/$product")
    if [[ -n $reasons ]]; then
      reason_line=$(printf '%s\n' "$reasons" | paste -sd ' ' -)
      printf '%s\n' "excluded $product $shas $reason_line"
      continue
    fi
    local db daemon_status
    if [[ -f $evidence/$product/runtime-identity.json ]]; then
      local fields
      fields=$(_activation_identity_fields "$evidence/$product/runtime-identity.json")
      db=$(printf '%s\n' "$fields" | sed -n '1p')
      daemon_status=$(printf '%s\n' "$fields" | sed -n '2p')
    else
      db=$(_activation_field "$evidence/$product/db.status")
      daemon_status=$(_activation_field "$evidence/$product/daemon.status")
    fi
    if [[ $db != available || $daemon_status != available ]]; then
      printf '%s\n' "excluded $product $shas not-available"
      continue
    fi
    printf '%s\n' "candidate $product $shas"
  done < <(_activation_products_from_rows "$rows")
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -euo pipefail
  cmd=${1:-}
  shift || true
  case $cmd in
    apply) activation_apply "$@" ;;
    candidates) activation_candidates "$@" ;;
    *)
      printf '%s\n' 'usage: activation-registry.sh apply REGISTRY | candidates REGISTRY EVIDENCE' >&2
      exit 2
      ;;
  esac
fi
