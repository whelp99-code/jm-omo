#!/usr/bin/env python3
"""FP5 non-sensitive status snapshot for the 10-minute progress check.

Reads each product session's own JSONL log (read-only) and writes, per product:
phase (todo Now), next (todo Next), last tool name + time + success/failure,
last log write time, and a coarse state. No command bodies, tool arguments,
business data or secrets are copied.
"""
from __future__ import annotations

import glob
import json
import os
import re
import time
from datetime import datetime, timezone, timedelta
from typing import TypedDict


class ToolMark(TypedDict, total=False):
    tool: str | None
    at: str | None
    ok: bool


class Row(TypedDict, total=False):
    product: str
    state: str
    phase: str | None
    next_or_blocker: str | None
    last_tool: ToolMark | None
    last_log_write: str | None
    idle_seconds: int

KST = timezone(timedelta(hours=9))
SESSIONS = {
    "JARVIS": "01a10bbd-a4e1-7be1-96d7-ee1b19fa0c08",
    "SB": "01a0e309-6387-7507-be52-e0c47393ad9a",
    "Price": "01a10bb8-6dc2-7421-b18d-3d621946866f",
    "CRM": "01a0edaa-c20c-73ec-8989-35ff6a10dacd",
    "Mail": "01a10bb7-9d72-7f6f-a526-dd34fa15ba00",
}
OUT_DIR = os.path.expanduser("~/.local/state/omonyang")
NOW_RE = re.compile(r"^Now:\s*(.+)$", re.M)
NEXT_RE = re.compile(r"^Next:\s*(.+)$", re.M)


def kst(ts: str | float | None) -> str | None:
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, KST).strftime("%H:%M:%S")
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(KST).strftime("%H:%M:%S")
    except ValueError:
        return None


def latest_log(sid: str) -> str | None:
    files = glob.glob(os.path.expanduser(f"~/.omo/agent/sessions/*/*{sid}.jsonl"))
    return max(files, key=os.path.getmtime) if files else None


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
    return ""


def summarize(name: str, sid: str) -> Row:
    path = latest_log(sid)
    if not path:
        return {"product": name, "state": "NO_LOG"}
    mtime = os.path.getmtime(path)
    last_call: ToolMark | None = None
    last_result: ToolMark | None = None
    phase = nxt = None
    turn_open = False
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = e.get("message") or {}
            role = msg.get("role")
            ts = e.get("timestamp")
            if role == "assistant":
                calls = [x for x in (msg.get("content") or []) if isinstance(x, dict) and x.get("type") == "toolCall"]
                if calls:
                    last_call = {"tool": calls[-1].get("name"), "at": kst(ts)}
                    turn_open = True
                else:
                    turn_open = False
            elif role == "toolResult":
                body = text_of(msg.get("content"))
                last_result = {"tool": msg.get("toolName"), "at": kst(ts), "ok": not bool(msg.get("isError"))}
                if msg.get("toolName") == "todo":
                    m1, m2 = NOW_RE.search(body), NEXT_RE.search(body)
                    if m1:
                        phase = m1.group(1).strip()[:120]
                    if m2:
                        nxt = m2.group(1).strip()[:120]
            elif role == "user":
                turn_open = True
    idle = int(time.time() - mtime)
    if idle < 180:
        state = "RUNNING"
    elif turn_open:
        state = "WAITING_IN_TURN"
    else:
        state = "IDLE_TURN_ENDED"
    return {
        "product": name,
        "state": state,
        "phase": phase,
        "next_or_blocker": nxt,
        "last_tool": last_result or last_call,
        "last_log_write": kst(mtime),
        "idle_seconds": idle,
    }


def main() -> None:
    rows = [summarize(n, s) for n, s in SESSIONS.items()]
    stamp = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST")
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "fp5-status.json"), "w", encoding="utf-8") as fh:
        json.dump({"recorded_at": stamp, "products": rows}, fh, ensure_ascii=False, indent=1)
    lines = [f"# FP5 상태 기록 ({stamp})", "", "| 제품 | 상태 | 현재 단계 | 다음/막힘 | 마지막 도구(시각, 성공) | 마지막 기록 |", "|---|---|---|---|---|---|"]
    for r in rows:
        lt: ToolMark = r.get("last_tool") or {}
        ok = "" if "ok" not in lt else ("성공" if lt["ok"] else "실패")
        lines.append(
            f"| {r.get('product')} | {r.get('state')} | {r.get('phase') or '-'} | {r.get('next_or_blocker') or '-'} | "
            f"{lt.get('tool') or '-'} ({lt.get('at') or '-'}, {ok or '-'}) | {r.get('last_log_write') or '-'} |"
        )
    with open(os.path.join(OUT_DIR, "fp5-status.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("FP5_STATUS_WRITTEN", stamp)


if __name__ == "__main__":
    main()
