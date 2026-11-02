#!/bin/bash
# 가짜 계획만 쓴다. 운영 DB는 열지 않는다.
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
tool=$root/plan-applied-check.mjs
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export TMPDIR=${TMPDIR:-$HOME/tg}

plan=$tmp/plan.json
python3 - <<PY
import json
from pathlib import Path
ids = [f"inv-{index:02d}" for index in range(1, 24)]
Path("$plan").write_text(json.dumps([
    {"id": item, "amount": 1, "customer": "CUSTOMER_MARKER"} for item in ids
], ensure_ascii=False), encoding="utf-8")
Path("$tmp/none.json").write_text("[]", encoding="utf-8")
Path("$tmp/all.json").write_text(json.dumps(ids), encoding="utf-8")
Path("$tmp/partial-plan.json").write_text(json.dumps(ids[:4]), encoding="utf-8")
Path("$tmp/partial-records.json").write_text(json.dumps([
    {"id": "inv-01", "amount": 9, "customer": "CUSTOMER_MARKER"},
    "inv-02",
    {"id": "extra-01", "amount": 3, "customer": "CUSTOMER_MARKER"},
]), encoding="utf-8")
PY

run_case() {
  local name=$1 expected_code=$2
  shift 2
  local out code
  set +e
  out=$(bun "$tool" "$@" 2>&1)
  code=$?
  set -e
  [[ $code == "$expected_code" && $out != *CUSTOMER_MARKER* && $out != *amount* ]] || {
    printf '%s\n' "fail $name code=$code" >&2
    exit 1
  }
  printf '%s\n' "$out" > "$tmp/out-$name"
  printf '%s\n' "pass $name"
}

run_case none 2 --plan "$plan" --query -- bun -e 'process.stdout.write("[]")'
grep -qx '계획 23' "$tmp/out-none"
grep -qx '있음 0' "$tmp/out-none"
grep -qx '없음 23' "$tmp/out-none"
grep -qx '격리 0' "$tmp/out-none"

run_case all 0 --plan "$plan" --records "$tmp/all.json"
grep -qx '계획 23' "$tmp/out-all"
grep -qx '있음 23' "$tmp/out-all"
grep -qx '없음 0' "$tmp/out-all"
grep -qx '격리 0' "$tmp/out-all"

run_case partial 2 --plan "$tmp/partial-plan.json" --records "$tmp/partial-records.json"
grep -qx '계획 4' "$tmp/out-partial"
grep -qx '있음 2' "$tmp/out-partial"
grep -qx '없음 2' "$tmp/out-partial"
grep -qx '격리 1' "$tmp/out-partial"
grep -qx '없음 inv-03' "$tmp/out-partial"
grep -qx '없음 inv-04' "$tmp/out-partial"
grep -qx '격리 extra-01' "$tmp/out-partial"
printf '%s\n' 'plan-applied-check 3 passed'
