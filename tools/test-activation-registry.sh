#!/bin/bash
# 어제 기록된 대상만 쓴다. 운영 포트, DB, 데몬은 열지 않는다.
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=activation-registry.sh
source "$root/activation-registry.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mail_a=74e6957d630cab9c8dc3d54b01e429ebce136349
mail_b=375b983b6d84a050923962a7a97c21a6f4e6404f
gateway=a40f5f78c7146202cdcee493cc9badb11327f82c
sb=b0dfb090a63febea6d83257ec4613d77bd193122

printf '%s\t%s\t%s\n' \
  mail "$mail_a" current \
  mail "$mail_b" current \
  phone-gateway "$gateway" current \
  sb "$sb" current \
  > "$tmp/two-current.tsv"

set +e
out=$(activation_apply "$tmp/two-current.tsv")
code=$?
set -e
[[ $code == 2 && $out == "conflict mail $mail_a $mail_b" ]] || {
  printf '%s\n' "fail mail-two-current code=$code out=$out" >&2
  exit 1
}
printf '%s\n' "$out" | grep -q '^apply ' && {
  printf '%s\n' 'fail mail-two-current picked a target' >&2
  exit 1
}
printf '%s\n' 'pass mail-two-current stops apply'

mkdir -p "$tmp/evidence/phone-gateway" "$tmp/evidence/sb"
: > "$tmp/evidence/phone-gateway/cli-smoke.log"
[[ ! -s $tmp/evidence/phone-gateway/cli-smoke.log ]]
cat > "$tmp/evidence/phone-gateway/runtime-identity.json" <<'EOF'
{"observer":{"database":{"status":"unavailable"}},"daemon":{"status":"unknown","reason":"unavailable"}}
EOF
printf '%s\n' '4112 passed, 3 skipped, 1 deselected' > "$tmp/evidence/sb/cli-smoke.log"
printf '%s\n' available > "$tmp/evidence/sb/db.status"
printf '%s\n' available > "$tmp/evidence/sb/daemon.status"

out=$(activation_candidates "$tmp/two-current.tsv" "$tmp/evidence")
printf '%s\n' "$out" | grep -qx "excluded phone-gateway $gateway empty-smoke db-unavailable daemon-unavailable" || {
  printf '%s\n' "fail empty-cli-smoke out=$out" >&2
  exit 1
}
printf '%s\n' "$out" | grep -q "^candidate phone-gateway " && {
  printf '%s\n' 'fail empty-cli-smoke stayed a candidate' >&2
  exit 1
}
printf '%s\n' "$out" | grep phone-gateway | grep -q ready && {
  printf '%s\n' 'fail empty-cli-smoke treated as ready' >&2
  exit 1
}
printf '%s\n' "$out" | grep -q "^candidate mail " && {
  printf '%s\n' 'fail candidates picked one mail sha' >&2
  exit 1
}
printf '%s\n' "$out" | grep -qx "candidate sb $sb" || {
  printf '%s\n' "fail single-sha candidate missing out=$out" >&2
  exit 1
}
printf '%s\n' 'pass empty-cli-smoke excluded'
printf '%s\n' 'pass single current sha remains candidate'

mkdir -p "$tmp/empty-only/phone-gateway"
: > "$tmp/empty-only/phone-gateway/cli-smoke.log"
printf '%s\n' available > "$tmp/empty-only/phone-gateway/db.status"
printf '%s\n' available > "$tmp/empty-only/phone-gateway/daemon.status"
printf '%s\t%s\t%s\n' phone-gateway "$gateway" current > "$tmp/gateway-only.tsv"
out=$(activation_candidates "$tmp/gateway-only.tsv" "$tmp/empty-only")
printf '%s\n' "$out" | grep -qx "excluded phone-gateway $gateway empty-smoke" || {
  printf '%s\n' "fail empty-smoke-alone out=$out" >&2
  exit 1
}
printf '%s\n' "$out" | grep -q '^candidate ' && {
  printf '%s\n' 'fail empty-smoke-alone stayed a candidate' >&2
  exit 1
}
printf '%s\n' 'pass empty smoke alone excluded'

mkdir -p "$tmp/db-down/phone-gateway" "$tmp/daemon-down/phone-gateway"
printf '%s\n' 'smoke observed' > "$tmp/db-down/phone-gateway/cli-smoke.log"
printf '%s\n' unavailable > "$tmp/db-down/phone-gateway/db.status"
printf '%s\n' available > "$tmp/db-down/phone-gateway/daemon.status"
out=$(activation_candidates "$tmp/gateway-only.tsv" "$tmp/db-down")
printf '%s\n' "$out" | grep -qx "excluded phone-gateway $gateway db-unavailable" || {
  printf '%s\n' "fail db-unavailable out=$out" >&2
  exit 1
}
printf '%s\n' 'pass db unavailable excluded'

printf '%s\n' 'smoke observed' > "$tmp/daemon-down/phone-gateway/cli-smoke.log"
printf '%s\n' available > "$tmp/daemon-down/phone-gateway/db.status"
printf '%s\n' unknown > "$tmp/daemon-down/phone-gateway/daemon.status"
printf '%s\n' unavailable > "$tmp/daemon-down/phone-gateway/daemon.reason"
out=$(activation_candidates "$tmp/gateway-only.tsv" "$tmp/daemon-down")
printf '%s\n' "$out" | grep -qx "excluded phone-gateway $gateway daemon-unavailable" || {
  printf '%s\n' "fail daemon-unavailable out=$out" >&2
  exit 1
}
printf '%s\n' 'pass daemon unavailable excluded'

printf '%s\t%s\t%s\n' mail "$mail_a" current > "$tmp/one-mail.tsv"
set +e
out=$(activation_apply "$tmp/one-mail.tsv")
code=$?
set -e
[[ $code == 0 && $out == "apply mail $mail_a" ]] || {
  printf '%s\n' "fail single-apply code=$code out=$out" >&2
  exit 1
}
printf '%s\n' "$out" | grep -q "$mail_b" && {
  printf '%s\n' 'fail single-apply invented the other mail sha' >&2
  exit 1
}
mkdir -p "$tmp/mail-ok/mail"
printf '%s\n' 'tests 1063, pass 1063, fail 0' > "$tmp/mail-ok/mail/cli-smoke.log"
printf '%s\n' available > "$tmp/mail-ok/mail/db.status"
printf '%s\n' available > "$tmp/mail-ok/mail/daemon.status"
out=$(activation_candidates "$tmp/one-mail.tsv" "$tmp/mail-ok")
printf '%s\n' "$out" | grep -qx "candidate mail $mail_a" || {
  printf '%s\n' "fail mail-single-candidate out=$out" >&2
  exit 1
}
printf '%s\n' 'pass single mail sha stays candidate'

read_log=$tmp/registry-reads
: > "$read_log"
_activation_registry_rows() {
  printf 'x\n' >> "$read_log"
  local n
  n=$(wc -l < "$read_log" | tr -d '[:space:]')
  printf '%s\t%s\t%s\n' mail "$mail_a" current
  if [[ $n -ge 2 ]]; then
    printf '%s\t%s\t%s\n' mail "$mail_b" current
  fi
}
: > "$tmp/changing-registry.tsv"
set +e
out=$(activation_apply "$tmp/changing-registry.tsv")
code=$?
set -e
reads=$(wc -l < "$read_log" | tr -d '[:space:]')
[[ $reads == 1 && $code == 0 && $out == "apply mail $mail_a" ]] || {
  printf '%s\n' "fail snapshot reads=$reads code=$code out=$out" >&2
  exit 1
}
printf '%s\n' 'pass registry snapshot ignores a later sha'
printf '%s\n' 'activation-registry 8 passed'
