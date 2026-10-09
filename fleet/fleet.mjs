#!/usr/bin/env bun
// 오모냥 fleet: registry of every 냥이 (worker pane / bot), verified dispatch, machine-checked done, watch.
// Ideas taken from Dori (lane registry, verified pane send, Done= signals) and Gajae (accepted != done, no blind re-run).
import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";

const STATE = `${process.env.HOME}/.local/state/omonyang`;
mkdirSync(STATE, { recursive: true });
const db = new Database(`${STATE}/fleet.sqlite`);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
CREATE TABLE IF NOT EXISTS cats(id TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT, pane TEXT, product TEXT, state TEXT, model TEXT, task TEXT, last_seen TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS tasks(key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT, done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT, result TEXT, evidence TEXT, history TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS beats(who TEXT PRIMARY KEY, at TEXT, detail TEXT);`);

const now = () => new Date().toISOString();
const sh = async (cmd) => (await Bun.$`bash -c ${cmd}`.nothrow().quiet()).stdout.toString();
const read = (pane) => sh(`herdr pane read ${pane} --source visible --format text 2>/dev/null`);
const ROUTES = JSON.parse(await Bun.file(new URL("./routes.json", import.meta.url)).text());

const CATS = [
  ["omonyang", "오모냥", "대장: 계획·배분·확인", "captain", "w5:p1", "-"],
  ["nahee", "나희", "부대장: 대장 대행, 지원", "vice", "-", "-"],
  ["seoyun", "서윤", "감시·Cursor 검수 전달", "bot", "-", "-"],
  ["cursor", "Cursor 봇", "독립 검수(ACCEPT/REVISE)", "bot", "-", "-"],
  ["gajae", "가재", "서버 이전·인프라 실행", "bot", "w1:p3", "-"],
  ["jarvis", "JARVIS 냥", "JARVIS 개발", "pane", "wC:p1", "Orca-JARVIS"],
  ["sb", "SB 냥", "Second Brain 개발", "pane", "w2:p1", "second-brain-app"],
  ["crm", "CRM 냥", "CRM(core5) 개발", "pane", "w6:p1", "ai-crm-project-manager"],
  ["price", "Price 냥", "Price 개발", "pane", "wD:p1", "price-ai-tax"],
  ["mail", "Mail 냥", "Mail 개발", "pane", "wE:p1", "mail-intelligence"],
  ["jarvis2", "JARVIS 보조 냥", "JARVIS 보조(압축 문제로 휴식)", "pane", "wK:p1", "Orca-JARVIS"],
];

export function classify(screen) {
  const L = screen.split("\n");
  const tail = L.slice(-14).join("\n");
  const footer = [...screen.matchAll(/(?:⚡|\([a-z-]+\)|\s)\s*([a-z][A-Za-z0-9._-]+):(low|medium|high|xhigh|minimal|off)\s*$/gm)].at(-1);
  const model = footer ? `${footer[1]}:${footer[2]}` : "";
  let state = "idle";
  if (/compaction did not complete/i.test(tail) && !/Working \(/.test(tail)) state = "compaction-failed";
  else if (/Compacting/i.test(tail)) state = "compacting";
  else if (/Working \(|Running eval|esc to interrupt/.test(tail)) state = "working";
  else if (/Question pending|unanswered/i.test(tail)) state = "question";
  else if (/Codex error|rate limit|usage limit|429|quota|Unable to verify/i.test(tail)) state = "provider-error";
  const done = [...screen.matchAll(/(TASK-[A-Z0-9-]+)_(DONE|BLOCKED)\b([^\n]*)/g)].filter((m) => !/[<]|또는|_BLOCKED reason=<|<숫자/.test(m[0])).at(-1);
  const ready = [...screen.matchAll(/\b([A-Z]+) PR READY head=([0-9a-f]{40})/g)].at(-1);
  // Result lines wrap in narrow panes: also look at the joined tail.
  const joined = L.slice(-40).map((l) => l.trim()).join(" ");
  const readyLine = [...joined.matchAll(/\b([A-Z]+_[A-Z_]*READY)\b([^❯─]{0,400})/g)].at(-1);
  return { state, model, done: done ? { key: done[1], kind: done[2], text: done[3].trim().slice(0, 200) } : null, ready: ready ? { repo: ready[1], head: ready[2] } : null, readyLine: readyLine ? `${readyLine[1]}${readyLine[2]}`.replace(/\s+/g, " ").trim().slice(0, 300) : null };
}

function log(task, ev) {
  const t = db.query("SELECT history FROM tasks WHERE key=?").get(task);
  if (!t) return;
  const h = JSON.parse(t.history || "[]");
  h.push({ at: now(), ...ev });
  db.query("UPDATE tasks SET history=? WHERE key=?").run(JSON.stringify(h.slice(-40)), task);
}

async function init() {
  const up = db.query("INSERT INTO cats(id,name,role,kind,pane,product,state) VALUES(?,?,?,?,?,?,'unknown') ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, kind=excluded.kind, pane=excluded.pane, product=excluded.product");
  for (const c of CATS) up.run(...c);
  await refresh();
}

async function refresh() {
  const out = [];
  for (const c of db.query("SELECT * FROM cats WHERE pane!='-'").all()) {
    const s = classify(await read(c.pane));
    db.query("UPDATE cats SET state=?, model=?, last_seen=? WHERE id=?").run(s.state, s.model, now(), c.id);
    out.push({ ...c, ...s });
  }
  return out;
}

// Owner C0C6HJM0BV5:1791553182.735709: watch Claude/Codex usage so limits never stop development.
// Claude quota is shared with the captain, so cats only fall back to it while it is low.
async function usage() {
  const tick = (await sh(`grep USAGE_TICK /home/jm/.omo/omonyang/usage-watch.log | tail -1`)).trim();
  const pct = (k) => Number(tick.match(new RegExp(`${k}=(\\d+)%`))?.[1] ?? 0);
  return { anthropic: pct("anthropic"), chatgpt: pct("chatgpt-subscription") };
}

async function pickModel(type) {
  const r = ROUTES.models[type];
  if (!r) throw new Error(`unknown task type ${type}; use ${Object.keys(ROUTES.models).join("|")}`);
  const u = await usage();
  const hot = (p) => (p.startsWith("chatgpt") && u.chatgpt >= 80) || (p.startsWith("anthropic") && u.anthropic >= 60);
  for (const c of [r, r.alt, r.alt2, ROUTES.cursorFallback].filter(Boolean)) if (!hot(c.provider)) return { ...c, usage: u };
  return { ...ROUTES.cursorFallback, usage: u };
}

async function switchModel(pane, want) {
  const before = classify(await read(pane)).model;
  if (before.startsWith(want.model)) return `MODEL_OK ${want.model}`;
  // Verified sequence: open the picker, wait for the catalog, type the bare model name, pick the first match.
  await Bun.$`herdr pane send-text ${pane} /model`.nothrow().quiet();
  await Bun.sleep(700);
  await Bun.$`herdr pane send-keys ${pane} Enter`.nothrow().quiet();
  await Bun.sleep(3500);
  await Bun.$`herdr pane send-text ${pane} ${want.model}`.nothrow().quiet();
  await Bun.sleep(1500);
  const pick = await read(pane);
  if (!new RegExp(`\u2192\\s+${want.model.replace(/\./g, "\\.")} \\[${want.provider}\\]`).test(pick)) {
    await Bun.$`herdr pane send-keys ${pane} Escape`.nothrow().quiet();
    return `MODEL_SWITCH_FAILED ${pane} want=${want.provider}/${want.model} (not first in picker)`;
  }
  await Bun.$`herdr pane send-keys ${pane} Enter`.nothrow().quiet();
  let after = "";
  for (let i = 0; i < 8; i++) {
    await Bun.sleep(2000);
    after = classify(await read(pane)).model;
    if (after.startsWith(want.model)) break;
  }
  if (!after.startsWith(want.model)) {
    await Bun.$`herdr pane send-keys ${pane} Escape`.nothrow().quiet();
    await Bun.sleep(300);
    await Bun.$`herdr pane send-keys ${pane} ctrl+u`.nothrow().quiet();
    return `MODEL_SWITCH_FAILED ${pane} want=${want.model} now=${after}`;
  }
  if (want.thinking && !after.endsWith(`:${want.thinking}`)) {
    await Bun.$`herdr pane send-text ${pane} ${`/thinking ${want.thinking}`}`.nothrow().quiet();
    await Bun.sleep(700);
    await Bun.$`herdr pane send-keys ${pane} Enter`.nothrow().quiet();
  }
  return `MODEL_SWITCHED ${before} -> ${want.provider}/${want.model}`;
}

// Verified send (Dori panes.ts idea): only into an idle agent prompt, one send, then confirm the agent actually started.
async function dispatch(catId, key, prompt, { type = "impl", skill = "ulw", done = "", title = "", keepModel = false } = {}) {
  const c = db.query("SELECT * FROM cats WHERE id=?").get(catId);
  if (!c || c.pane === "-") throw new Error(`cat ${catId} has no pane`);
  if (!(await Bun.file(prompt).exists())) throw new Error(`prompt file missing: ${prompt}`);
  const s0 = classify(await read(c.pane));
  if (s0.state === "working" || s0.state === "compacting") return `DISPATCH_HOLD ${catId} busy(${s0.state}); not sent`;
  if (s0.state === "question") return `DISPATCH_HOLD ${catId} has a pending question; answer it first`;
  const want = await pickModel(type);
  const modelNote = keepModel ? "MODEL_KEPT" : await switchModel(c.pane, want);
  if (modelNote.startsWith("MODEL_SWITCH_FAILED")) return modelNote;
  const head = `${key} [skill:${skill}${done ? ` | Done= ${done}` : ""}]`;
  const msg = `${head}: 지시문 파일 ${prompt} 전체를 읽고 그대로 수행해. 끝나면 마지막 줄에 ${key}_DONE <한 줄 요약> 또는 ${key}_BLOCKED reason=<한 줄>.`;
  db.query(`INSERT INTO tasks(key,cat,title,prompt,skill,model,done,status,sent_at) VALUES(?,?,?,?,?,?,?,'sent',?)
    ON CONFLICT(key) DO UPDATE SET cat=excluded.cat, prompt=excluded.prompt, skill=excluded.skill, model=excluded.model, done=excluded.done, status='sent', sent_at=excluded.sent_at, started_at=NULL, ended_at=NULL, result=NULL`)
    .run(key, catId, title || key, prompt, skill, `${want.provider}/${want.model}:${want.thinking}`, done, now());
  db.query("UPDATE cats SET task=? WHERE id=?").run(key, catId);
  await Bun.$`herdr pane send-text ${c.pane} ${msg}`.nothrow().quiet();
  await Bun.sleep(700);
  await Bun.$`herdr pane send-keys ${c.pane} Enter`.nothrow().quiet();
  log(key, { ev: "sent", model: modelNote });
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(5000);
    const s = classify(await read(c.pane));
    if (s.state === "working") {
      db.query("UPDATE tasks SET status='working', started_at=? WHERE key=?").run(now(), key);
      log(key, { ev: "started" });
      return `DISPATCH_OK ${catId} ${key} started (${modelNote})`;
    }
    if (s.state === "compaction-failed") {
      db.query("UPDATE tasks SET status='prompt-lost' WHERE key=?").run(key);
      log(key, { ev: "prompt-lost" });
      return `DISPATCH_PROMPT_LOST ${catId} ${key}: compaction failed; resend after compaction`;
    }
  }
  db.query("UPDATE tasks SET status='sent-unconfirmed' WHERE key=?").run(key);
  log(key, { ev: "unconfirmed" });
  return `DISPATCH_UNCONFIRMED ${catId} ${key}: no Working within 60s (watch keeps checking)`;
}

// Machine-checked done (Dori signals.ts idea). Spec: "pr:owner/repo#N" | "url:http://...=200" | "cmd:<shell>"; ';'-separated.
async function checkSignal(sig) {
  sig = sig.trim();
  let m;
  if ((m = sig.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/))) {
    const j = JSON.parse((await sh(`gh pr view ${m[2]} --repo ${m[1]} --json state,mergeCommit,headRefOid 2>/dev/null`)) || "{}");
    return { ok: j.state === "MERGED", detail: j.state === "MERGED" ? `merged ${j.mergeCommit?.oid?.slice(0, 8)}` : `state=${j.state ?? "unknown"}` };
  }
  if ((m = sig.match(/^url:(\S+)=(\d{3})$/))) {
    const code = (await sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 6 '${m[1]}'`)).trim();
    return { ok: code === m[2], detail: `http ${code}` };
  }
  if ((m = sig.match(/^cmd:(.+)$/))) {
    const r = await Bun.$`bash -c ${m[1]}`.nothrow().quiet();
    return { ok: r.exitCode === 0, detail: `exit ${r.exitCode}` };
  }
  return { ok: false, detail: `unparseable signal: ${sig}` };
}

async function verify(key) {
  const t = db.query("SELECT * FROM tasks WHERE key=?").get(key);
  if (!t) throw new Error(`no task ${key}`);
  if (!t.done) return `VERIFY_NO_SIGNAL ${key}: no Done= spec; cannot be verified-done`;
  const res = [];
  for (const s of t.done.split(";").filter(Boolean)) res.push({ s: s.trim(), ...(await checkSignal(s)) });
  const ok = res.every((r) => r.ok);
  const ev = res.map((r) => `${r.ok ? "OK" : "NOT"} ${r.s} -> ${r.detail}`).join(" | ");
  db.query("UPDATE tasks SET status=?, evidence=?, ended_at=? WHERE key=?").run(ok ? "verified-done" : "not-done", ev, ok ? now() : null, key);
  log(key, { ev: ok ? "verified" : "not-done", detail: ev });
  return `${ok ? "VERIFIED_DONE" : "NOT_DONE"} ${key} :: ${ev}`;
}

async function track(key, cat, done, title) {
  db.query(`INSERT INTO tasks(key,cat,title,done,status,sent_at) VALUES(?,?,?,?,'working',?) ON CONFLICT(key) DO UPDATE SET done=excluded.done`).run(key, cat, title || key, done || "", now());
  db.query("UPDATE cats SET task=? WHERE id=?").run(key, cat);
  return `TRACKED ${key} on ${cat}`;
}

async function status() {
  await refresh();
  const rows = db.query("SELECT c.id,c.name,c.pane,c.state,c.model,c.task,t.status ts,t.skill FROM cats c LEFT JOIN tasks t ON t.key=c.task ORDER BY c.kind,c.id").all();
  return rows.map((r) => `${r.name.padEnd(10)} ${String(r.pane).padEnd(6)} ${String(r.state).padEnd(17)} ${String(r.model || "-").padEnd(22)} ${r.task || "-"} ${r.ts ? `(${r.ts}${r.skill ? `, ${r.skill}` : ""})` : ""}`).join("\n");
}

async function report() {
  await refresh();
  const cats = db.query("SELECT c.*, t.status ts, t.title tt, t.evidence te FROM cats c LEFT JOIN tasks t ON t.key=c.task WHERE c.pane!='-' ORDER BY c.id").all();
  const ko = { working: "일함", idle: "대기", compacting: "압축 중", "compaction-failed": "지시 유실", question: "질문 대기", "provider-error": "모델 오류", unknown: "?" };
  const beat = db.query("SELECT * FROM beats WHERE who='omonyang'").get();
  const lines = cats.map((c) => `• ${c.name}(${c.pane}): ${ko[c.state] ?? c.state}${c.task ? ` — ${c.task} [${c.ts}]` : ""}`);
  return `*냥이 현황* (${now().slice(11, 16)}Z)\n${lines.join("\n")}\n• 대장 heartbeat: ${beat ? beat.at.slice(11, 19) + "Z" : "없음"}`;
}

// Watch: emits only transitions. Gajae: surface recovery_hold / speech suppressed with reason.
async function watch(intervalSec = 30) {
  const last = new Map();
  // journalctl --since takes local time; keep the cursor in epoch seconds to avoid TZ drift.
  let jcursor = Math.floor(Date.now() / 1000) - 60;
  for (;;) {
    try {
      const rows = await refresh();
      for (const r of rows) {
        const sig = `${r.state}|${r.done?.key ?? ""}${r.done?.kind ?? ""}|${r.readyLine ?? ""}|${r.ready?.head ?? ""}`;
        const prev = last.get(r.id);
        if (prev !== undefined && prev !== sig) {
          if (r.state !== prev.split("|")[0] && r.id !== "omonyang") console.log(`FLEET_STATE ${r.id} ${prev.split("|")[0]} -> ${r.state}`);
          if (r.id !== "omonyang" && r.done && !prev.includes(`${r.done.key}${r.done.kind}`)) {
            console.log(`FLEET_TASK_${r.done.kind} ${r.id} ${r.done.key} ${r.done.text}`);
            db.query("UPDATE tasks SET status=?, result=? WHERE key=?").run(r.done.kind === "DONE" ? "done-claimed" : "blocked", r.done.text, r.done.key);
            log(r.done.key, { ev: r.done.kind === "DONE" ? "done-claimed" : "blocked", text: r.done.text });
          }
          if (r.ready && !prev.endsWith(r.ready.head)) console.log(`FLEET_PR_READY ${r.id} ${r.ready.repo} ${r.ready.head}`);
          if (r.readyLine && !prev.includes(r.readyLine)) console.log(`FLEET_READY_LINE ${r.id} ${r.readyLine}`);
        }
        last.set(r.id, sig);
        if (r.task) {
          const t = db.query("SELECT status,sent_at FROM tasks WHERE key=?").get(r.task);
          if (t?.status === "sent-unconfirmed" && r.state === "working") {
            db.query("UPDATE tasks SET status='working', started_at=? WHERE key=?").run(now(), r.task);
            console.log(`FLEET_TASK_STARTED ${r.id} ${r.task}`);
          }
          if (t?.status === "sent" || t?.status === "sent-unconfirmed") {
            if (r.state === "compaction-failed") { db.query("UPDATE tasks SET status='prompt-lost' WHERE key=?").run(r.task); console.log(`FLEET_PROMPT_LOST ${r.id} ${r.task}`); }
          }
        }
      }
      const w5 = rows.find((r) => r.id === "omonyang");
      const listen = (await sh("pgrep -f 'bun slack-listen.mjs' | head -1")).trim();
      db.query("INSERT INTO beats(who,at,detail) VALUES('omonyang',?,?) ON CONFLICT(who) DO UPDATE SET at=excluded.at, detail=excluded.detail")
        .run(now(), JSON.stringify({ pane: w5?.state, model: w5?.model, slackListen: listen || null }));
      await Bun.write(`${STATE}/captain-heartbeat.json`, JSON.stringify({ at: now(), pane: w5?.state, model: w5?.model, slackListen: listen || null }) + "\n");
      const next = Math.floor(Date.now() / 1000);
      const j = await sh(`journalctl --user -u gajaeway-gateway --since @${jcursor} --until @${next} --no-pager 2>/dev/null | grep -E 'recovery_hold|speech suppressed' | tail -5`);
      jcursor = next;
      for (const line of j.split("\n").filter(Boolean)) {
        const reason = line.match(/reason=(\S+)/)?.[1] ?? line.match(/suppressed \([^,]+, (\w+)\)/)?.[1] ?? "?";
        const origin = line.match(/origin=slack\/\w+\/([A-Z0-9]+:[\d.]+)/)?.[1] ?? "";
        console.log(`FLEET_GAJAE_${/recovery_hold/.test(line) ? "HOLD" : "SUPPRESSED"} reason=${reason} ${origin}`);
      }
    } catch (e) {
      console.log(`FLEET_WATCH_ERROR ${e?.message ?? e}`);
    }
    await Bun.sleep(intervalSec * 1000);
  }
}

if (import.meta.main) {
  const [cmd, ...a] = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  const out = await ({
    init: async () => { await init(); return status(); },
    status, report,
    dispatch: () => dispatch(a[0], a[1], a[2], { type: opt("type"), skill: opt("skill"), done: opt("done"), title: opt("title"), keepModel: a.includes("--keep-model") }),
    track: () => track(a[0], a[1], opt("done"), opt("title")),
    verify: () => verify(a[0]),
    tasks: async () => db.query("SELECT key,cat,status,skill,model,done,evidence FROM tasks ORDER BY sent_at DESC LIMIT 20").all().map((t) => JSON.stringify(t)).join("\n"),
    beat: async () => JSON.stringify(db.query("SELECT * FROM beats").all()),
    routes: async () => JSON.stringify(ROUTES, null, 1),
    watch: () => watch(Number(a[0] || 30)),
  }[cmd] ?? (async () => "usage: fleet init|status|report|dispatch <cat> <KEY> <prompt> [--type plan|impl|review|secure|quick] [--skill ulw|ulw-loop|mass-ulw|ulw-plan|ulw-execute|ulw-research] [--done 'pr:o/r#N;url:..=200;cmd:..'] [--keep-model]|track <KEY> <cat> --done ..|verify <KEY>|tasks|beat|routes|watch [sec]"))();
  if (out !== undefined) console.log(out);
}
