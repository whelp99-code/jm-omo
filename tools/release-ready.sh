#!/bin/bash
# 반영 확인. 루프백 수신, 바인드 주소, 기대 커밋 cwd를 본 뒤에만 응답을 판정한다.
# 준비 전 실패는 응답 실패가 아니다. 서비스를 재시작하거나 되돌리지 않는다.

release_ready() {
  local port=$1 expected=$2
  shift 2
  [[ $port =~ ^[0-9]+$ && -n $expected && $# -gt 0 ]] || {
    printf '%s\n' 'usage: release_ready PORT COMMIT COMMAND...' >&2
    return 2
  }
  local line addr bind_port pid cwd loopback=0 matched=0 saw=0
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    addr=${line%% *}
    line=${line#* }
    bind_port=${addr##*:}
    bind_port=${bind_port%]}
    [[ $bind_port == "$port" ]] || continue
    saw=1
    pid=${line%% *}
    cwd=${line#* }
    case $addr in
      127.0.0.1:*|\[::1\]:*|::1:*|0.0.0.0:*|\[::\]:*|\*:*)
        loopback=1
        if [[ $cwd == *"$expected"* ]]; then
          matched=1
        fi
        ;;
    esac
  done < <(_release_ready_listeners)
  if [[ $saw == 0 ]]; then
    printf '%s\n' 'not_ready'
    return 2
  fi
  if [[ $loopback == 0 ]]; then
    printf '%s\n' 'tailnet_only'
    return 2
  fi
  if [[ $matched == 0 ]]; then
    printf '%s\n' 'cwd_mismatch'
    return 2
  fi
  local status
  "$@" && status=0 || status=$?
  if [[ $status -eq 0 ]]; then
    printf '%s\n' 'response_ok'
    return 0
  fi
  printf '%s\n' 'response_fail'
  return "$status"
}

_release_ready_listeners() {
  if [[ -n ${RELEASE_READY_LISTENERS:-} ]]; then
    cat "$RELEASE_READY_LISTENERS"
    return
  fi
  ss -H -ltn -p | awk '
    {
      addr = $4
      pid = ""
      cwd = ""
      if (match($0, /pid=[0-9]+/)) {
        pid = substr($0, RSTART + 4, RLENGTH - 4)
        cmd = "readlink -f /proc/" pid "/cwd"
        cmd | getline cwd
        close(cmd)
      }
      print addr, pid, cwd
    }
  '
}
