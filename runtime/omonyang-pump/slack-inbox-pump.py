import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

STATE = Path(os.environ["OMO_STATE"])
DB = os.environ["OMO_DB"]
OMO = "/home/jm/.bun/bin/bun"
OMO_JS = "/home/jm/.bun/install/global/node_modules/omo-ai/bin/omo.js"
SESSION_IDS = [s for s in os.environ.get("OMO_RPC_SESSIONS", "rpc-1,rpc-2,rpc-3,rpc-4").split(",") if s]
OWNER = "U0B833NMP5J"
BOT = "U0C4SUMDD98"
COLLEAGUES = {"U0C97QLUFUG", "U0C5ZSW32SF", "U0CA5755GAE", "U0C4SUMDD98", "U0C5WPFDJJD", "U0B81F5GR6V"}
FRESH_MS = 21_600_000
OWNER_DM_MAX_MS = 604_800_000
REPEAT_MS = 900_000


QUARANTINE_SCHEMA = """
CREATE TABLE IF NOT EXISTS omonyang_quarantine (
  kind TEXT NOT NULL CHECK(kind IN ('event','work')),
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  PRIMARY KEY(kind, subject_id)
);
CREATE TRIGGER IF NOT EXISTS omonyang_quarantine_immutable_update
  BEFORE UPDATE ON omonyang_quarantine
  BEGIN SELECT RAISE(ABORT, 'immutable quarantine provenance'); END;
CREATE TRIGGER IF NOT EXISTS omonyang_quarantine_immutable_delete
  BEFORE DELETE ON omonyang_quarantine
  BEGIN SELECT RAISE(ABORT, 'immutable quarantine provenance'); END;
"""


def ensure_quarantine():
    db = sqlite3.connect(DB, timeout=8)
    try:
        db.executescript(QUARANTINE_SCHEMA)
        db.commit()
    finally:
        db.close()


def quarantined_ids():
    ensure_quarantine()
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=8)
    try:
        try:
            rows = db.execute("select subject_id from omonyang_quarantine where kind='event'").fetchall()
        except sqlite3.OperationalError:
            return set()
    finally:
        db.close()
    return {row[0] for row in rows}


def omo(*args, timeout=120):
    try:
        r = subprocess.run([OMO, OMO_JS, "host", "session", *args, "--json"],
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    lines = (r.stdout or "").strip().splitlines()
    if not lines:
        return None
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return None


def is_busy(state):
    if not state:
        return True
    lc = state.get("lifecycle") or {}
    if lc.get("state") == "done":
        return False
    return state.get("isStreaming") is True or lc.get("runActive") is True


def idle_sessions():
    out = []
    for sid in SESSION_IDS:
        d = omo("state", sid, timeout=25)
        if d and not is_busy(d.get("state")):
            out.append(sid)
    return out


def pending_events():
    skip = quarantined_ids()
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=8)
    try:
        rows = db.execute(
            "select id, received, payload from events where state in ('pending','processing') order by received limit 60"
        ).fetchall()
    finally:
        db.close()
    now = int(time.time() * 1000)
    out = []
    for event_id, received, payload in rows:
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if event.get("subtype"):
            continue
        if event_id in skip:
            continue
        user = event.get("user")
        if event.get("bot_id") and user not in COLLEAGUES:
            continue
        age = now - (received or now)
        text = event.get("text") or ""
        is_dm = event.get("channel_type") == "im" and user == OWNER
        is_mention = "app_mention" in str(event.get("type")) or f"<@{BOT}>" in text
        if is_dm and age <= OWNER_DM_MAX_MS:
            out.append((event_id, age, True))
        elif is_mention and age <= FRESH_MS:
            out.append((event_id, age, False))
    return out


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    events = pending_events()
    if not events:
        print("OK no-pending")
        return

    marker = STATE / "rpc-pump-last"
    sent = {}
    if marker.exists():
        for line in marker.read_text().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].isdigit():
                sent[parts[0]] = int(parts[1])

    now = int(time.time() * 1000)
    todo = [(e, a, d) for e, a, d in events
            if not (sent.get(e) is not None and now - sent[e] < REPEAT_MS)]
    if not todo:
        print(f"OK recently_pushed pending={len(events)}")
        return

    idle = idle_sessions()
    if not idle:
        print(f"SKIP all_sessions_busy pending={len(todo)}")
        return

    launched = 0
    for event_id, age, is_dm in todo:
        if launched >= len(idle):
            break
        sid = idle[launched]
        kind = "DM" if is_dm else "멘션"
        delay = f" ({age // 60000}분 지연)" if age > FRESH_MS else ""
        prompt = (
            f"슬랙 {kind} {event_id}{delay} 이 아직 미처리야. "
            f"inbox.mjs take {event_id} 로 원문을 확인하고, 원문이 온 대화에 최종 답변을 올려. "
            f"접수 답장만으로 끝내지 마."
        )
        result = omo("prompt", sid, prompt, timeout=90)
        if not result or result.get("disposition") != "started":
            print(f"FAILED {event_id} session={sid} result={result}")
            break
        sent[event_id] = now
        launched += 1
        print(f"PUMPED {event_id} dm={is_dm} age_s={age // 1000} session={sid}")

    marker.write_text("".join(f"{k} {v}\n" for k, v in list(sent.items())[-120:]))
    print(f"BATCH launched={launched} idle={len(idle)} pending={len(todo)}")


main()
