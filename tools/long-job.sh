#!/bin/bash
# 10분을 넘길 수 있는 작업은 턴 셸이 아니라 이 스크립트의 사용자 유닛으로 띄운다.
# 운영 유닛은 고르지 않는다. 유닛 이름은 gajae-<이름>-<시각+고유값>만 만든다.
set -euo pipefail

usage() {
  printf '%s\n' \
    "usage: long-job.sh start <name> [--cwd DIR] [--tmpdir DIR] [--path PATH] -- <command...>" \
    "       long-job.sh status <unit>" >&2
}

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

state_dir="${HOME}/.local/state/gajae-jobs"
unit_re='^gajae-[A-Za-z0-9][A-Za-z0-9_-]{0,40}-[0-9]{8}T[0-9]{15}-[0-9a-f]{8}$'

die() {
  printf '%s\n' "$1" >&2
  exit 2
}

unit_base() {
  local unit=$1
  unit=${unit%.service}
  printf '%s\n' "$unit"
}

valid_name() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$ ]]
}

running_unit() {
  local name=$1 unit load active
  while read -r unit load active _; do
    [[ -n $unit ]] || continue
    unit=$(unit_base "$unit")
    if [[ $unit =~ ^gajae-${name}-[0-9]{8}T[0-9]{15}-[0-9a-f]{8}$ ]] \
      && [[ $active == active || $active == activating || $active == reloading ]]; then
      printf '%s\n' "$unit"
      return 0
    fi
  done < <(systemctl --user list-units --all --plain --no-legend --type=service "gajae-${name}-*" || true)
  return 1
}

show_prop() {
  local unit=$1 prop=$2
  systemctl --user show "$unit" -p "$prop" --value
}

create_exclusive() {
  local path=$1
  if ! (set -o noclobber; : >"$path") 2>/dev/null; then
    return 1
  fi
}

cmd_start() {
  local name=${1:-}
  shift || true
  valid_name "$name" || die "이름은 영문, 숫자, _, - 만 쓴다"
  local cwd=$PWD tmpdir=${TMPDIR:-} path=${PATH:-}
  while [[ $# -gt 0 ]]; do
    case $1 in
      --cwd)
        [[ $# -ge 2 ]] || die "--cwd 값이 없다"
        cwd=$2
        shift 2
        ;;
      --tmpdir)
        [[ $# -ge 2 ]] || die "--tmpdir 값이 없다"
        tmpdir=$2
        shift 2
        ;;
      --path)
        [[ $# -ge 2 ]] || die "--path 값이 없다"
        path=$2
        shift 2
        ;;
      --)
        shift
        break
        ;;
      *)
        die "알 수 없는 인자: $1"
        ;;
    esac
  done
  [[ $# -gt 0 ]] || die "명령이 없다"
  [[ -d $cwd ]] || die "작업 폴더가 없다: $cwd"
  local existing
  if existing=$(running_unit "$name"); then
    die "이미 실행 중: $existing"
  fi
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  local stamp unit log exitfile
  stamp="$(date +%Y%m%dT%H%M%S%N)-$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
  unit="gajae-${name}-${stamp}"
  log="${state_dir}/${unit}.log"
  exitfile="${state_dir}/${unit}.exit"
  if [[ -e $log || -e $exitfile ]]; then
    die "로그가 이미 있다: $log"
  fi
  create_exclusive "$log" || die "로그가 이미 있다: $log"
  if ! create_exclusive "$exitfile"; then
    rm -f "$log"
    die "로그가 이미 있다: $exitfile"
  fi
  local -a env_args=(--setenv="PATH=${path}" --setenv="GAJAE_JOB_EXIT=${exitfile}")
  if [[ -n $tmpdir ]]; then
    env_args+=(--setenv="TMPDIR=${tmpdir}")
  fi
  local run_err="${state_dir}/${unit}.systemd-run"
  if ! systemd-run --user \
    --unit="$unit" \
    --collect \
    --working-directory="$cwd" \
    "${env_args[@]}" \
    --property=Type=exec \
    --property="StandardOutput=append:${log}" \
    --property="StandardError=append:${log}" \
    -- "$BASH" -c 'ec=0; "$@" || ec=$?; printf "%s\n" "$ec" >"$GAJAE_JOB_EXIT"; exit "$ec"' \
    gajae-long-job "$@" >"$run_err" 2>&1; then
    cat "$run_err" >&2
    rm -f "$run_err"
    die "유닛을 띄우지 못했다: $unit"
  fi
  rm -f "$run_err"
  printf '%s %s\n' "$unit" "$log"
}

cmd_status() {
  local unit
  unit=$(unit_base "${1:-}")
  [[ $unit =~ $unit_re ]] || die "유닛 이름이 아니다"
  local log="${state_dir}/${unit}.log"
  local exitfile="${state_dir}/${unit}.exit"
  local active result code load
  load=$(show_prop "$unit" LoadState || true)
  active=$(show_prop "$unit" ActiveState || true)
  result=$(show_prop "$unit" Result || true)
  code=$(show_prop "$unit" ExecMainStatus || true)
  local state=exited exit_code=
  if [[ $active == active || $active == activating || $active == reloading ]]; then
    state=active
    exit_code=-
  elif [[ -f $exitfile ]]; then
    exit_code=$(tr -d '[:space:]' <"$exitfile")
  elif [[ $result == success ]]; then
    exit_code=0
  elif [[ -n $code && $code != 0 ]]; then
    exit_code=$code
  elif [[ $load == not-found || -z $load ]]; then
    exit_code=-
  else
    exit_code=${code:- -}
  fi
  printf '%s exit=%s\n' "$state" "$exit_code"
  if [[ -f $log ]]; then
    tail -n 5 "$log"
  fi
  if [[ $state == exited && $exit_code =~ ^[0-9]+$ ]]; then
    exit "$exit_code"
  fi
}

[[ $# -ge 1 ]] || { usage; exit 2; }
case $1 in
  start)
    shift
    cmd_start "$@"
    ;;
  status)
    shift
    [[ $# -eq 1 ]] || die "status는 유닛 하나"
    cmd_status "$1"
    ;;
  *)
    usage
    exit 2
    ;;
esac
