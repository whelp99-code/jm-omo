#!/usr/bin/env bun
// 오모냥 fleet: registry of every 냥이 (worker pane / bot), verified dispatch, machine-checked done, watch.
// Ideas taken from Dori (lane registry, verified pane send, Done= signals) and Gajae (accepted != done, no blind re-run).
import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STATE = `${process.env.HOME}/.local/state/omonyang`;
mkdirSync(STATE, { recursive: true });
const db = new Database(`${STATE}/fleet.sqlite`);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
CREATE TABLE IF NOT EXISTS cats(id TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT, pane TEXT, product TEXT, state TEXT, model TEXT, task TEXT, last_seen TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS tasks(key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT, done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT, result TEXT, evidence TEXT, history TEXT DEFAULT '[]', depends_on TEXT, dispatch_type TEXT DEFAULT 'impl', keep_model INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS beats(who TEXT PRIMARY KEY, at TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS dispatch_reservations(pane TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, attempt TEXT NOT NULL, reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
const taskColumns = new Set(db.query("PRAGMA table_info(tasks)").all().map((column) => column.name));
for (const [name, definition] of [["depends_on", "TEXT"], ["dispatch_type", "TEXT DEFAULT 'impl'"], ["keep_model", "INTEGER DEFAULT 0"]]) {
  if (!taskColumns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
}
const reservationColumns = new Set(db.query("PRAGMA table_info(dispatch_reservations)").all().map((column) => column.name));
if (!reservationColumns.has("reserved_at")) {
  db.exec("ALTER TABLE dispatch_reservations ADD COLUMN reserved_at TEXT NOT NULL DEFAULT ''");
  db.query("UPDATE dispatch_reservations SET reserved_at=? WHERE reserved_at=''").run(new Date().toISOString());
}

const now = () => new Date().toISOString();
const sh = async (cmd) => (await Bun.$`bash -c ${cmd}`.nothrow().quiet()).stdout.toString();
const read = (pane) => sh(`herdr pane read ${pane} --source visible --format text 2>/dev/null`);
const ROUTES = JSON.parse(await Bun.file(new URL("./routes.json", import.meta.url)).text());
const CURSOR_USER_ID = "U0B81F5GR6V";
const SLACK_REVIEW_CHANNEL = "C0C6HJM0BV5";
const REVIEW_REPLY_APP_ID = "A08SKDT6QUW";
const REVIEW_STALL_MS = 45 * 60 * 1000;
const USAGE_ALERT_THRESHOLDS = { anthropic: 60, "chatgpt-subscription": 80 };
const DISPATCH_RESERVATION_TTL_MS = 2 * 60_000;
const SLACK_THREAD_CONCURRENCY = 5;
const SLACK_HISTORY_TIMEOUT_MS = 15_000;

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
  else if (/→\s+\S+\s+\[[^\]]+\]/.test(tail)) state = "model-picker";
  const output = responseBlock(screen);
  const done = [...output.matchAll(/^\s*(?:[•●⏺✻]\s*)?(TASK-[A-Z0-9-]+)_(DONE|BLOCKED)\b([^\n]*)$/gm)]
    .filter((m) => !/[<]|또는|<숫자/.test(m[0])).at(-1);
  const ready = [...output.matchAll(/\b([A-Za-z0-9_.-]+) PR READY head=([0-9a-f]{7,40})\b/gi)].at(-1);
  // Result lines wrap in narrow panes: also look at the latest output block.
  const joined = output.split("\n").slice(-40).map((l) => l.trim()).join(" ");
  const readyLine = [...joined.matchAll(/\b([A-Z]+_[A-Z_]*READY)\b([^❯─]{0,400})/g)].at(-1);
  const claimText = output.split("\n").filter((line) => /\bCursor\s+(?:ACCEPT|APPROVE)\b|\bPR READY\s+head=|\b(?:tests?\s+\d+\s+(?:passed|passing)|\d+\s+tests?\s+(?:passed|passing))\b|테스트\s*\d+\s*(?:개\s*)?통과/i.test(line)).join("\n");
  const questionText = state === "question"
    ? (output || tail).split("\n").filter((line) => !/Question pending|unanswered/i.test(line)).join("\n").trim().slice(-800)
    : "";
  return { state, model, done: done ? { key: done[1], kind: done[2], text: done[3].trim().slice(0, 200) } : null, ready: ready ? { repo: ready[1], head: ready[2] } : null, readyLine: readyLine ? `${readyLine[1]}${readyLine[2]}`.replace(/\s+/g, " ").trim().slice(0, 300) : null, claimText, questionText };
}

function responseBlock(screen) {
  const lines = screen.replace(/\r/g, "").split("\n");
  const prompts = lines.flatMap((line, index) => /^\s*❯/.test(line) ? [index] : []);
  const input = prompts.at(-1);
  if (input === undefined) return "";
  const previousPrompt = prompts.at(-2);
  const visibleLines = lines.slice(previousPrompt === undefined ? 0 : previousPrompt + 1, input);
  if (previousPrompt !== undefined) {
    const response = visibleLines.findLastIndex((line) => /^\s*(?:⏺|●|•|✻|Assistant:)\s*/i.test(line));
    return response < 0 ? "" : visibleLines.slice(response).join("\n").trimEnd();
  }
  const visible = visibleLines.join("\n").trimEnd();
  return visible.split(/\n[ \t]*\n/).filter((block) => block.trim()).at(-1) ?? "";
}

const QUESTION_POLICIES = [
  {
    id: "personal-credentials-defer",
    matches: /(?:재민|jae[\s-]?min)[\s\S]{0,60}(?:비밀번호|password|otp)|(?:비밀번호|password|otp)[\s\S]{0,60}(?:재민|jae[\s-]?min)/i,
    answer: "재민의 비밀번호나 OTP는 사용하지 말고 내일로 미뤄.",
  },
  {
    id: "production-auth-prohibited",
    matches: /(?:운영|production)[\s\S]{0,40}(?:인증|auth(?:entication)?)[\s\S]{0,40}(?:계정|account)|(?:계정|account)[\s\S]{0,40}(?:운영|production)[\s\S]{0,40}(?:인증|auth(?:entication)?)/i,
    answer: "운영 인증 계정은 사용하지 마.",
  },
];

function questionPolicy(question) {
  return QUESTION_POLICIES.find((policy) => policy.matches.test(question)) ?? null;
}

export async function answerPaneQuestion(pane, expectedQuestion, answer, runCommand = executeSignalCommand) {
  const current = await runCommand(["herdr", "pane", "read", pane, "--source", "visible", "--format", "text"]);
  if (current.exitCode !== 0) return false;
  const state = classify(current.stdout);
  if (state.state !== "question" || state.questionText !== expectedQuestion) return false;
  const send = await runCommand(["herdr", "pane", "send-text", pane, answer]);
  if (send.exitCode !== 0) return false;
  const enter = await runCommand(["herdr", "pane", "send-keys", pane, "Enter"]);
  return enter.exitCode === 0;
}

function appendHistoryInTransaction(dbHandle, task, ev) {
  const event = JSON.stringify({ at: now(), ...ev });
  dbHandle.query(`UPDATE tasks SET history=CASE
    WHEN json_array_length(COALESCE(history,'[]')) >= 40
      THEN json_remove(json_insert(COALESCE(history,'[]'),'$[#]',json(?)),'$[0]')
    ELSE json_insert(COALESCE(history,'[]'),'$[#]',json(?))
    END WHERE key=?`).run(event, event, task);
}

export function appendTaskHistory(dbHandle, task, ev) {
  return dbHandle.transaction(() => appendHistoryInTransaction(dbHandle, task, ev)).immediate();
}

function logOn(dbHandle, task, ev) {
  return appendTaskHistory(dbHandle, task, ev);
}

function log(task, ev) {
  logOn(db, task, ev);
}

export function markTaskBlocked(key, result) {
  return db.transaction(() => {
    db.query("UPDATE tasks SET status='blocked',result=? WHERE key=?").run(result, key);
    db.query("DELETE FROM dispatch_reservations WHERE key=?").run(key);
    appendHistoryInTransaction(db, key, { ev: "blocked", text: result });
  }).immediate();
}

export function markTaskPromptLost(key, attempt) {
  return db.transaction(() => {
    db.query("UPDATE tasks SET status='prompt-lost' WHERE key=?").run(key);
    db.query("DELETE FROM dispatch_reservations WHERE key=?").run(key);
    appendHistoryInTransaction(db, key, { ev: "prompt-lost", ...(attempt ? { attempt } : {}) });
  }).immediate();
}

export function recordDispatchSendAttempt(dbHandle, pane, key, attempt) {
  return dbHandle.transaction(() => {
    const reservation = dbHandle.query("SELECT key,attempt FROM dispatch_reservations WHERE pane=?").get(pane);
    const task = dbHandle.query("SELECT status FROM tasks WHERE key=?").get(key);
    if (reservation?.key !== key || reservation.attempt !== attempt || task?.status !== "dispatching") return false;
    appendHistoryInTransaction(dbHandle, key, { ev: "send-attempted", attempt });
    return true;
  }).immediate();
}

export function reservationExpiredAndOwned(dbHandle, reservation, nowMs = Date.now()) {
  return dbHandle.transaction(() => {
    const current = dbHandle.query(`SELECT reserved_at FROM dispatch_reservations
      WHERE pane=? AND key=? AND attempt=?`).get(reservation.pane, reservation.key, reservation.attempt);
    if (!current || current.reserved_at !== reservation.reserved_at) return false;
    const task = dbHandle.query("SELECT status,history FROM tasks WHERE key=?").get(reservation.key);
    if (task?.status !== "dispatching") return false;
    const reservedAt = Date.parse(current.reserved_at);
    if (!Number.isFinite(reservedAt) || nowMs - reservedAt < DISPATCH_RESERVATION_TTL_MS) return false;
    const history = JSON.parse(task.history || "[]");
    return !history.some((event) => event.ev === "send-attempted" && event.attempt === reservation.attempt);
  }).immediate();
}

export function recoverDispatchReservation(dbHandle, reservation, paneState, nowMs = Date.now()) {
  return dbHandle.transaction(() => {
    const current = dbHandle.query(`SELECT reserved_at FROM dispatch_reservations
      WHERE pane=? AND key=? AND attempt=?`).get(reservation.pane, reservation.key, reservation.attempt);
    if (!current || current.reserved_at !== reservation.reserved_at) return null;
    const task = dbHandle.query("SELECT status,history FROM tasks WHERE key=?").get(reservation.key);
    if (task?.status !== "dispatching") return null;
    const reservedAt = Date.parse(current.reserved_at);
    if (!Number.isFinite(reservedAt) || nowMs - reservedAt < DISPATCH_RESERVATION_TTL_MS) return null;
    const history = JSON.parse(task.history || "[]");
    const sendAttempted = history.some((event) => event.ev === "send-attempted" && event.attempt === reservation.attempt);
    if (paneState === "working" || paneState === "question" || paneState === "compacting" || paneState === "provider-error") {
      const status = sendAttempted ? "send-failed-unconfirmed" : "sent-unconfirmed";
      dbHandle.query("UPDATE tasks SET status=? WHERE key=? AND status='dispatching'").run(status, reservation.key);
      appendHistoryInTransaction(dbHandle, reservation.key, { ev: status, attempt: reservation.attempt });
      return null;
    }
    if (paneState === "compaction-failed") {
      const deleted = dbHandle.query(`DELETE FROM dispatch_reservations
        WHERE pane=? AND key=? AND attempt=? AND reserved_at=?`)
        .run(reservation.pane, reservation.key, reservation.attempt, reservation.reserved_at).changes;
      if (!deleted) return null;
      dbHandle.query("UPDATE tasks SET status='prompt-lost' WHERE key=? AND status='dispatching'").run(reservation.key);
      appendHistoryInTransaction(dbHandle, reservation.key, { ev: "prompt-lost", attempt: reservation.attempt });
      return `FLEET_PROMPT_LOST ${reservation.key} pane=${reservation.pane} reservation_released`;
    }
    if (paneState !== "idle") return null;
    if (sendAttempted) {
      const deleted = dbHandle.query(`DELETE FROM dispatch_reservations
        WHERE pane=? AND key=? AND attempt=? AND reserved_at=?`)
        .run(reservation.pane, reservation.key, reservation.attempt, reservation.reserved_at).changes;
      if (!deleted) return null;
      dbHandle.query("UPDATE tasks SET status='send-failed-unconfirmed' WHERE key=? AND status='dispatching'").run(reservation.key);
      appendHistoryInTransaction(dbHandle, reservation.key, { ev: "send-failed-unconfirmed", attempt: reservation.attempt });
      return `FLEET_SEND_FAILED_UNCONFIRMED ${reservation.key} pane=${reservation.pane} reservation_released`;
    }
    const deleted = dbHandle.query(`DELETE FROM dispatch_reservations
      WHERE pane=? AND key=? AND attempt=? AND reserved_at=?`)
      .run(reservation.pane, reservation.key, reservation.attempt, reservation.reserved_at).changes;
    if (!deleted) return null;
    dbHandle.query("UPDATE tasks SET status='dispatch-interrupted',result='dispatch process stopped before confirming send' WHERE key=? AND status='dispatching'").run(reservation.key);
    appendHistoryInTransaction(dbHandle, reservation.key, { ev: "dispatch-interrupted", attempt: reservation.attempt });
    return `FLEET_DISPATCH_INTERRUPTED ${reservation.key} pane=${reservation.pane} reservation_released`;
  }).immediate();
}

export async function recoverInterruptedDispatches(dbHandle, paneRows, nowMs = Date.now(), runCommand = executeSignalCommand) {
  const paneStates = new Map(paneRows.map((row) => [row.id, row.state]));
  const reservations = dbHandle.query(`SELECT r.pane,r.key,r.attempt,r.reserved_at,t.cat
    FROM dispatch_reservations r JOIN tasks t ON t.key=r.key WHERE t.status='dispatching'`).all();
  const events = [];
  for (const reservation of reservations) {
    try {
      let state = paneStates.get(reservation.cat);
      if (state === "model-picker") {
        if (!reservationExpiredAndOwned(dbHandle, reservation, nowMs)) continue;
        const escape = await runCommand(["herdr", "pane", "send-keys", reservation.pane, "Escape"]);
        if (escape.exitCode !== 0) continue;
        const screen = await runCommand(["herdr", "pane", "read", reservation.pane, "--source", "visible", "--format", "text"]);
        if (screen.exitCode !== 0) continue;
        state = classify(screen.stdout).state;
        if (state !== "idle") continue;
      }
      const event = recoverDispatchReservation(dbHandle, reservation, state, nowMs);
      if (event) events.push(event);
    } catch (error) {
      events.push(`FLEET_DISPATCH_RECOVERY_ERROR ${reservation.key} ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  return events;
}

async function init() {
  const up = db.query("INSERT INTO cats(id,name,role,kind,pane,product,state) VALUES(?,?,?,?,?,?,'unknown') ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, kind=excluded.kind, pane=excluded.pane, product=excluded.product");
  for (const c of CATS) up.run(...c);
  await refresh();
}

async function refresh() {
  const out = [];
  for (const c of db.query("SELECT * FROM cats WHERE pane!='-'").all()) {
    try {
      const s = classify(await read(c.pane));
      db.query("UPDATE cats SET state=?, model=?, last_seen=? WHERE id=?").run(s.state, s.model, now(), c.id);
      out.push({ ...c, ...s });
    } catch (error) {
      console.log(`FLEET_REFRESH_ERROR ${c.id} ${error?.message ?? error}`);
      out.push({ ...c, state: "unknown", model: "", done: null, ready: null, readyLine: null, claimText: "", questionText: "" });
    }
  }
  return out;
}

// Owner C0C6HJM0BV5:1791553182.735709: watch Claude/Codex usage so limits never stop development.
// Claude quota is shared with the captain, so cats only fall back to it while it is low.
export function parseUsageTick(text) {
  const tick = String(text).split("\n").filter((line) => /\bUSAGE_TICK\b/.test(line)).at(-1);
  if (!tick) return null;
  const values = {};
  for (const match of tick.matchAll(/\b([a-z][a-z0-9-]*)=(\d+(?:\.\d+)?)%/gi)) values[match[1]] = Number(match[2]);
  return Object.keys(values).length ? values : null;
}

export function usageLimitEvents(tick, previous = new Map()) {
  if (!tick) return [];
  const events = [];
  for (const [provider, threshold] of Object.entries(USAGE_ALERT_THRESHOLDS)) {
    const used = tick[provider];
    if (!Number.isFinite(used)) continue;
    const overLimit = used >= threshold;
    const wasOverLimit = previous.get(provider) === true;
    previous.set(provider, overLimit);
    if (overLimit && !wasOverLimit) {
      events.push(`FLEET_USAGE_LIMIT provider=${provider} used=${used}% remaining=${Math.max(0, 100 - used)}% threshold=${threshold}%`);
    }
  }
  return events;
}

async function usageTick() {
  const usageText = await Bun.file(`${process.env.HOME}/.omo/omonyang/usage-watch.log`).text().catch(() => "");
  return parseUsageTick(usageText);
}

async function usage() {
  const tick = await usageTick();
  return { anthropic: tick?.anthropic ?? 0, chatgpt: tick?.["chatgpt-subscription"] ?? 0 };
}

async function pickModel(type) {
  const r = ROUTES.models[type];
  if (!r) throw new Error(`unknown task type ${type}; use ${Object.keys(ROUTES.models).join("|")}`);
  const u = await usage();
  const hot = (p) => (p.startsWith("chatgpt") && u.chatgpt >= USAGE_ALERT_THRESHOLDS["chatgpt-subscription"])
    || (p.startsWith("anthropic") && u.anthropic >= USAGE_ALERT_THRESHOLDS.anthropic);
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

export async function fetchSlackThreadReplies(roots, fetchThread, signal, concurrency = SLACK_THREAD_CONCURRENCY) {
  const replies = [];
  for (let offset = 0; offset < roots.length; offset += concurrency) {
    if (signal.aborted) return null;
    const batch = await Promise.all(roots.slice(offset, offset + concurrency).map(async (root) => {
      try { return await fetchThread(root, signal); } catch { return null; }
    }));
    if (batch.some((thread) => thread === null)) return null;
    replies.push(...batch.flat());
  }
  return replies;
}

export function reviewRequestThreadRoots(messages) {
  return messages.filter((message) => Number(message.reply_count) > 0 && isReviewRequest(message));
}

async function slackHistory(since) {
  const deadline = AbortSignal.timeout(SLACK_HISTORY_TIMEOUT_MS);
  const nodeRoot = await commandOutput("npm", ["root", "-g"], process.cwd(), deadline);
  if (!nodeRoot || deadline.aborted) return null;
  const credentialPath = join(nodeRoot, "agent-messenger/dist/src/platforms/slackbot/credential-manager.js");
  const { SlackBotCredentialManager } = await import(credentialPath);
  const credentials = new SlackBotCredentialManager().getCredentials();
  const creds = await Promise.race([
    credentials,
    new Promise((resolve) => {
      if (deadline.aborted) resolve(null);
      else deadline.addEventListener("abort", () => resolve(null), { once: true });
    }),
  ]);
  if (!creds?.token || deadline.aborted) return null;

  const messages = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({ channel: SLACK_REVIEW_CHANNEL, limit: "100", oldest: since });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: deadline,
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.ok !== true) return null;
    messages.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor ?? "";
  } while (cursor);
  const replies = await fetchSlackThreadReplies(reviewRequestThreadRoots(messages), async (root, signal) => {
    const thread = [];
    let replyCursor = "";
    do {
      const params = new URLSearchParams({ channel: SLACK_REVIEW_CHANNEL, ts: root.ts, limit: "200", oldest: since });
      if (replyCursor) params.set("cursor", replyCursor);
      const response = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
        headers: { Authorization: `Bearer ${creds.token}` },
        signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (data.ok !== true) return null;
      thread.push(...(data.messages ?? []).filter((reply) => reply.ts !== root.ts));
      replyCursor = data.response_metadata?.next_cursor ?? "";
    } while (replyCursor);
    return thread;
  }, deadline);
  if (replies === null) return null;
  messages.push(...replies);
  return messages;
}

async function slackHasHead(fullHead, sentAt) {
  if (!/^[a-f0-9]{40}$/i.test(fullHead || "")) return false;
  const sentTime = Date.parse(sentAt);
  if (!Number.isFinite(sentTime)) return false;
  const messages = await slackHistory((sentTime / 1000).toFixed(6));
  if (!messages) return false;
  return cursorHeadMatches(messages, fullHead);
}

/**
 * A Cursor message accepts a head only when one line of its text carries both
 * an ACCEPT/APPROVE verdict and that head, and the same line has no
 * REJECT/REVISE verdict. A bare SHA mention, or a table row that reads REJECT,
 * never counts as acceptance.
 */
export function cursorHeadMatches(messages, fullHead) {
  const want = String(fullHead).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(want)) return false;
  return messages.some((message) => message.user === CURSOR_USER_ID
    && String(message.text ?? "").split(/\n|(?<=\|)\s+(?=\|)/).some((line) => {
      if (!/\b(?:ACCEPT|APPROVE)\b/i.test(line) || /\b(?:REJECT|REVISE)\b/i.test(line)) return false;
      return [...line.matchAll(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi)]
        .some((match) => want.startsWith(match[0].toLowerCase()));
    }));
}

function isReviewResponder(message) {
  return message.user === CURSOR_USER_ID || message.app_id === REVIEW_REPLY_APP_ID;
}

export function reviewRequestKeys(text) {
  const source = String(text ?? "");
  const keys = new Set();
  for (const match of source.matchAll(/\bPR\s*#?(\d+)\b|\/pull\/(\d+)\b|pr:[\w.-]+\/[\w.-]+#(\d+)\b/gi)) {
    keys.add(`pr:${match[1] || match[2] || match[3]}`);
  }
  for (const match of source.matchAll(/\bhead(?:\s*[:=]\s*|\s+)([0-9a-f]{8,40})\b/gi)) {
    keys.add(`head:${match[1].slice(0, 8).toLowerCase()}`);
  }
  for (const match of source.matchAll(/\b(TASK-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/gi)) {
    keys.add(`task:${match[1].toUpperCase()}`);
  }
  return [...keys];
}

export function isReviewRequest(message) {
  return !isReviewResponder(message) && /Cursor\s*검수\s*요청|review\s+request/i.test(String(message.text ?? ""));
}

function reviewThreadRoot(message) {
  return String(message.thread_ts || message.ts || "");
}

function reviewReplyScore(requestKeys, replyKeys) {
  const matching = requestKeys.filter((key) => replyKeys.includes(key));
  if (!matching.length) return 0;
  const weight = (key) => key.startsWith("task:") ? 3 : key.startsWith("head:") ? 2 : 1;
  return Math.max(...matching.map(weight)) * 100 + matching.length;
}

export function pairReviewReplies(requests, replies) {
  const pending = requests.filter(isReviewRequest).slice().sort((a, b) => Number(a.ts) - Number(b.ts));
  const uniqueReplies = new Map();
  for (const reply of replies) {
    if (isReviewResponder(reply) && reply.ts) uniqueReplies.set(String(reply.ts), reply);
  }
  const orderedReplies = [...uniqueReplies.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  const paired = new Map();
  for (const reply of orderedReplies) {
    const replyTs = Number(reply.ts);
    if (!Number.isFinite(replyTs)) continue;
    const replyKeys = reviewRequestKeys(reply.text);
    const candidates = pending.filter((request) => {
      const requestTs = Number(request.ts);
      return !paired.has(String(request.ts))
        && reviewThreadRoot(request) === reviewThreadRoot(reply)
        && Number.isFinite(requestTs)
        && requestTs < replyTs;
    });
    if (!candidates.length) continue;
    const keyed = candidates.filter((request) => reviewReplyScore(reviewRequestKeys(request.text), replyKeys) > 0);
    if (!keyed.length && (candidates.length !== 1 || replyKeys.length > 0)) continue;
    const chosen = keyed.length
      ? keyed.map((request) => ({
        request,
        score: reviewReplyScore(reviewRequestKeys(request.text), replyKeys),
      })).sort((a, b) => b.score - a.score || Number(a.request.ts) - Number(b.request.ts))[0].request
      : candidates[0];
    paired.set(String(chosen.ts), String(reply.ts));
  }
  return paired;
}

export function reviewStallDrafts(requests, replies, nowMs, alerted = new Set()) {
  const paired = pairReviewReplies(requests, replies);
  const drafts = [];
  for (const request of requests) {
    const requestTs = String(request.ts ?? "");
    const requestedAt = Math.floor(Number(requestTs) * 1000);
    if (!isReviewRequest(request) || paired.has(requestTs) || !Number.isFinite(requestedAt)
      || nowMs - requestedAt < REVIEW_STALL_MS || alerted.has(requestTs)) continue;
    const channel = request.channel || SLACK_REVIEW_CHANNEL;
    const permalink = `https://app.slack.com/archives/${channel}/p${requestTs.replace(".", "")}`;
    const keys = reviewRequestKeys(request.text);
    drafts.push(`FLEET_REVIEW_STALL_DRAFT owner=omonyang request=${permalink} request_ts=${requestTs} age=${Math.floor((nowMs - requestedAt) / 60000)}m keys=${keys.join(",") || "none"}`);
    alerted.add(requestTs);
  }
  return drafts;
}

export async function reviewStallEvents(nowMs, alerted, fetchMessages = slackHistory) {
  let messages;
  try {
    messages = await fetchMessages(((nowMs - 24 * 60 * 60_000) / 1000).toFixed(6));
  } catch {
    return [];
  }
  if (!messages) return [];
  return reviewStallDrafts(
    messages.filter(isReviewRequest),
    messages.filter(isReviewResponder),
    nowMs,
    alerted,
  );
}

function parsePullRequestSignal(signal) {
  const match = signal.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/);
  return match ? { repo: match[1], number: match[2] } : null;
}

function headPrefixMatchesFull(fullHead, prefix) {
  const normalizedHead = String(fullHead ?? "").toLowerCase();
  const normalizedPrefix = String(prefix ?? "").toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalizedHead)
    && /^[a-f0-9]{7,40}$/.test(normalizedPrefix)
    && normalizedHead.startsWith(normalizedPrefix);
}

async function pullRequestHead(prSignal, abortSignal = AbortSignal.timeout(10000)) {
  const pr = parsePullRequestSignal(prSignal);
  if (!pr) return null;
  try {
    const proc = Bun.spawn(["gh", "pr", "view", pr.number, "--repo", pr.repo, "--json", "headRefOid"], {
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
      signal: abortSignal,
    });
    const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    return JSON.parse(text).headRefOid ?? null;
  } catch {
    return null;
  }
}

async function checkRunsForHead(repo, head, abortSignal = AbortSignal.timeout(10000)) {
  try {
    const proc = Bun.spawn(["gh", "api", `repos/${repo}/commits/${head}/check-runs`], {
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
      signal: abortSignal,
    });
    const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    const data = JSON.parse(text);
    return Array.isArray(data.check_runs) ? data.check_runs : [];
  } catch {
    return null;
  }
}

async function pullRequestCheckRuns(prSignal, abortSignal) {
  const pr = parsePullRequestSignal(prSignal);
  if (!pr) return null;
  const head = await pullRequestHead(prSignal, abortSignal ?? AbortSignal.timeout(10000));
  if (!head) return null;
  const checkRuns = await checkRunsForHead(pr.repo, head, abortSignal ?? AbortSignal.timeout(10000));
  return checkRuns ? { head, checkRuns } : null;
}

export function isBugbotUsageLimit(checkRuns) {
  const run = checkRuns.find((check) => check.name === "Cursor Bugbot");
  if (!run) return false;
  const output = [run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join("\n");
  return /\busage limit (?:has been )?(?:reached|exceeded)\b/i.test(output);
}

export async function bugbotLimitEvents(dbHandle, previous, getCheckRuns = pullRequestCheckRuns) {
  const tasks = dbHandle.query(`SELECT key,done FROM tasks
    WHERE status IN ('sent','sent-unconfirmed','send-failed-unconfirmed','tracked-unconfirmed','working','done-claimed') AND done IS NOT NULL AND done!=''
    ORDER BY sent_at DESC LIMIT 20`).all();
  const targets = new Map();
  for (const task of tasks) {
    try {
      for (const signal of task.done.split(";").map((part) => part.trim())) {
        if (parsePullRequestSignal(signal) && !targets.has(signal)) targets.set(signal, task.key);
      }
    } catch {}
  }
  const events = [];
  const entries = [...targets];
  const deadline = AbortSignal.timeout(15000);
  for (let offset = 0; offset < entries.length && !deadline.aborted; offset += 5) {
    const batch = await Promise.all(entries.slice(offset, offset + 5).map(async ([signal, taskKey]) => {
      try {
        const result = await getCheckRuns(signal, deadline);
        if (!result) return null;
        const alertKey = `${signal}@${result.head}`;
        const limited = isBugbotUsageLimit(result.checkRuns);
        const wasLimited = previous.get(alertKey) === true;
        previous.set(alertKey, limited);
        return limited && !wasLimited
          ? `FLEET_BUGBOT_LIMIT ${taskKey} ${signal.slice(3)} head=${result.head.slice(0, 7)} reason=usage_limit_reached`
          : null;
      } catch {
        return null;
      }
    }));
    events.push(...batch.filter(Boolean));
  }
  return events;
}

function pullRequestSignal(text, task) {
  const url = text.match(/\bhttps:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/i);
  if (url) return `pr:${url[1]}#${url[2]}`;
  const reference = text.match(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/);
  if (reference) return `pr:${reference[1]}#${reference[2]}`;
  return task?.done?.split(";").map((part) => part.trim()).find((part) => /^pr:[\w.-]+\/[\w.-]+#\d+$/.test(part)) ?? null;
}

export async function verifyClaims(text, task, checks = {}) {
  const results = [];
  const checkSlackHead = checks.slackHasHead ?? slackHasHead;
  const getPrHead = checks.getPrHead ?? pullRequestHead;
  const signal = pullRequestSignal(text, task);
  let actualHead = null;
  if (signal) {
    try {
      const head = await getPrHead(signal);
      if (typeof head === "string" && /^[a-f0-9]{40}$/i.test(head)) actualHead = head.toLowerCase();
    } catch {}
  }
  const cursor = text.match(/\bCursor\s+(ACCEPT|APPROVE)\b/i);
  if (cursor) {
    const claimLine = text.slice(cursor.index).split("\n", 1)[0];
    const acceptedPrefix = claimLine.match(/\bhead\s*[:=]\s*([0-9a-f]{7,40})\b/i)?.[1]
      ?? claimLine.match(/\b(?:ACCEPT|APPROVE)\b[^\n]*?\b([0-9a-f]{7,40})\b/i)?.[1];
    const normalizedHead = acceptedPrefix
      ? actualHead
        ? headPrefixMatchesFull(actualHead, acceptedPrefix) ? actualHead : null
        : /^[a-f0-9]{40}$/i.test(acceptedPrefix) ? acceptedPrefix.toLowerCase() : null
      : null;
    let ok = false;
    if (normalizedHead && task?.sent_at) {
      try { ok = await checkSlackHead(normalizedHead, task.sent_at); } catch {}
    }
    results.push({
      kind: "cursor-accept",
      ok: Boolean(ok),
      head: normalizedHead,
      acceptedPrefix: acceptedPrefix?.toLowerCase() ?? null,
      actualHead,
      detail: !acceptedPrefix ? "head_missing_on_accept_line" : !normalizedHead ? "head_does_not_resolve_to_pr" : ok ? "slack_author_full_head_match" : "slack_author_or_head_mismatch",
    });
  }

  const ready = text.match(/\bPR READY\s+head=([0-9a-f]{7,40})\b/i);
  if (ready) {
    const acceptedPrefix = ready[1].toLowerCase();
    const ok = Boolean(actualHead && headPrefixMatchesFull(actualHead, acceptedPrefix));
    results.push({
      kind: "pr-ready",
      ok,
      head: ok ? actualHead : null,
      acceptedPrefix,
      actualHead,
      detail: !signal ? "pr_signal_missing" : ok ? "pr_head_match" : "pr_head_missing_or_mismatch",
    });
  }

  if (/\b(?:tests?\s+\d+\s+(?:passed|passing)|\d+\s+tests?\s+(?:passed|passing))\b/i.test(text)
    || /테스트\s*\d+\s*(?:개\s*)?통과/.test(text)) {
    results.push({ kind: "tests-count", ok: false, detail: "tests_count_is_not_evidence" });
  }
  return results;
}

export function claimEvent(catId, key, claim) {
  return `FLEET_CLAIM_${claim.ok ? "OK" : "FALSE"} ${catId} ${key} ${claim.kind} ${claim.detail}`;
}

function queueDispatch(catId, key, prompt, options, reason) {
  const { type = "impl", skill = "ulw", done = "", title = "", keepModel = false, after } = options;
  db.query(`INSERT INTO tasks(key,cat,title,prompt,skill,done,status,sent_at,depends_on,dispatch_type,keep_model)
    VALUES(?,?,?,?,?,?,'waiting',?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET cat=excluded.cat, title=excluded.title, prompt=excluded.prompt, skill=excluded.skill, done=excluded.done, status='waiting', sent_at=excluded.sent_at, result=NULL, evidence=NULL, depends_on=excluded.depends_on, dispatch_type=excluded.dispatch_type, keep_model=excluded.keep_model`)
    .run(key, catId, title || key, prompt, skill, done, now(), after || null, type, keepModel ? 1 : 0);
  log(key, { ev: after ? "dependency-wait" : "dispatch-wait", after: after || null, reason });
  return after ? `FLEET_DEPENDENCY_WAIT ${key} after=${after} ${reason}` : `FLEET_DISPATCH_WAIT ${key} cat=${catId} ${reason}`;
}

// Verified send (Dori panes.ts idea): only into an idle agent prompt, one send, then confirm the agent actually started.
export async function dispatch(catId, key, prompt, { type = "impl", skill = "ulw", done = "", title = "", keepModel = false, after = "", runCommand = executeSignalCommand, sleep = Bun.sleep, switchPaneModel = switchModel } = {}) {
  if (typeof key !== "string" || !key.trim()) throw new Error("INVALID_TASK_KEY");
  const c = db.query("SELECT * FROM cats WHERE id=?").get(catId);
  if (!c || c.pane === "-") throw new Error(`cat ${catId} has no pane`);
  const paneRead = async () => runCommand(["herdr", "pane", "read", c.pane, "--source", "visible", "--format", "text"]);
  let existing = db.query("SELECT cat,status FROM tasks WHERE key=?").get(key);
  if (existing?.status === "dispatching") {
    const screen = await paneRead();
    await recoverInterruptedDispatches(db, [{ id: catId, state: screen.exitCode === 0 ? classify(screen.stdout).state : "unknown" }]);
    existing = db.query("SELECT cat,status FROM tasks WHERE key=?").get(key);
  }
  if (existing && (existing.cat !== catId || !["waiting", "dispatch-interrupted", "dispatch-error"].includes(existing.status))) return `DISPATCH_HOLD ${catId} duplicate-key; not sent`;
  if (!(await Bun.file(prompt).exists())) throw new Error(`prompt file missing: ${prompt}`);
  if (after) {
    const predecessor = db.query("SELECT status FROM tasks WHERE key=?").get(after);
    if (predecessor?.status !== "verified-done") return queueDispatch(catId, key, prompt, { type, skill, done, title, keepModel, after }, `predecessor=${predecessor?.status ?? "unknown"}`);
  }
  const firstScreen = await paneRead();
  const paneScreen = firstScreen.exitCode === 0 ? firstScreen.stdout : "";
  const s0 = classify(paneScreen);
  if (!paneScreen.trim() || s0.state !== "idle") {
    return queueDispatch(catId, key, prompt, { type, skill, done, title, keepModel, after }, `pane=${paneScreen.trim() ? s0.state : "unreadable"}`);
  }
  const want = keepModel ? null : await pickModel(type);
  const claim = db.transaction(() => {
    const existing = db.query("SELECT key,cat,status FROM tasks WHERE key=?").get(key);
    if (existing && (existing.cat !== catId || !["waiting", "dispatch-interrupted", "dispatch-error"].includes(existing.status))) return { hold: "duplicate-key" };
    if (db.query("SELECT key FROM dispatch_reservations WHERE pane=?").get(c.pane)) return { hold: "pane-reserved" };
    const active = db.query(`SELECT t.key FROM tasks t JOIN cats c ON c.id=t.cat
      WHERE c.pane=? AND t.key!=? AND t.status NOT IN ('waiting','verified-done','blocked','prompt-lost','send-failed-unconfirmed','dispatch-interrupted','dispatch-error','dispatch-held','dispatch-failed-before-send') LIMIT 1`).get(c.pane, key);
    if (active) return { hold: "prior-task-unresolved" };
    const attempt = crypto.randomUUID();
    const model = want ? `${want.provider}/${want.model}:${want.thinking}` : "kept";
    if (existing) {
      db.query(`UPDATE tasks SET title=?,prompt=?,skill=?,model=?,done=?,status='dispatching',sent_at=?,started_at=NULL,ended_at=NULL,result=NULL,evidence=NULL,
        depends_on=?,dispatch_type=?,keep_model=? WHERE key=?`)
        .run(title || key, prompt, skill, model, done, now(), after || null, type, keepModel ? 1 : 0, key);
    } else {
      db.query(`INSERT INTO tasks(key,cat,title,prompt,skill,model,done,status,sent_at,depends_on,dispatch_type,keep_model,history)
        VALUES(?,?,?,?,?,?,?,'dispatching',?,?,?,?,?)`)
        .run(key, catId, title || key, prompt, skill, model, done, now(), after || null, type, keepModel ? 1 : 0, "[]");
    }
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)").run(c.pane, key, attempt, now());
    db.query("UPDATE cats SET task=? WHERE id=?").run(key, catId);
    return { attempt, model };
  }).immediate();
  if (claim.hold) return `DISPATCH_HOLD ${catId} ${claim.hold}; not sent`;
  const { attempt, model } = claim;
  let sendAttempted = false;
  const releaseUnsent = (status) => db.transaction(() => {
    if (!db.query("SELECT 1 FROM dispatch_reservations WHERE pane=? AND key=? AND attempt=?").get(c.pane, key, attempt)) return false;
    db.query("UPDATE tasks SET status=? WHERE key=?").run(status, key);
    db.query("DELETE FROM dispatch_reservations WHERE pane=? AND attempt=?").run(c.pane, attempt);
    return true;
  }).immediate();
  const ownsReservation = () => Boolean(db.query("SELECT 1 FROM dispatch_reservations WHERE pane=? AND key=? AND attempt=?").get(c.pane, key, attempt));
  let leaseHeartbeat;
  try {
    leaseHeartbeat = setInterval(() => {
      try {
        db.query("UPDATE dispatch_reservations SET reserved_at=? WHERE pane=? AND key=? AND attempt=?")
          .run(now(), c.pane, key, attempt);
      } catch {}
    }, 30_000);
    leaseHeartbeat.unref?.();
    const modelNote = keepModel ? "MODEL_KEPT" : await switchPaneModel(c.pane, want);
    if (modelNote.startsWith("MODEL_SWITCH_FAILED")) {
      if (!releaseUnsent("dispatch-held")) return `DISPATCH_HOLD ${catId} reservation-expired; not sent`;
      return modelNote;
    }
    const latest = await paneRead();
    if (latest.exitCode !== 0 || !latest.stdout.trim() || classify(latest.stdout).state !== "idle") {
      if (!releaseUnsent("waiting")) return `DISPATCH_HOLD ${catId} reservation-expired; not sent`;
      return queueDispatch(catId, key, prompt, { type, skill, done, title, keepModel, after }, `pane=${latest.stdout?.trim() ? classify(latest.stdout).state : "unreadable"}`);
    }
    if (!ownsReservation()) return `DISPATCH_HOLD ${catId} reservation-expired; not sent`;
    const head = `${key} [attempt=${attempt} skill:${skill}${done ? ` | Done= ${done}` : ""}]`;
    const msg = `${head}: 지시문 파일 ${prompt} 전체를 읽고 그대로 수행해. 끝나면 마지막 줄에 ${key}_DONE <한 줄 요약> 또는 ${key}_BLOCKED reason=<한 줄>.`;
    if (!recordDispatchSendAttempt(db, c.pane, key, attempt)) return `DISPATCH_HOLD ${catId} reservation-reclaimed; not sent`;
    sendAttempted = true;
    const text = await runCommand(["herdr", "pane", "send-text", c.pane, msg]);
    if (text.exitCode !== 0) throw new Error("SEND_TEXT_FAILED");
    await sleep(700);
    const enter = await runCommand(["herdr", "pane", "send-keys", c.pane, "Enter"]);
    if (enter.exitCode !== 0) throw new Error("SEND_ENTER_FAILED");
    db.query("UPDATE tasks SET status='sent-unconfirmed',sent_at=?,model=? WHERE key=?").run(now(), model, key);
    log(key, { ev: "sent-unconfirmed", attempt });
    for (let i = 0; i < 12; i++) {
      const screen = await paneRead();
      const state = screen.exitCode === 0 ? classify(screen.stdout).state : "unknown";
      if (state === "working") {
        db.query("UPDATE tasks SET status='working',started_at=? WHERE key=?").run(now(), key);
        log(key, { ev: "started", attempt });
        return `DISPATCH_OK ${catId} ${key} started (${modelNote})`;
      }
      if (state === "compaction-failed") {
        markTaskPromptLost(key, attempt);
        return `DISPATCH_PROMPT_LOST ${catId} ${key}: compaction failed; resend after compaction`;
      }
      if (i < 11) await sleep(5000);
    }
    log(key, { ev: "unconfirmed", attempt });
    return `DISPATCH_UNCONFIRMED ${catId} ${key}: no Working within 60s (watch keeps checking)`;
  } catch {
    if (sendAttempted) {
      db.query("UPDATE tasks SET status='send-failed-unconfirmed' WHERE key=?").run(key);
      log(key, { ev: "send-failed-unconfirmed", attempt });
      return `DISPATCH_UNCONFIRMED ${catId} ${key}: send failed; partial delivery not excluded`;
    }
    if (!releaseUnsent("dispatch-failed-before-send")) return `DISPATCH_HOLD ${catId} reservation-expired; not sent`;
    return `DISPATCH_FAILED ${catId} ${key}: not sent`;
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
  }
}

export async function dispatchWaitingTasks(dbHandle, paneRows, dispatchTask = dispatch) {
  const waiting = dbHandle.query("SELECT * FROM tasks WHERE status='waiting' ORDER BY sent_at").all();
  const paneStates = new Map(paneRows.map((row) => [row.id, row.state]));
  const events = [];
  for (const task of waiting) {
    try {
      if (task.depends_on) {
        const predecessor = dbHandle.query("SELECT status FROM tasks WHERE key=?").get(task.depends_on);
        if (predecessor?.status !== "verified-done") continue;
      }
      if (paneStates.get(task.cat) !== "idle") continue;
      const result = await dispatchTask(task.cat, task.key, task.prompt, {
        type: task.dispatch_type || "impl",
        skill: task.skill || "ulw",
        done: task.done || "",
        title: task.title || "",
        keepModel: Boolean(task.keep_model),
        after: task.depends_on,
      });
      events.push(`${task.depends_on ? "FLEET_DEPENDENCY_DISPATCH" : "FLEET_DISPATCH_RESUMED"} ${task.key} ${result}`);
    } catch (error) {
      const detail = `dispatch failed: ${String(error?.message ?? error).slice(0, 200)}`;
      try {
        const current = dbHandle.query("SELECT status FROM tasks WHERE key=?").get(task.key);
        const status = current?.status === "waiting" ? "dispatch-error" : "send-failed-unconfirmed";
        dbHandle.query("UPDATE tasks SET status=?,result=? WHERE key=?").run(status, detail, task.key);
        try { logOn(dbHandle, task.key, { ev: status, detail }); } catch {}
        events.push(`FLEET_DISPATCH_ERROR ${task.key} ${detail}`);
      } catch (recordError) {
        events.push(`FLEET_DISPATCH_ERROR ${task.key} ${detail}; record failed: ${String(recordError?.message ?? recordError).slice(0, 100)}`);
      }
    }
  }
  return events;
}

export async function dispatchQueuedDependencies(dbHandle, paneRows, dispatchTask = dispatch) {
  return dispatchWaitingTasks(dbHandle, paneRows, dispatchTask);
}

// Machine-checked done (Dori signals.ts idea). Spec: "pr:owner/repo#N" | "url:http://...=200" | "cmd:<shell>"; ';'-separated.
async function executeSignalCommand(argv) {
  const proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "ignore" });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { exitCode, stdout };
}

export async function checkSignal(sig, runCommand = executeSignalCommand) {
  sig = sig.trim();
  let m;
  if ((m = sig.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/))) {
    const command = await runCommand(["gh", "pr", "view", m[2], "--repo", m[1], "--json", "state,mergeCommit,headRefOid"]);
    let j = {};
    try { j = JSON.parse(command.stdout || "{}"); } catch {}
    return {
      ok: command.exitCode === 0 && j.state === "MERGED",
      detail: command.exitCode !== 0 ? `exit ${command.exitCode}` : j.state === "MERGED" ? `merged ${j.mergeCommit?.oid?.slice(0, 8)}` : `state=${j.state ?? "unknown"}`,
      headRefOid: /^[a-f0-9]{40}$/i.test(j.headRefOid || "") ? j.headRefOid : undefined,
      mergeCommit: /^[a-f0-9]{40}$/i.test(j.mergeCommit?.oid || "") ? j.mergeCommit.oid : undefined,
    };
  }
  if ((m = sig.match(/^url:(\S+)=(\d{3})$/))) {
    let url;
    try { url = new URL(m[1]); } catch { return { ok: false, detail: "invalid URL" }; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { ok: false, detail: "unsupported URL" };
    const command = await runCommand(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "6", "--", m[1]]);
    const code = command.stdout.trim();
    return { ok: command.exitCode === 0 && code === m[2], detail: `http ${/^\d{3}$/.test(code) ? code : "invalid"} exit ${command.exitCode}`, httpCode: /^\d{3}$/.test(code) ? Number(code) : undefined };
  }
  if ((m = sig.match(/^cmd:(.+)$/))) {
    const r = await runCommand(["bash", "-c", m[1]]);
    return { ok: r.exitCode === 0, detail: `exit ${r.exitCode}` };
  }
  return { ok: false, detail: `unparseable signal: ${sig}` };
}

export async function verify(key, check = checkSignal) {
  const t = db.query("SELECT * FROM tasks WHERE key=?").get(key);
  if (!t) throw new Error(`no task ${key}`);
  if (t.status === "verified-done") return `VERIFIED_DONE ${key}: already verified`;
  const history = JSON.parse(t.history || "[]");
  const hasCompletionClaim = history.some((event) => event.ev === "done-claimed");
  if (t.status !== "done-claimed" && !(t.status === "not-done" && hasCompletionClaim)) return `VERIFY_UNCONFIRMED ${key}: worker completion claim missing`;
  if (!t.done) return `VERIFY_NO_SIGNAL ${key}: no Done= spec; cannot be verified-done`;
  const res = [];
  for (const s of t.done.split(";").map((part) => part.trim()).filter(Boolean)) res.push({ s, ...(await check(s)) });
  const claims = history.filter((event) => event.ev === "claim-ok" || event.ev === "claim-false");
  const prSignals = res.filter((result) => parsePullRequestSignal(result.s));
  const requiredClaims = prSignals.map((result) => {
    const headRefOid = /^[a-f0-9]{40}$/i.test(result.headRefOid || "") ? result.headRefOid.toLowerCase() : null;
    const cursorAccept = headRefOid && claims.findLast((event) => event.ev === "claim-ok"
      && event.claim === "cursor-accept"
      && event.head?.toLowerCase() === headRefOid
      && event.actualHead?.toLowerCase() === headRefOid);
    const prReady = headRefOid && claims.findLast((event) => event.ev === "claim-ok"
      && event.claim === "pr-ready"
      && event.head?.toLowerCase() === headRefOid
      && event.actualHead?.toLowerCase() === headRefOid
    );
    return { headRefOid, cursorAccept, prReady };
  });
  const hasPrSignal = res.some((result) => parsePullRequestSignal(result.s));
  const claimsOk = !hasPrSignal || (requiredClaims.length > 0
    && requiredClaims.every((claim) => claim.headRefOid && claim.cursorAccept && claim.prReady));
  const ok = res.length > 0 && res.every((result) => result.ok) && claimsOk;
  const reserved = db.query("SELECT attempt FROM dispatch_reservations WHERE key=?").get(key);
  const reservedEvent = history.findLast((event) => event.ev === "reserved");
  const evidence = JSON.stringify({
    attempt: reserved?.attempt ?? reservedEvent?.attempt ?? null,
    checkedAt: now(),
    claims: requiredClaims.map(({ headRefOid, cursorAccept, prReady }) => ({
      headRefOid,
      cursorAccept: {
        headRefOid: cursorAccept ? headRefOid : null,
        acceptedPrefix: cursorAccept?.acceptedPrefix ?? null,
        ok: Boolean(cursorAccept),
        detail: cursorAccept?.detail ?? "missing_or_wrong_head",
      },
      prReady: {
        headRefOid: prReady ? headRefOid : null,
        acceptedPrefix: prReady?.acceptedPrefix ?? null,
        actualHead: prReady?.actualHead ?? null,
        ok: Boolean(prReady),
        detail: prReady?.detail ?? "missing_or_wrong_head",
      },
    })),
    signals: res.map((result) => ({ signal: result.s, ok: result.ok, detail: result.detail, headRefOid: result.headRefOid, mergeCommit: result.mergeCommit, httpCode: result.httpCode })),
  });
  db.transaction(() => {
    db.query("UPDATE tasks SET status=?, evidence=?, ended_at=? WHERE key=?").run(ok ? "verified-done" : "not-done", evidence, ok ? now() : null, key);
    if (ok) db.query("DELETE FROM dispatch_reservations WHERE key=?").run(key);
  }).immediate();
  log(key, { ev: ok ? "verified" : "not-done", detail: evidence });
  return `${ok ? "VERIFIED_DONE" : "NOT_DONE"} ${key}: ${evidence}`;
}

export async function track(key, cat, done, title) {
  return db.transaction(() => {
    if (db.query("SELECT key FROM tasks WHERE key=?").get(key)) return `TRACK_HOLD ${key}: duplicate-key`;
    const c = db.query("SELECT * FROM cats WHERE id=?").get(cat);
    if (!c) throw new Error("NO_CAT");
    if (db.query("SELECT key FROM dispatch_reservations WHERE pane=?").get(c.pane)
      || db.query(`SELECT key FROM tasks WHERE cat=? AND status NOT IN ('verified-done','blocked','prompt-lost','send-failed-unconfirmed','dispatch-interrupted','dispatch-error','dispatch-held','dispatch-failed-before-send') LIMIT 1`).get(cat)) {
      return `TRACK_HOLD ${key}: prior-task-unresolved`;
    }
    db.query("INSERT INTO tasks(key,cat,title,done,status,sent_at) VALUES(?,?,?,?,'tracked-unconfirmed',?)").run(key, cat, title || key, done || "", now());
    db.query("UPDATE cats SET task=? WHERE id=?").run(key, cat);
    return `TRACKED_UNCONFIRMED ${key} on ${cat}`;
  }).immediate();
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

async function commandOutput(command, args, cwd, signal = AbortSignal.timeout(10000)) {
  try {
    const proc = Bun.spawn([command, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
      signal,
    });
    const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

async function repositoryName(repoRoot) {
  const remote = await commandOutput("git", ["remote", "get-url", "origin"], repoRoot);
  return remote?.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i)?.[1] ?? null;
}

async function pullRequestInfo(repo, number, repoRoot) {
  const fields = "number,title,url,state,isDraft,headRefOid,reviewDecision,statusCheckRollup";
  const text = await commandOutput("gh", ["pr", "view", String(number), "--repo", repo, "--json", fields], repoRoot);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function pullRequestsForBranch(repo, branch, repoRoot) {
  const fields = "number,title,url,state,isDraft";
  const text = await commandOutput("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", fields], repoRoot);
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function bugbotState(checkRuns) {
  if (!checkRuns) return "UNKNOWN";
  const run = checkRuns.find((check) => check.name === "Cursor Bugbot");
  if (!run) return "NOT_REPORTED";
  if (isBugbotUsageLimit(checkRuns)) return "USAGE_LIMIT";
  if (run.status !== "completed") return String(run.status || "UNKNOWN").toUpperCase();
  return String(run.conclusion || "COMPLETED").toUpperCase();
}

export function shouldSuppressGajae(seen, key, nowMs = Date.now()) {
  for (const [seenKey, seenAt] of seen) {
    if (nowMs - seenAt >= 30 * 60_000) seen.delete(seenKey);
  }
  if (seen.has(key) && nowMs - seen.get(key) < 30 * 60_000) return true;
  seen.set(key, nowMs);
  return false;
}

async function board() {
  const repoRoot = new URL("..", import.meta.url).pathname;
  const [cats, repo, branch] = await Promise.all([
    refresh(),
    repositoryName(repoRoot),
    commandOutput("git", ["branch", "--show-current"], repoRoot),
  ]);
  const branchPullRequests = repo && branch ? await pullRequestsForBranch(repo, branch, repoRoot) : null;
  const signals = new Map();
  if (repo) signals.set(`pr:${repo}#2`, "roadmap");
  for (const pr of branchPullRequests ?? []) signals.set(`pr:${repo}#${pr.number}`, "current-branch");
  const tasks = db.query(`SELECT key,done FROM tasks
    WHERE status IN ('sent','sent-unconfirmed','send-failed-unconfirmed','tracked-unconfirmed','working','done-claimed') AND done IS NOT NULL AND done!=''
    ORDER BY sent_at DESC LIMIT 20`).all();
  for (const task of tasks) {
    try {
      for (const signal of task.done.split(";").map((part) => part.trim())) {
        if (parsePullRequestSignal(signal) && !signals.has(signal)) signals.set(signal, task.key);
      }
    } catch {}
  }

  const pullRequests = [];
  for (const [signal, source] of signals) {
    try {
      const target = parsePullRequestSignal(signal);
      const info = await pullRequestInfo(target.repo, target.number, repoRoot);
      const checkRuns = info?.headRefOid ? await checkRunsForHead(target.repo, info.headRefOid) : null;
      pullRequests.push({ target, source, info, checkRuns });
    } catch {}
  }
  const bySignal = new Map(pullRequests.map((pr) => [`pr:${pr.target.repo}#${pr.target.number}`, pr]));
  const prior = repo ? bySignal.get(`pr:${repo}#2`) : null;
  const current = branchPullRequests?.[0] ?? null;
  const priorState = prior?.info?.state === "MERGED"
    ? "DONE"
    : prior?.info
      ? `IN_PR #2 ${prior.info.state || "UNKNOWN"}${prior.info.isDraft ? " draft" : ""}`
      : "UNKNOWN (PR #2 unavailable)";
  const currentState = branchPullRequests === null
    ? `UNKNOWN (branch=${branch || "UNKNOWN"}; PR query unavailable)`
    : current
      ? current.state === "MERGED"
        ? `DONE (PR #${current.number})`
        : `IN_PR #${current.number} ${current.state || "UNKNOWN"}${current.isDraft ? " draft" : ""}`
      : branch
        ? `IMPLEMENTED_IN_BRANCH ${branch} (PR_NOT_CREATED)`
        : "UNKNOWN (branch unavailable)";
  const itemStatus = (n) => [3, 4, 6, 8].includes(n) ? currentState : priorState;
  const roadmap = [
    `1. Dependency auto-link — ${itemStatus(1)}`,
    `2. Claim verification — ${itemStatus(2)}`,
    `3. Model-specific wait/recovery — ${itemStatus(3)}`,
    `4. Provider usage/Bugbot alerts — ${itemStatus(4)}`,
    "5. Usage inventory — NOT_STARTED",
    `6. Allowlisted question handling — ${itemStatus(6)}`,
    "7. Pane context management — NOT_STARTED",
    `8. Fleet board — ${itemStatus(8)}`,
  ];
  const catLines = cats.length
    ? cats.map((cat) => {
      const task = cat.task ? db.query("SELECT status FROM tasks WHERE key=?").get(cat.task) : null;
      return `- ${cat.name} (${cat.id}, ${cat.pane}): ${cat.state}; model=${cat.model || "UNKNOWN"}; task=${cat.task || "NONE"}${task ? ` (${task.status})` : ""}`;
    })
    : ["- UNKNOWN (fleet not initialized)"];
  const prLines = pullRequests.length
    ? pullRequests.map(({ target, info }) => info
      ? `- #${target.number} ${info.state || "UNKNOWN"}${info.isDraft ? " draft" : ""} ${String(info.title || "").replace(/\s+/g, " ").trim()} head=${info.headRefOid?.slice(0, 7) || "UNKNOWN"}`
      : `- #${target.number} UNKNOWN (GitHub data unavailable)`)
    : ["- UNKNOWN (no PR references or GitHub data unavailable)"];
  const reviewLines = pullRequests.length
    ? pullRequests.map(({ target, info, checkRuns }) => {
      const decision = info?.reviewDecision || "UNKNOWN";
      const wait = decision === "REVIEW_REQUIRED" ? "WAITING" : decision === "APPROVED" ? "NO" : "UNKNOWN";
      return `- #${target.number} wait=${wait} decision=${decision} Cursor Bugbot=${bugbotState(checkRuns)}`;
    })
    : ["- UNKNOWN (no PR review data)"];
  return [
    `FLEET BOARD ${now()}`,
    "Roadmap items 1-8:",
    ...roadmap,
    "Fleet cats:",
    ...catLines,
    "Pull requests:",
    ...prLines,
    "Review wait:",
    ...reviewLines,
    "Deployment: NOT_RUN",
    "Production deployment: UNKNOWN",
  ].join("\n");
}

// Watch: emits only transitions. Gajae: surface recovery_hold / speech suppressed with reason.
async function watch(intervalSec = 30) {
  const last = new Map();
  const usageAlerted = new Map();
  const bugbotAlerted = new Map();
  const reviewStallAlerted = new Set();
  // journalctl --since takes local time; keep the cursor in epoch seconds to avoid TZ drift.
  let jcursor = Math.floor(Date.now() / 1000) - 60;
  for (;;) {
    try {
      const rows = await refresh();
      for (const event of await recoverInterruptedDispatches(db, rows)) console.log(event);
      for (const r of rows) {
        try {
        const sig = JSON.stringify({ state: r.state, doneKey: r.done?.key ?? "", doneKind: r.done?.kind ?? "", doneText: r.done?.text ?? "", readyLine: r.readyLine ?? "", readyHead: r.ready?.head ?? "", claimText: r.claimText ?? "", questionText: r.questionText ?? "" });
        const previous = last.has(r.id) ? JSON.parse(last.get(r.id)) : null;
        if (previous && last.get(r.id) !== sig) {
          if (r.state !== previous.state && r.id !== "omonyang") console.log(`FLEET_STATE ${r.id} ${previous.state} -> ${r.state}`);
          const doneChanged = r.id !== "omonyang" && r.done && (r.done.key !== previous.doneKey || r.done.kind !== previous.doneKind);
          const readyChanged = r.ready && r.ready.head !== previous.readyHead;
          const readyLineChanged = r.readyLine && r.readyLine !== previous.readyLine;
          const claimTextChanged = r.claimText && r.claimText !== previous.claimText;
          if (doneChanged) {
            console.log(`FLEET_TASK_${r.done.kind} ${r.id} ${r.done.key} ${r.done.text}`);
            if (r.done.kind === "BLOCKED") markTaskBlocked(r.done.key, r.done.text);
            else {
              db.query("UPDATE tasks SET status='done-claimed', result=? WHERE key=?").run(r.done.text, r.done.key);
              log(r.done.key, { ev: "done-claimed", text: r.done.text });
            }
          }
          if (doneChanged || readyChanged || readyLineChanged || claimTextChanged) {
            const taskKey = r.done?.key ?? r.task;
            const task = taskKey ? db.query("SELECT * FROM tasks WHERE key=?").get(taskKey) : null;
            const claims = await verifyClaims(r.claimText ?? "", task);
            for (const claim of claims) {
              console.log(claimEvent(r.id, taskKey ?? "-", claim));
              if (taskKey) log(taskKey, { ev: claim.ok ? "claim-ok" : "claim-false", claim: claim.kind, head: claim.head, acceptedPrefix: claim.acceptedPrefix, actualHead: claim.actualHead, detail: claim.detail });
            }
            if (readyChanged && claims.some((claim) => claim.kind === "pr-ready" && claim.ok)) {
              console.log(`FLEET_PR_READY ${r.id} ${r.ready.repo} ${r.ready.head}`);
            }
          }
          if (r.id !== "omonyang" && readyLineChanged) console.log(`FLEET_READY_LINE ${r.id} ${r.readyLine}`);
        }
        let retryQuestion = false;
        const questionChanged = r.id !== "omonyang" && r.state === "question"
          && (!previous || previous.state !== "question" || r.questionText !== previous.questionText);
        if (questionChanged) {
          const taskKey = r.task || "-";
          const policy = questionPolicy(r.questionText || "");
          if (policy) {
            let answered = false;
            try { answered = await answerPaneQuestion(r.pane, r.questionText, policy.answer); } catch {}
            if (answered) {
              console.log(`FLEET_QUESTION_ANSWERED ${r.id} ${taskKey} policy=${policy.id}`);
              if (taskKey !== "-") log(taskKey, { ev: "question-auto-answer", policy: policy.id });
            } else {
              console.log(`FLEET_QUESTION_SEND_FAILED ${r.id} ${taskKey} policy=${policy.id}`);
              retryQuestion = true;
            }
          } else {
            const excerpt = (r.questionText || "unreadable").replace(/[\r\n\t]+/g, " ").replaceAll('"', "'").slice(0, 180);
            console.log(`FLEET_QUESTION_NOTIFY owner=omonyang ${r.id} ${taskKey} question="${excerpt}"`);
            if (taskKey !== "-") log(taskKey, { ev: "question-owner-notify", excerpt });
          }
        }
        if (!retryQuestion) last.set(r.id, sig);
        if (r.task) {
          const t = db.query("SELECT status,sent_at FROM tasks WHERE key=?").get(r.task);
          if (["sent-unconfirmed", "send-failed-unconfirmed", "tracked-unconfirmed"].includes(t?.status) && r.state === "working") {
            db.query("UPDATE tasks SET status='working', started_at=? WHERE key=?").run(now(), r.task);
            console.log(`FLEET_TASK_STARTED ${r.id} ${r.task}`);
          }
          if (["sent", "sent-unconfirmed", "send-failed-unconfirmed", "working"].includes(t?.status)) {
            if (r.state === "compaction-failed") { markTaskPromptLost(r.task); console.log(`FLEET_PROMPT_LOST ${r.id} ${r.task}`); }
          }
        }
        } catch (e) {
          console.log(`FLEET_WATCH_CAT_ERROR ${r.id} ${e?.message ?? e}`);
        }
      }
      for (const event of usageLimitEvents(await usageTick(), usageAlerted)) console.log(event);
      for (const event of await bugbotLimitEvents(db, bugbotAlerted)) console.log(event);
      for (const event of await reviewStallEvents(Date.now(), reviewStallAlerted)) console.log(event);
      for (const event of await dispatchWaitingTasks(db, rows)) console.log(event);
      const w5 = rows.find((r) => r.id === "omonyang");
      const listen = (await sh("pgrep -f 'bun slack-listen.mjs' | head -1")).trim();
      db.query("INSERT INTO beats(who,at,detail) VALUES('omonyang',?,?) ON CONFLICT(who) DO UPDATE SET at=excluded.at, detail=excluded.detail")
        .run(now(), JSON.stringify({ pane: w5?.state, model: w5?.model, slackListen: listen || null }));
      await Bun.write(`${STATE}/captain-heartbeat.json`, JSON.stringify({ at: now(), pane: w5?.state, model: w5?.model, slackListen: listen || null }) + "\n");
      const next = Math.floor(Date.now() / 1000);
      const j = await sh(`journalctl --user -u gajaeway-gateway --since @${jcursor} --until @${next} --no-pager 2>/dev/null | grep -E 'recovery_hold|speech suppressed' | tail -5`);
      jcursor = next;
      globalThis.gajaeSeen ??= new Map();
      for (const line of j.split("\n").filter(Boolean)) {
        const reason = line.match(/reason=(\S+)/)?.[1] ?? line.match(/suppressed \([^,]+, (\w+)\)/)?.[1] ?? "?";
        const origin = line.match(/origin=slack\/\w+\/([A-Z0-9]+:[\d.]+)/)?.[1] ?? "";
        if (shouldSuppressGajae(globalThis.gajaeSeen, `${reason} ${origin}`)) continue;
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
    status, report, board,
    dispatch: () => dispatch(a[0], a[1], a[2], { type: opt("type"), skill: opt("skill"), done: opt("done"), title: opt("title"), keepModel: a.includes("--keep-model"), after: opt("after") }),
    track: () => track(a[0], a[1], opt("done"), opt("title")),
    verify: () => verify(a[0]),
    tasks: async () => db.query("SELECT key,cat,status,depends_on,skill,model,done,evidence FROM tasks ORDER BY sent_at DESC LIMIT 20").all().map((t) => JSON.stringify(t)).join("\n"),
    beat: async () => JSON.stringify(db.query("SELECT * FROM beats").all()),
    routes: async () => JSON.stringify(ROUTES, null, 1),
    watch: () => watch(Number(a[0] || 30)),
  }[cmd] ?? (async () => "usage: fleet init|status|report|board|dispatch <cat> <KEY> <prompt> [--after <KEY>] [--type plan|impl|review|secure|quick] [--skill ulw|ulw-loop|mass-ulw|ulw-plan|ulw-execute|ulw-research] [--done 'pr:o/r#N;url:..=200;cmd:..'] [--keep-model]|track <KEY> <cat> --done ..|verify <KEY>|tasks|beat|routes|watch [sec]"))();
  if (out !== undefined) console.log(out);
}
