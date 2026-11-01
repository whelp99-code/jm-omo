#!/bin/bash
# 가짜 파일만 쓴다. 실제 비밀 파일은 열지 않는다.
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
tool=$root/safe-read.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' 'token-body' > "$tmp/api-token.txt"
printf '%s\n' 'challenge-body' > "$tmp/login-challenge.txt"
printf '%s\n' 'env-body' > "$tmp/.env"
printf '%s\n' 'upper-body' > "$tmp/TOKEN"
printf '%s\n' 'plain-body' > "$tmp/notes.txt"
ln -s "$tmp/api-token.txt" "$tmp/notes-link"
record=$tmp/record.txt

expect_refuse() {
  local name=$1
  shift
  local out code
  set +e
  out=$("$tool" "$@" 2>&1)
  code=$?
  set -e
  [[ $code == 2 && $out == refused ]] || {
    printf '%s\n' "fail $name code=$code out=$out" >&2
    exit 1
  }
  [[ $out != *body* ]] || { printf '%s\n' "fail $name printed contents" >&2; exit 1; }
  printf '%s\n' "pass $name"
}

expect_refuse token "$tmp/api-token.txt"
expect_refuse challenge "$tmp/login-challenge.txt"
expect_refuse dotenv "$tmp/.env"
expect_refuse upper "$tmp/TOKEN"
expect_refuse symlink "$tmp/notes-link"

out=$("$tool" "$tmp/notes.txt")
[[ $out == plain-body ]] || { printf '%s\n' "fail plain out=$out" >&2; exit 1; }
printf '%s\n' 'pass plain'

set +e
out=$("$tool" --record "$record" --allow-name "$tmp/api-token.txt" "$tmp/api-token.txt" 2>&1)
code=$?
set -e
[[ $code == 0 && -z $out && $(cat "$record") == "allowed-name $tmp/api-token.txt" ]] || {
  printf '%s\n' "fail exception code=$code out=$out record=$(cat "$record" 2>/dev/null || true)" >&2
  exit 1
}
printf '%s\n' 'pass exception'
printf '%s\n' 'safe-read 7 passed'
