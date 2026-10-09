#!/usr/bin/env python3
"""Build a progress table of live OmO sessions (webchat, herdr, Orca) from their session files.

Usage: session-table.py            -> print the table text
       session-table.py --state    -> print one STATE line per session (for change detection)
Reads only; never sends messages.
"""
import glob
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

SESSIONS = "/home/jm/.omo/agent/sessions"
WEBCHAT_STATE = "/home/jm/.local/state/omo-webchat/state-v2.json"
SELF_ID = "01a0e130-e01b-7941-95da-1931cf45f94f"
RECENT_S = 8 * 3600


def sh(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return ""


def surfaces():
    where = {}
    try:
        st = json.load(open(WEBCHAT_STATE))
        for c in st.get("chats", {}).values():
            where.setdefault(c.get("durableSessionId"), []).append(f"웹챗 '{c.get('name')}'")
    except Exception:
        pass
    try:
        for a in json.loads(sh(["herdr", "agent", "list"]))["result"]["agents"]:
            where.setdefault("cwd:" + a.get("cwd", ""), []).append(f"herdr {a.get('pane_id')}")
    except Exception:
        pass
    try:
        for t in json.loads(sh(["orca", "terminal", "list", "--json"]))["result"]["terminals"]:
            if (t.get("title") or "").startswith("OmO"):
                where.setdefault("cwd:" + (t.get("worktreePath") or ""), []).append("Orca")
    except Exception:
        pass
    return where


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(p.get("text", "") for p in content or [] if isinstance(p, dict) and p.get("type") == "text")


def summarize(path):
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    cwd, sid = "", ""
    for x in lines[:5]:
        try:
            e = json.loads(x)
        except Exception:
            continue
        if e.get("type") == "session":
            cwd, sid = e.get("cwd", ""), e.get("id", "")
    now_task, overall, ask, last_ts = "", "", "", ""
    pending_calls, asking = set(), False
    for x in lines:
        try:
            e = json.loads(x)
        except Exception:
            continue
        m = e.get("message")
        if not isinstance(m, dict):
            continue
        last_ts = e.get("timestamp") or last_ts
        role = m.get("role")
        if role == "user":
            t = text_of(m.get("content")).strip()
            if t and not t.startswith(("[Answer to question", "<")):
                ask = t.splitlines()[0]
        elif role == "assistant":
            for p in m.get("content") or []:
                if isinstance(p, dict) and p.get("type") == "toolCall":
                    pending_calls.add(p.get("id"))
                    if p.get("name") in ("AskUserQuestion", "ask_user_question"):
                        asking = True
        elif role == "toolResult":
            pending_calls.discard(m.get("toolCallId"))
            if m.get("toolName") in ("AskUserQuestion", "ask_user_question"):
                asking = False
            if m.get("toolName") == "todo":
                t = text_of(m.get("content"))
                mm = re.search(r"^Now: (.+)$", t, re.M)
                if mm:
                    now_task = mm.group(1).strip()
                mo = re.search(r"^Overall: (\d+)/(\d+) done", t, re.M)
                if mo:
                    overall = f"{mo.group(1)}/{mo.group(2)}"
    try:
        age = time.time() - datetime.fromisoformat(last_ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        age = time.time() - os.path.getmtime(path)
    if asking:
        status = "❓답변대기"
    elif pending_calls or age < 300:
        status = "🔄진행중"
    elif now_task.startswith("none"):
        status = "✅완료"
    else:
        status = "💤멈춤"
    return {"sid": sid, "cwd": cwd, "status": status, "now": now_task, "overall": overall,
            "ask": ask, "age": age, "mtime": os.path.getmtime(path)}


def rows():
    where = surfaces()
    out = []
    for f in glob.glob(f"{SESSIONS}/*/*.jsonl"):
        if time.time() - os.path.getmtime(f) > RECENT_S or SELF_ID in f:
            continue
        s = summarize(f)
        cwd = str(s["cwd"])
        places = where.get(str(s["sid"]), []) + where.get("cwd:" + cwd, [])
        if not places:
            continue
        s["project"] = os.path.basename(cwd.rstrip("/")) or cwd
        s["where"] = ", ".join(dict.fromkeys(places))
        out.append(s)
    out.sort(key=lambda s: -s["mtime"])
    return out


def clip(t, n):
    t = re.sub(r"\s+", " ", t or "").strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def table():
    rs = rows()
    stamp = time.strftime("%m-%d %H:%M")
    lines = [f"**📋 세션 진행표** (갱신 {stamp} KST, 10분마다 자동 갱신)", ""]
    for i, s in enumerate(rs, 1):
        ago = int(s["age"] // 60)
        prog = f" · {s['overall']}" if s["overall"] else ""
        lines.append(f"**{i}. {s['project']}** — {s['status']}{prog} · {ago}분 전 · {s['where']}")
        lines.append(f"　지금: {clip(s['now'].split(' (')[0] if s['now'] else '-', 90)}")
        lines.append(f"　요청: {clip(s['ask'], 90)}")
    if not rs:
        lines.append("열려 있는 세션 없음")
    return "\n".join(lines)[:1990]


if __name__ == "__main__":
    if "--state" in sys.argv:
        for s in rows():
            print(f"STATE {s['project']} {s['status']} {s['overall']} | {clip(s['now'], 60)}")
    else:
        print(table())
