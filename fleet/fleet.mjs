#!/usr/bin/env bun
// 오모냥 fleet: registry of every 냥이 (worker pane / bot), verified dispatch, machine-checked done, watch.
// Ideas taken from Dori (lane registry, verified pane send, Done= signals) and Gajae (accepted != done, no blind re-run).
import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STATE = `${process.env.HOME}/.local/state/omonyang`;
mkdirSync(STATE, { recursive: true });
const db = new Database(`${STATE}/fleet.sqlite`);
db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS cats(id TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT, pane TEXT, product TEXT, state TEXT, model TEXT, task TEXT, last_seen TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS tasks(key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT, done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT, result TEXT, evidence TEXT, history TEXT DEFAULT '[]', depends_on TEXT, dispatch_type TEXT DEFAULT 'impl', keep_model INTEGER DEFAULT 0, completion_claimed INTEGER NOT NULL DEFAULT 0, send_attempted INTEGER NOT NULL DEFAULT 0, dispatch_attempt TEXT, claim_evidence TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS beats(who TEXT PRIMARY KEY, at TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS dispatch_reservations(pane TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, attempt TEXT NOT NULL, reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, recovery_token TEXT, recovery_started_at TEXT);
CREATE TABLE IF NOT EXISTS fleet_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_alerts(key TEXT PRIMARY KEY, alerted_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_review_requests(ts TEXT PRIMARY KEY, channel TEXT, thread_ts TEXT, user TEXT, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_pr_loop(
  repo TEXT NOT NULL, pr_number TEXT NOT NULL, head TEXT NOT NULL, task_key TEXT NOT NULL,
  state TEXT NOT NULL, request_ts TEXT, verdict TEXT, verdict_ts TEXT, merge_sha TEXT, merge_pending_since TEXT,
  merge_ambiguous_since TEXT,
  post_lease_token TEXT, post_lease_until TEXT, reject_lease_token TEXT, reject_lease_until TEXT, reject_sent_at TEXT,
  reject_delivery_attempt TEXT, reject_submit_confirmed_at TEXT,
  merge_lease_token TEXT, merge_lease_until TEXT,
  merge_failure_count INTEGER NOT NULL DEFAULT 0, merge_ambiguous_count INTEGER NOT NULL DEFAULT 0,
  merge_retry_at TEXT, merge_failure_reason TEXT,
  deploy_lease_token TEXT, deploy_lease_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(repo,pr_number,head)
);`);
export function migrateFleetColumns(dbHandle) {
  return dbHandle.transaction(() => {
    const addMissing = (table, definitions) => {
      const columns = new Set(dbHandle.query(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      for (const [name, definition] of definitions) {
        if (columns.has(name)) continue;
        dbHandle.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        columns.add(name);
      }
    };
    addMissing("tasks", [
      ["depends_on", "TEXT"],
      ["dispatch_type", "TEXT DEFAULT 'impl'"],
      ["keep_model", "INTEGER DEFAULT 0"],
      ["completion_claimed", "INTEGER NOT NULL DEFAULT 0"],
      ["send_attempted", "INTEGER NOT NULL DEFAULT 0"],
      ["dispatch_attempt", "TEXT"],
      ["claim_evidence", "TEXT NOT NULL DEFAULT '{}'"],
    ]);
    addMissing("dispatch_reservations", [
      ["reserved_at", "TEXT NOT NULL DEFAULT ''"],
      ["recovery_token", "TEXT"],
      ["recovery_started_at", "TEXT"],
    ]);
    addMissing("fleet_pr_loop", [
      ["verdict", "TEXT"],
      ["merge_pending_since", "TEXT"],
      ["merge_ambiguous_since", "TEXT"],
      ["post_lease_token", "TEXT"],
      ["post_lease_until", "TEXT"],
      ["reject_lease_token", "TEXT"],
      ["reject_lease_until", "TEXT"],
      ["reject_sent_at", "TEXT"],
      ["reject_delivery_attempt", "TEXT"],
      ["reject_submit_confirmed_at", "TEXT"],
      ["merge_lease_token", "TEXT"],
      ["merge_lease_until", "TEXT"],
      ["merge_failure_count", "INTEGER NOT NULL DEFAULT 0"],
      ["merge_ambiguous_count", "INTEGER NOT NULL DEFAULT 0"],
      ["merge_retry_at", "TEXT"],
      ["merge_failure_reason", "TEXT"],
      ["deploy_lease_token", "TEXT"],
      ["deploy_lease_until", "TEXT"],
    ]);
    dbHandle.query("UPDATE dispatch_reservations SET reserved_at=? WHERE reserved_at=''").run(new Date().toISOString());
    for (const task of dbHandle.query("SELECT key,status,history,completion_claimed,send_attempted,claim_evidence FROM tasks WHERE completion_claimed=0 OR send_attempted=0 OR claim_evidence='{}'").all()) {
      const history = JSON.parse(task.history || "[]");
      const completionClaimed = task.completion_claimed || task.status === "done-claimed" || history.some((event) => event.ev === "done-claimed");
      const sendAttempted = task.send_attempted || history.some((event) => event.ev === "send-attempted");
      const claimEvidence = JSON.parse(task.claim_evidence || "{}");
      for (const event of history) {
        if (["cursor-accept", "pr-ready"].includes(event.claim)
          && ["claim-ok", "claim-false"].includes(event.ev)) {
          const signal = event.signal || "_legacy";
          claimEvidence[signal] ??= {};
          claimEvidence[signal][event.claim] = {
            ok: event.ev === "claim-ok",
            head: event.head ?? null,
            acceptedPrefix: event.acceptedPrefix ?? null,
            actualHead: event.actualHead ?? null,
            detail: event.detail ?? null,
          };
        }
      }
      if (completionClaimed || sendAttempted || JSON.stringify(claimEvidence) !== task.claim_evidence) {
        dbHandle.query("UPDATE tasks SET completion_claimed=?,send_attempted=?,claim_evidence=? WHERE key=?")
          .run(completionClaimed ? 1 : 0, sendAttempted ? 1 : 0, JSON.stringify(claimEvidence), task.key);
      }
    }
  }).immediate();
}
migrateFleetColumns(db);

const now = () => new Date().toISOString();
const reportedFleetErrors = new Set();
function fleetError(kind, context, error) {
  const message = String(error?.message ?? error ?? "unknown error").replace(/\s+/g, " ").slice(0, 120);
  const line = `FLEET_${kind}_ERROR ${context} ${message || "unknown error"}`;
  if (reportedFleetErrors.has(line)) return;
  reportedFleetErrors.add(line);
  console.log(line);
}

const sh = async (cmd) => (await Bun.$`bash -c ${cmd}`.nothrow().quiet()).stdout.toString();
const read = (pane) => sh(`herdr pane read ${pane} --source visible --format text 2>/dev/null`);
const readPaneResult = (pane) => executeSignalCommand(["herdr", "pane", "read", pane, "--source", "visible", "--format", "text"]);
const ROUTES = JSON.parse(await Bun.file(new URL("./routes.json", import.meta.url)).text());
export function resolveFleetConfig(config, env = process.env) {
  const envBoolean = (value, fallback) => value === undefined ? Boolean(fallback) : value === "true";
  return {
    ...config,
    cats: config.cats.map((cat) => {
      const envKey = `FLEET_CAT_${cat.id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_PANE`;
      return { ...cat, pane: env[envKey] || cat.pane };
    }),
    slack: {
      ...config.slack,
      reviewChannel: env.FLEET_SLACK_REVIEW_CHANNEL || config.slack.reviewChannel,
      cursorUserId: env.FLEET_CURSOR_USER_ID || config.slack.cursorUserId,
      reviewReplyAppId: env.FLEET_REVIEW_REPLY_APP_ID || config.slack.reviewReplyAppId,
    },
    prLoop: {
      ...config.prLoop,
      enabled: envBoolean(env.FLEET_PR_LOOP_ENABLED, config.prLoop?.enabled),
      autoMerge: envBoolean(env.FLEET_PR_LOOP_AUTO_MERGE, config.prLoop?.autoMerge),
      deploy: config.prLoop?.deploy ?? {},
      mergeMethods: config.prLoop?.mergeMethods ?? {},
    },
    agentMessengerCredentialPath: env.FLEET_AGENT_MESSENGER_CREDENTIAL_PATH
      || config.agentMessengerCredentialPath,
  };
}
const CONFIG = resolveFleetConfig(JSON.parse(await Bun.file(new URL("./fleet.config.json", import.meta.url)).text()));
const CURSOR_USER_ID = CONFIG.slack.cursorUserId;
const REVIEW_RELAY_USER_ID = "U0B81F5GR6V";
const SLACK_REVIEW_CHANNEL = CONFIG.slack.reviewChannel;
const REVIEW_REPLY_APP_ID = CONFIG.slack.reviewReplyAppId;
const REVIEW_STALL_MS = 45 * 60 * 1000;
const USAGE_ALERT_THRESHOLDS = { anthropic: 60, "chatgpt-subscription": 80 };
const DISPATCH_RESERVATION_TTL_MS = 2 * 60_000;
const SLACK_THREAD_CONCURRENCY = 5;
const SLACK_HISTORY_TIMEOUT_MS = 15_000;
const SLACK_HISTORY_BOOTSTRAP_DAYS = 30;

function isQuestionStatusLine(line) {
  return /^\s*(?:Question pending|Unanswered)\s*$/i.test(String(line ?? ""));
}

const CATS = CONFIG.cats.map(({ id, name, role, kind, pane, product }) => [id, name, role, kind, pane, product]);
const CONFIGURED_CAT_PANES = new Map(CONFIG.cats.map(({ id, pane }) => [id, pane]));

export function configuredCatPane(catId, fallback = null) {
  return CONFIGURED_CAT_PANES.get(catId) ?? fallback;
}

function completionPromptTemplate(line, key, kind, tail) {
  const normalized = line.replace(/^\s*[`*_~]+/, "").replace(/[`*_~]+\s*$/, "").replace(/\s+/g, " ").trim();
  const normalizedTail = tail.replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/\s+/g, "");
  const compactTail = normalizedTail.replace(/\s+/g, "");
  if (kind === "DONE" && (compact.includes("<한줄요약>") || compactTail.includes("<한줄요약>"))) return true;
  if (kind === "BLOCKED" && (compact.includes("reason=<한줄>") || compactTail.startsWith("reason=<한줄>"))) return true;
  const prefix = normalized.slice(0, normalized.indexOf(`${key}_${kind}`));
  return (kind === "DONE" && normalizedTail === "<summary>" && /instructions|finish with/i.test(prefix))
    || (kind === "BLOCKED" && normalizedTail === "reason=<one line>");
}

function completionMarkerOnLine(line) {
  let text = String(line ?? "").trimStart();
  text = text.replace(/^(?:(?:[-•●⏺✻>])\s*|[*_`~]+\s*)+/, "").replace(/[*_`~]+\s*$/, "").trimEnd();
  const match = text.match(/^(TASK-[A-Z0-9-]+)_(DONE|BLOCKED)\b(.*)$/i);
  return match ? { key: match[1], kind: match[2].toUpperCase(), tail: match[3] } : null;
}

function completionContinuationBoundary(line) {
  return /^\s*(?:❯|[•●]|[-*]\s|⏺|✻|TPS\b|Warning:|Error:|Extension\b|Bash\(|Tool call\b|[─━═-]{3,})/i.test(line);
}

function parseCompletionCandidates(screen) {
  const lines = String(screen ?? "").replace(/\r/g, "").split("\n");
  const dividers = lines.flatMap((line, index) => /^\s*[─━═-]{3,}\s*$/.test(line) ? [index] : []);
  const inputBoxLines = new Set();
  for (const promptIndex of lines.flatMap((line, index) => /^\s*❯/.test(line) ? [index] : [])) {
    const start = dividers.findLast((index) => index < promptIndex);
    const end = dividers.find((index) => index > promptIndex);
    if (start === undefined || end === undefined) continue;
    for (let index = start; index <= end; index++) inputBoxLines.add(index);
  }
  const transcript = lines.map((line, index) => inputBoxLines.has(index) ? null : line);
  const candidates = [];
  for (let index = 0; index < transcript.length; index++) {
    const line = transcript[index];
    if (line === null) continue;
    const marker = completionMarkerOnLine(line);
    if (!marker) continue;
    const { key, kind } = marker;
    let tail = marker.tail;
    const continuationLines = [];
    for (let next = index + 1; next < transcript.length; next++) {
      const continuation = transcript[next];
      if (continuation === null || !continuation.trim() || completionMarkerOnLine(continuation)
        || completionContinuationBoundary(continuation)) break;
      continuationLines.push(continuation.trim());
      tail += ` ${continuation.trim()}`;
    }
    const attemptMatch = tail.match(/(?:^|[\s—–-]\s*)attempt\s*(?:=|:)\s*((?:[a-f0-9-]\s*){36})(?=\s|$)/i);
    const attempt = attemptMatch?.[1].replace(/\s/g, "") ?? null;
    let summary = attemptMatch
      ? `${tail.slice(0, attemptMatch.index)} ${tail.slice(attemptMatch.index + attemptMatch[0].length)}`
      : tail;
    summary = summary.replace(/^[\s—–-]+|[`*_~]+$/g, "").replace(/\s*\n\s*/g, " ").trim();
    const templateContext = [line, ...continuationLines].join(" ");
    candidates.push({
      key, kind, attempt, text: summary,
      filtered: completionPromptTemplate(templateContext, key, kind, summary),
    });
  }
  return candidates;
}

export function classify(screen) {
  const L = screen.split("\n");
  const tail = L.slice(-14).join("\n");
  const footer = [...screen.matchAll(/(?:⚡|\([a-z-]+\)|\s)\s*([a-z][A-Za-z0-9._-]+):(low|medium|high|xhigh|minimal|off)\s*$/gm)].at(-1);
  const model = footer ? `${footer[1]}:${footer[2]}` : "";
  let state = "idle";
  if (/compaction did not complete/i.test(tail) && !/Working \(/.test(tail)) state = "compaction-failed";
  else if (/Compacting/i.test(tail)) state = "compacting";
  else if (/Working \(|Running eval|esc to interrupt/.test(tail)) state = "working";
  else if (L.slice(-14).some(isQuestionStatusLine)) state = "question";
  else if (/Codex error|rate limit|usage limit|429|quota|Unable to verify/i.test(tail)) state = "provider-error";
  else if (/→\s+\S+\s+\[[^\]]+\]/.test(tail)) state = "model-picker";
  const output = responseBlock(screen);
  const doneCandidates = parseCompletionCandidates(screen);
  const parsedDone = doneCandidates.filter((candidate) => !candidate.filtered && candidate.attempt).at(-1);
  const done = parsedDone
    ? { key: parsedDone.key, kind: parsedDone.kind, attempt: parsedDone.attempt, text: parsedDone.text }
    : null;
  const ready = [...output.matchAll(/\b([A-Za-z0-9_.-]+) PR READY head=([0-9a-f]{7,40})\b/gi)].at(-1);
  // Result lines wrap in narrow panes: also look at the latest output block.
  const joined = output.split("\n").slice(-40).map((l) => l.trim()).join(" ");
  const readyLine = [...joined.matchAll(/\b([A-Z]+_[A-Z_]*READY)\b([^❯─]{0,400})/g)].at(-1);
  const claimText = output.split("\n").filter((line) => /\bCursor\s+(?:ACCEPT|APPROVE)\b|\bPR READY\s+head=|\b(?:tests?\s+\d+\s+(?:passed|passing)|\d+\s+tests?\s+(?:passed|passing))\b|테스트\s*\d+\s*(?:개\s*)?통과/i.test(line)).join("\n");
  let questionText = "";
  if (state === "question") {
    const screenLines = screen.replace(/\r/g, "").split("\n");
    const marker = screenLines.findLastIndex(isQuestionStatusLine);
    const prompt = screenLines.findLastIndex((line) => /^\s*❯/.test(line));
    const questionLines = marker >= 0
      ? screenLines.slice(marker + 1, prompt >= marker ? prompt : undefined)
      : output.split("\n").filter((line) => !isQuestionStatusLine(line)).slice(-3);
    questionText = questionLines.map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(-800);
  }
  return { state, model, done, doneCandidates, ready: ready ? { repo: ready[1], head: ready[2] } : null, readyLine: readyLine ? `${readyLine[1]}${readyLine[2]}`.replace(/\s+/g, " ").trim().slice(0, 300) : null, claimText, questionText };
}

export function completionBelongsToDispatchAttempt(task, marker) {
  if (!task || ["closed", "done-claimed", "verified-done"].includes(task.status) || task.completion_claimed) return false;
  if (task.key && marker?.key !== task.key) return false;
  return Boolean(marker?.attempt && task.dispatch_attempt
    && marker.attempt === task.dispatch_attempt && task.send_attempted);
}

function completionRejectionReason(cat, assignedTaskKey, marker, task) {
  if (marker.filtered) return "filtered";
  if (marker.key !== assignedTaskKey || !task || task.key !== marker.key || task.cat !== cat)
    return "other-task";
  if (["closed", "done-claimed", "verified-done"].includes(task.status) || task.completion_claimed) return "already-claimed";
  if (!marker.attempt) return "attempt-missing";
  if (!task.dispatch_attempt || marker.attempt !== task.dispatch_attempt) {
    const history = JSON.parse(task.history || "[]");
    if (history.some((event) => event.ev === "send-attempted" && event.attempt === marker.attempt))
      return "stale-attempt";
    return "attempt-mismatch";
  }
  if (!task.send_attempted) return "not-sent";
  return completionBelongsToDispatchAttempt(task, marker) ? null : "already-claimed";
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
  return visible.split(/\n[ \t]*\n/)
    .filter((block) => block.trim() && !/^\s*(?:TPS [\d.]+ tok\/s\b|[─━]+\s*$)/.test(block))
    .at(-1) ?? "";
}

const QUESTION_POLICIES = [
  {
    id: "personal-credentials-defer",
    matches: /^\s*(?:May I use|Can I use) Jaemin's password or OTP now\?\s*$/i,
    answer: "재민의 비밀번호나 OTP는 사용하지 말고 내일로 미뤄.",
  },
  {
    id: "production-auth-prohibited",
    matches: /^\s*(?:Should we use|May I use) the production auth account\?\s*$/i,
    answer: "운영 인증 계정은 사용하지 마.",
  },
];

export function questionPolicy(question) {
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
  const signature = (value) => JSON.stringify(Object.fromEntries(Object.keys(value).filter((key) => key !== "at").sort().map((key) => [key, value[key]])));
  const history = JSON.parse(dbHandle.query("SELECT history FROM tasks WHERE key=?").get(task)?.history || "[]");
  if (ev.ev === "done-claimed") dbHandle.query("UPDATE tasks SET completion_claimed=1 WHERE key=?").run(task);
  if (ev.ev === "send-attempted") dbHandle.query("UPDATE tasks SET send_attempted=1 WHERE key=?").run(task);
  if (history.some((event) => signature(event) === signature(ev))) return false;
  const event = JSON.stringify({ at: now(), ...ev });
  dbHandle.query(`UPDATE tasks SET history=CASE
    WHEN json_array_length(COALESCE(history,'[]')) >= 40
      THEN json_remove(json_insert(COALESCE(history,'[]'),'$[#]',json(?)),'$[0]')
    ELSE json_insert(COALESCE(history,'[]'),'$[#]',json(?))
    END WHERE key=?`).run(event, event, task);
  return true;
}

function recordTaskClaimEvidenceInTransaction(dbHandle, taskKey, claim) {
  const task = dbHandle.query("SELECT claim_evidence FROM tasks WHERE key=?").get(taskKey);
  if (!task) return false;
  const evidence = JSON.parse(task.claim_evidence || "{}");
  const signal = claim.signal || "_legacy";
  evidence[signal] ??= {};
  evidence[signal][claim.kind] = {
    ok: Boolean(claim.ok),
    head: claim.head ?? null,
    acceptedPrefix: claim.acceptedPrefix ?? null,
    actualHead: claim.actualHead ?? null,
    detail: claim.detail ?? null,
  };
  dbHandle.query("UPDATE tasks SET claim_evidence=? WHERE key=?").run(JSON.stringify(evidence), taskKey);
  appendHistoryInTransaction(dbHandle, taskKey, {
    ev: claim.ok ? "claim-ok" : "claim-false",
    signal: claim.signal,
    claim: claim.kind,
    head: claim.head,
    acceptedPrefix: claim.acceptedPrefix,
    actualHead: claim.actualHead,
    detail: claim.detail,
  });
  return true;
}

export function recordTaskClaimEvidence(dbHandle, taskKey, claim) {
  if (!["cursor-accept", "pr-ready"].includes(claim.kind)) return false;
  return dbHandle.transaction(() => recordTaskClaimEvidenceInTransaction(dbHandle, taskKey, claim)).immediate();
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
    const task = db.query("SELECT status FROM tasks WHERE key=?").get(key);
    if (["verified-done", "closed"].includes(task?.status)) return false;
    db.query("UPDATE tasks SET status='blocked',result=? WHERE key=?").run(result, key);
    db.query("DELETE FROM dispatch_reservations WHERE key=?").run(key);
    appendHistoryInTransaction(db, key, { ev: "blocked", text: result });
  }).immediate();
}

export async function markTaskClosed(key, reason, runCommand = executeSignalCommand) {
  const detail = String(reason ?? "").trim();
  if (!detail) return `FLEET_TASK_CLOSE_ERROR ${key || "-"} reason_required`;
  const current = db.query("SELECT t.status,t.cat,c.pane FROM tasks t LEFT JOIN cats c ON c.id=t.cat WHERE t.key=?").get(key);
  if (!current) return `FLEET_TASK_CLOSE_ERROR ${key} task_not_found`;
  if (current.status === "verified-done") return `FLEET_TASK_CLOSE_HOLD ${key} already_verified`;
  if (current.status === "closed") return `FLEET_TASK_CLOSE_HOLD ${key} already_closed`;
  let closeReservation = null;
  let closeToken = null;
  const releaseCloseClaim = () => {
    if (closeReservation && closeToken) releaseReservationRecovery(db, closeReservation, closeToken);
  };
  if (["dispatching", "sent-unconfirmed", "send-failed-unconfirmed"].includes(current.status)) {
    closeReservation = db.query("SELECT pane,key,attempt,reserved_at FROM dispatch_reservations WHERE key=?").get(key) ?? null;
    const pane = closeReservation?.pane ?? configuredCatPane(current.cat, current.pane);
    if (!pane || pane === "-") return `FLEET_TASK_CLOSE_ERROR ${key} pane_unavailable`;
    if (closeReservation) {
      closeToken = crypto.randomUUID();
      const claimed = db.query(`UPDATE dispatch_reservations SET recovery_token=?,recovery_started_at=?
        WHERE pane=? AND key=? AND attempt=? AND recovery_token IS NULL`)
        .run(closeToken, now(), closeReservation.pane, key, closeReservation.attempt).changes;
      if (!claimed) return `FLEET_TASK_CLOSE_ERROR ${key} reservation_busy`;
    }
    let screen;
    try {
      screen = await runCommand(["herdr", "pane", "read", pane, "--source", "visible", "--format", "text"]);
    } catch {
      releaseCloseClaim();
      return `FLEET_TASK_CLOSE_ERROR ${key} pane_read_failed`;
    }
    if (screen.exitCode !== 0 || !screen.stdout.trim()
      || !["idle", "model-picker"].includes(classify(screen.stdout).state)) {
      releaseCloseClaim();
      return `FLEET_TASK_CLOSE_ERROR ${key} pane_not_safe_to_clear`;
    }
    if (!await clearPaneInput(pane, runCommand)) {
      releaseCloseClaim();
      return `FLEET_TASK_CLOSE_ERROR ${key} input_cleanup_unverified`;
    }
  }
  const result = db.transaction(() => {
    const task = db.query("SELECT status FROM tasks WHERE key=?").get(key);
    if (!task) return `FLEET_TASK_CLOSE_ERROR ${key} task_not_found`;
    if (task.status === "verified-done") return `FLEET_TASK_CLOSE_HOLD ${key} already_verified`;
    if (task.status === "closed") return `FLEET_TASK_CLOSE_HOLD ${key} already_closed`;
    if (closeReservation && closeToken) {
      const removed = db.query(`DELETE FROM dispatch_reservations
        WHERE pane=? AND key=? AND attempt=? AND recovery_token=?`)
        .run(closeReservation.pane, key, closeReservation.attempt, closeToken).changes;
      if (!removed) return `FLEET_TASK_CLOSE_ERROR ${key} reservation_changed`;
      closeReservation = null;
      closeToken = null;
    }
    db.query("UPDATE tasks SET status='closed',result=?,ended_at=? WHERE key=?").run(detail, now(), key);
    if (!closeToken) db.query("DELETE FROM dispatch_reservations WHERE key=?").run(key);
    db.query("UPDATE cats SET task=NULL WHERE task=?").run(key);
    appendHistoryInTransaction(db, key, { ev: "closed", reason: detail });
    return `FLEET_TASK_CLOSED ${key} reason=${detail}`;
  }).immediate();
  releaseCloseClaim();
  return result;
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
    const reservation = dbHandle.query("SELECT key,attempt,recovery_token FROM dispatch_reservations WHERE pane=?").get(pane);
    const task = dbHandle.query("SELECT status FROM tasks WHERE key=?").get(key);
    if (reservation?.key !== key || reservation.attempt !== attempt || reservation.recovery_token || task?.status !== "dispatching") return false;
    const sentAt = now();
    dbHandle.query("UPDATE tasks SET send_attempted=1,sent_at=? WHERE key=? AND status='dispatching'").run(sentAt, key);
    appendHistoryInTransaction(dbHandle, key, { ev: "send-attempted", attempt, at: sentAt });
    return true;
  }).immediate();
}

export function claimExpiredReservationRecovery(dbHandle, reservation, nowMs = Date.now()) {
  const token = crypto.randomUUID();
  return dbHandle.transaction(() => {
    const current = dbHandle.query(`SELECT reserved_at,recovery_token,recovery_started_at
      FROM dispatch_reservations WHERE pane=? AND key=? AND attempt=?`).get(reservation.pane, reservation.key, reservation.attempt);
    if (!current || current.reserved_at !== reservation.reserved_at) return null;
    const task = dbHandle.query("SELECT status,send_attempted FROM tasks WHERE key=?").get(reservation.key);
    if (!["dispatching", "dispatch-error"].includes(task?.status) || task.send_attempted) return null;
    const reservedAt = Date.parse(current.reserved_at);
    if (!Number.isFinite(reservedAt) || nowMs - reservedAt < DISPATCH_RESERVATION_TTL_MS) return null;
    const recoveryStartedAt = Date.parse(current.recovery_started_at || "");
    if (current.recovery_token && Number.isFinite(recoveryStartedAt) && nowMs - recoveryStartedAt < DISPATCH_RESERVATION_TTL_MS) return null;
    const updated = dbHandle.query(`UPDATE dispatch_reservations
      SET recovery_token=?,recovery_started_at=?
      WHERE pane=? AND key=? AND attempt=? AND reserved_at=?
        AND (recovery_token IS NULL OR recovery_started_at IS NULL OR recovery_started_at<=?)`)
      .run(token, new Date(nowMs).toISOString(), reservation.pane, reservation.key, reservation.attempt, reservation.reserved_at,
        new Date(nowMs - DISPATCH_RESERVATION_TTL_MS).toISOString()).changes;
    return updated === 1 ? token : null;
  }).immediate();
}

export function claimPickerRecoveryImmediatelyBeforeEscape(dbHandle, reservation, nowMs = Date.now()) {
  return dbHandle.transaction(() => {
    const current = dbHandle.query(`SELECT reserved_at,recovery_token,recovery_started_at FROM dispatch_reservations
      WHERE pane=? AND key=? AND attempt=?`).get(reservation.pane, reservation.key, reservation.attempt);
    if (!current || current.reserved_at !== reservation.reserved_at) return null;
    const task = dbHandle.query("SELECT status,send_attempted FROM tasks WHERE key=?").get(reservation.key);
    if (!["dispatching", "dispatch-error"].includes(task?.status)) return null;
    const reservedAt = Date.parse(current.reserved_at);
    if (!Number.isFinite(reservedAt) || nowMs - reservedAt < DISPATCH_RESERVATION_TTL_MS) return null;
    const recoveryStartedAt = Date.parse(current.recovery_started_at || "");
    if (current.recovery_token && Number.isFinite(recoveryStartedAt) && nowMs - recoveryStartedAt < DISPATCH_RESERVATION_TTL_MS) return null;
    if (task.send_attempted) return null;
    const token = crypto.randomUUID();
    const claimed = dbHandle.query(`UPDATE dispatch_reservations SET recovery_token=?,recovery_started_at=?
      WHERE pane=? AND key=? AND attempt=? AND reserved_at=?
        AND (recovery_token IS NULL OR recovery_started_at IS NULL OR recovery_started_at<=?)`)
      .run(token, new Date(nowMs).toISOString(), reservation.pane, reservation.key, reservation.attempt, reservation.reserved_at,
        new Date(nowMs - DISPATCH_RESERVATION_TTL_MS).toISOString()).changes;
    return claimed === 1 ? token : null;
  }).immediate();
}

export function reservationLeaseExpiredAndOwned(dbHandle, reservation, nowMs = Date.now()) {
  return dbHandle.transaction(() => {
    const current = dbHandle.query(`SELECT reserved_at,recovery_token,recovery_started_at FROM dispatch_reservations
      WHERE pane=? AND key=? AND attempt=?`).get(reservation.pane, reservation.key, reservation.attempt);
    if (!current || current.reserved_at !== reservation.reserved_at) return false;
    const task = dbHandle.query("SELECT status,send_attempted FROM tasks WHERE key=?").get(reservation.key);
    if (!["dispatching", "dispatch-error", "send-failed-unconfirmed"].includes(task?.status)) return false;
    const reservedAt = Date.parse(current.reserved_at);
    if (!Number.isFinite(reservedAt) || nowMs - reservedAt < DISPATCH_RESERVATION_TTL_MS) return false;
    const recoveryStartedAt = Date.parse(current.recovery_started_at || "");
    return !current.recovery_token || !Number.isFinite(recoveryStartedAt) || nowMs - recoveryStartedAt >= DISPATCH_RESERVATION_TTL_MS;
  }).immediate();
}

export function releaseReservationRecovery(dbHandle, reservation, token) {
  return dbHandle.query(`UPDATE dispatch_reservations SET recovery_token=NULL,recovery_started_at=NULL
    WHERE pane=? AND key=? AND attempt=? AND recovery_token=?`)
    .run(reservation.pane, reservation.key, reservation.attempt, token).changes === 1;
}

export function claimFailedSendRecovery(dbHandle, reservation, nowMs = Date.now()) {
  const token = crypto.randomUUID();
  return dbHandle.transaction(() => {
    const current = dbHandle.query(`SELECT reserved_at,recovery_token,recovery_started_at
      FROM dispatch_reservations WHERE pane=? AND key=? AND attempt=?`).get(reservation.pane, reservation.key, reservation.attempt);
    if (!current || (reservation.reserved_at && current.reserved_at !== reservation.reserved_at)) return null;
    const task = dbHandle.query("SELECT status,send_attempted FROM tasks WHERE key=?").get(reservation.key);
    if (!["dispatching", "send-failed-unconfirmed"].includes(task?.status) || !task.send_attempted) return null;
    const startedAt = Date.parse(current.recovery_started_at || "");
    if (reservation.recoveryToken && current.recovery_token !== reservation.recoveryToken) return null;
    if (current.recovery_token && Number.isFinite(startedAt) && nowMs - startedAt < DISPATCH_RESERVATION_TTL_MS) return null;
    const claimToken = reservation.recoveryToken && current.recovery_token === reservation.recoveryToken ? reservation.recoveryToken : token;
    const changed = dbHandle.query(`UPDATE dispatch_reservations SET recovery_token=?,recovery_started_at=?
      WHERE pane=? AND key=? AND attempt=?
        AND (recovery_token IS NULL OR recovery_token=? OR recovery_started_at IS NULL OR recovery_started_at<=?)`)
      .run(claimToken, new Date(nowMs).toISOString(), reservation.pane, reservation.key, reservation.attempt,
        reservation.recoveryToken ?? null, new Date(nowMs - DISPATCH_RESERVATION_TTL_MS).toISOString()).changes;
    return changed === 1 ? claimToken : null;
  }).immediate();
}

export function reservationExpiredAndOwned(dbHandle, reservation, nowMs = Date.now()) {
  return dbHandle.transaction(() => {
    const current = dbHandle.query(`SELECT reserved_at,recovery_token,recovery_started_at FROM dispatch_reservations
      WHERE pane=? AND key=? AND attempt=?`).get(reservation.pane, reservation.key, reservation.attempt);
    if (!current || current.reserved_at !== reservation.reserved_at) return false;
    const task = dbHandle.query("SELECT status,history,send_attempted FROM tasks WHERE key=?").get(reservation.key);
    if (!["dispatching", "dispatch-error"].includes(task?.status)) return false;
    const reservedAt = Date.parse(current.reserved_at);
    if (!Number.isFinite(reservedAt) || nowMs - reservedAt < DISPATCH_RESERVATION_TTL_MS) return false;
    const recoveryStartedAt = Date.parse(current.recovery_started_at || "");
    if (current.recovery_token && Number.isFinite(recoveryStartedAt) && nowMs - recoveryStartedAt < DISPATCH_RESERVATION_TTL_MS) return false;
    const history = JSON.parse(task.history || "[]");
    return !task.send_attempted && !history.some((event) => event.ev === "send-attempted" && event.attempt === reservation.attempt);
  }).immediate();
}

export function recoverDispatchReservation(dbHandle, reservation, paneState, nowMs = Date.now()) {
  return dbHandle.transaction(() => {
    const current = dbHandle.query(`SELECT reserved_at,recovery_token FROM dispatch_reservations
      WHERE pane=? AND key=? AND attempt=?`).get(reservation.pane, reservation.key, reservation.attempt);
    if (!current || current.reserved_at !== reservation.reserved_at) return null;
    if (reservation.recoveryToken) {
      if (current.recovery_token !== reservation.recoveryToken) return null;
    } else if (current.recovery_token) return null;
    const task = dbHandle.query("SELECT status,history,send_attempted FROM tasks WHERE key=?").get(reservation.key);
    if (!["dispatching", "dispatch-error", "send-failed-unconfirmed"].includes(task?.status)) return null;
    const reservedAt = Date.parse(current.reserved_at);
    if (!Number.isFinite(reservedAt) || nowMs - reservedAt < DISPATCH_RESERVATION_TTL_MS) return null;
    const history = JSON.parse(task.history || "[]");
    const sendAttempted = Boolean(task.send_attempted) || history.some((event) => event.ev === "send-attempted" && event.attempt === reservation.attempt);
    if (paneState === "working" || paneState === "question" || paneState === "compacting" || paneState === "provider-error") {
      const status = sendAttempted ? "send-failed-unconfirmed" : "sent-unconfirmed";
      const changed = dbHandle.query("UPDATE tasks SET status=? WHERE key=? AND status IN ('dispatching','dispatch-error','send-failed-unconfirmed') AND status!=?")
        .run(status, reservation.key, status).changes;
      if (changed) appendHistoryInTransaction(dbHandle, reservation.key, { ev: status, attempt: reservation.attempt });
      return null;
    }
    if (paneState === "compaction-failed") {
      const deleted = dbHandle.query(`DELETE FROM dispatch_reservations
        WHERE pane=? AND key=? AND attempt=? AND reserved_at=? AND recovery_token IS ?`)
        .run(reservation.pane, reservation.key, reservation.attempt, reservation.reserved_at, reservation.recoveryToken ?? null).changes;
      if (!deleted) return null;
      dbHandle.query("UPDATE tasks SET status='prompt-lost' WHERE key=? AND status IN ('dispatching','dispatch-error','send-failed-unconfirmed')").run(reservation.key);
      appendHistoryInTransaction(dbHandle, reservation.key, { ev: "prompt-lost", attempt: reservation.attempt });
      return `FLEET_PROMPT_LOST ${reservation.key} pane=${reservation.pane} reservation_released`;
    }
    if (paneState !== "idle") return null;
    if (sendAttempted) return null;
    const deleted = dbHandle.query(`DELETE FROM dispatch_reservations
      WHERE pane=? AND key=? AND attempt=? AND reserved_at=? AND recovery_token IS ?`)
      .run(reservation.pane, reservation.key, reservation.attempt, reservation.reserved_at, reservation.recoveryToken ?? null).changes;
    if (!deleted) return null;
    dbHandle.query("UPDATE tasks SET status='dispatch-interrupted',result='dispatch process stopped before confirming send' WHERE key=? AND status IN ('dispatching','dispatch-error','send-failed-unconfirmed')").run(reservation.key);
    appendHistoryInTransaction(dbHandle, reservation.key, { ev: "dispatch-interrupted", attempt: reservation.attempt });
    return `FLEET_DISPATCH_INTERRUPTED ${reservation.key} pane=${reservation.pane} reservation_released`;
  }).immediate();
}

export async function reconcileFailedDispatch(dbHandle, reservation, paneRead, runCommand = executeSignalCommand) {
  const token = claimFailedSendRecovery(dbHandle, reservation);
  if (!token) return false;
  const owned = { ...reservation, recoveryToken: token };
  let finished = false;
  try {
    const screen = await paneRead();
    if (screen.exitCode !== 0 || !screen.stdout.trim() || classify(screen.stdout).state !== "idle") return false;
    const clear = await runCommand(["herdr", "pane", "send-keys", reservation.pane, "ctrl+u"]);
    if (clear.exitCode !== 0) return false;
    const confirmed = await paneRead();
    if (confirmed.exitCode !== 0 || !confirmed.stdout.trim() || classify(confirmed.stdout).state !== "idle") return false;
    const updated = dbHandle.transaction(() => {
      const task = dbHandle.query("SELECT status FROM tasks WHERE key=?").get(reservation.key);
      if (!["dispatching", "send-failed-unconfirmed"].includes(task?.status)) return false;
      const deleted = dbHandle.query(`DELETE FROM dispatch_reservations
        WHERE pane=? AND key=? AND attempt=? AND recovery_token=?`)
        .run(reservation.pane, reservation.key, reservation.attempt, token).changes;
      if (!deleted) return false;
      dbHandle.query("UPDATE tasks SET status='send-failed-unconfirmed' WHERE key=?").run(reservation.key);
      appendHistoryInTransaction(dbHandle, reservation.key, { ev: "send-failed-unconfirmed", attempt: reservation.attempt, detail: "idle pane input cleared after failed send" });
      return true;
    }).immediate();
    finished = updated;
    return updated;
  } finally {
    if (!finished) releaseReservationRecovery(dbHandle, reservation, token);
  }
}

export async function recoverInterruptedDispatches(dbHandle, paneRows, nowMs = Date.now(), runCommand = executeSignalCommand) {
  const paneStates = new Map(paneRows.map((row) => [row.id, row.state]));
  const reservations = dbHandle.query(`SELECT r.pane,r.key,r.attempt,r.reserved_at,t.cat,t.status
    FROM dispatch_reservations r JOIN tasks t ON t.key=r.key WHERE t.status IN ('dispatching','dispatch-error','send-failed-unconfirmed')`).all();
  const events = [];
  for (const reservation of reservations.filter((item) => paneStates.has(item.cat))) {
    let recoveryToken = null;
    try {
      const initial = await runCommand(["herdr", "pane", "read", reservation.pane, "--source", "visible", "--format", "text"]);
      if (initial.exitCode !== 0 || !initial.stdout.trim()) continue;
      const snapshot = classify(initial.stdout);
      let state = snapshot.state;
      if (state === "idle" && snapshot.done?.key === reservation.key && snapshot.done.attempt === reservation.attempt
        && reservation.status !== "dispatch-error") continue;
      if (state === "model-picker" || reservation.status === "dispatch-error") {
        if (reservation.status === "dispatch-error" && !["idle", "model-picker"].includes(state)) continue;
        recoveryToken = claimPickerRecoveryImmediatelyBeforeEscape(dbHandle, reservation, nowMs);
        if (!recoveryToken) continue;
        if (!await clearPaneInput(reservation.pane, runCommand)) {
          releaseReservationRecovery(dbHandle, reservation, recoveryToken);
          continue;
        }
        state = "idle";
      }
      const current = dbHandle.query("SELECT reserved_at,recovery_token FROM dispatch_reservations WHERE pane=? AND key=? AND attempt=?")
        .get(reservation.pane, reservation.key, reservation.attempt);
      if (!current || current.reserved_at !== reservation.reserved_at
        || (recoveryToken ? current.recovery_token !== recoveryToken : current.recovery_token !== null)) {
        if (recoveryToken) releaseReservationRecovery(dbHandle, reservation, recoveryToken);
        continue;
      }
      const ownedReservation = { ...reservation, recoveryToken };
      const event = recoverDispatchReservation(dbHandle, ownedReservation, state, nowMs);
      if (event) events.push(event);
      if (!event && state === "idle") {
        const current = dbHandle.query("SELECT status,history,send_attempted FROM tasks WHERE key=?").get(reservation.key);
        const attempted = Boolean(current?.send_attempted) || JSON.parse(current?.history || "[]").some((item) => item.ev === "send-attempted" && item.attempt === reservation.attempt);
        if (attempted && reservationLeaseExpiredAndOwned(dbHandle, reservation, nowMs)) {
          const reconciled = await reconcileFailedDispatch(
            dbHandle,
            ownedReservation,
            async () => runCommand(["herdr", "pane", "read", reservation.pane, "--source", "visible", "--format", "text"]),
            runCommand,
          );
          if (reconciled) events.push(`FLEET_SEND_FAILED_UNCONFIRMED ${reservation.key} pane=${reservation.pane} reservation_released`);
          else if (recoveryToken) releaseReservationRecovery(dbHandle, reservation, recoveryToken);
        } else if (recoveryToken) {
          releaseReservationRecovery(dbHandle, reservation, recoveryToken);
        }
      }
    } catch (error) {
      if (recoveryToken) releaseReservationRecovery(dbHandle, reservation, recoveryToken);
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
  for (const c of db.query("SELECT * FROM cats").all()) {
    const pane = configuredCatPane(c.id, c.pane);
    if (pane === "-") continue;
    try {
      const screen = await readPaneResult(pane);
      if (screen.exitCode !== 0 || !screen.stdout.trim()) throw new Error(`pane read failed: exit ${screen.exitCode}`);
      const s = classify(screen.stdout);
      db.query("UPDATE cats SET state=?, model=?, last_seen=? WHERE id=?").run(s.state, s.model, now(), c.id);
      out.push({ ...c, pane, ...s });
    } catch (error) {
      console.log(`FLEET_REFRESH_ERROR ${c.id} ${error?.message ?? error}`);
      db.query("UPDATE cats SET state='unknown',model='' WHERE id=?").run(c.id);
      out.push({ ...c, state: "unknown", model: "", done: null, ready: null, readyLine: null, claimText: "", questionText: "" });
    }
  }
  return out;
}

// Owner via the configured review channel: watch Claude/Codex usage so limits never stop development.
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
  const usageText = await Bun.file(`${process.env.HOME}/.omo/omonyang/usage-watch.log`).text().catch((error) => {
    fleetError("USAGE_READ", "usage-watch.log", error);
    return "";
  });
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

function promptLineContains(screen, text) {
  const input = String(screen).replace(/\r/g, "").split("\n").findLast((line) => /^\s*❯/.test(line));
  return Boolean(input?.includes(text));
}

function promptLineIsEmpty(screen) {
  const input = String(screen).replace(/\r/g, "").split("\n").findLast((line) => /^\s*❯/.test(line));
  return Boolean(input && /^\s*❯\s*$/.test(input));
}

async function clearPaneInput(pane, runCommand = executeSignalCommand) {
  const sendKey = async (key) => {
    try {
      return (await runCommand(
        ["herdr", "pane", "send-keys", pane, key],
        AbortSignal.timeout(1000),
      )).exitCode === 0;
    } catch (error) {
      fleetError("PANE_CLEANUP", `pane=${pane} key=${key}`, error);
      return false;
    }
  };
  const escaped = await sendKey("Escape");
  const cleared = await sendKey("ctrl+u");
  const empty = await waitForPaneScreen(pane, promptLineIsEmpty, runCommand, 1000);
  return escaped && cleared && Boolean(empty);
}

export async function waitForPaneScreen(pane, predicate, runCommand = executeSignalCommand, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const remaining = deadline - Date.now();
    let result;
    try {
      result = await runCommand(
        ["herdr", "pane", "read", pane, "--source", "visible", "--format", "text"],
        AbortSignal.timeout(Math.max(1, remaining)),
      );
    } catch (error) {
      fleetError("PANE_WAIT", `pane=${pane}`, error);
      return null;
    }
    if (result.exitCode === 0 && result.stdout.trim() && predicate(result.stdout)) return result.stdout;
    if (Date.now() >= deadline) break;
    await Bun.sleep(Math.max(0, Math.min(50, deadline - Date.now())));
  }
  return null;
}

export async function switchModel(pane, want, runCommand = executeSignalCommand, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const initial = await runCommand(
    ["herdr", "pane", "read", pane, "--source", "visible", "--format", "text"],
    AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  );
  if (initial.exitCode !== 0 || !initial.stdout.trim()) {
    fleetError("MODEL_SWITCH_READ", `pane=${pane}`, `exit ${initial.exitCode}`);
    return `MODEL_SWITCH_FAILED ${pane} want=${want.provider}/${want.model} (pane read failed)`;
  }
  const before = classify(initial.stdout).model;
  if (before.startsWith(want.model)) return `MODEL_OK ${want.model}`;
  const send = async (step, argv) => {
    try {
      const result = await runCommand(argv, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      if (result.exitCode === 0) return true;
      fleetError("MODEL_SWITCH_COMMAND", `pane=${pane} step=${step}`, `exit ${result.exitCode}`);
      return false;
    } catch (error) {
      fleetError("MODEL_SWITCH_COMMAND", `pane=${pane} step=${step}`, error);
      return false;
    }
  };
  const wait = (predicate) => waitForPaneScreen(pane, predicate, runCommand, Math.max(0, deadline - Date.now()));
  const timeout = (phase) => {
    fleetError("MODEL_SWITCH_TIMEOUT", `pane=${pane} phase=${phase}`, "screen predicate not reached");
    return `MODEL_SWITCH_TIMEOUT ${pane} phase=${phase}`;
  };
  const failCleanly = async (failure) => {
    if (await clearPaneInput(pane, runCommand)) return failure;
    fleetError("MODEL_SWITCH_CLEANUP", `pane=${pane}`, "input line empty state not verified");
    return `MODEL_SWITCH_DIRTY ${pane} ${failure} cleanup-unverified`;
  };
  const timeoutAndClean = async (phase) => failCleanly(timeout(phase));
  const commandFailure = (step) => `MODEL_SWITCH_FAILED ${pane} want=${want.provider}/${want.model} (${step} failed)`;
  if (!await send("open-picker", ["herdr", "pane", "send-text", pane, "/model"])) {
    return failCleanly(commandFailure("picker command"));
  }
  if (!await wait((screen) => promptLineContains(screen, "/model"))) {
    return timeoutAndClean("picker-open");
  }
  if (!await send("submit-picker-command", ["herdr", "pane", "send-keys", pane, "Enter"])) {
    return failCleanly(commandFailure("picker submit"));
  }
  if (!await wait((screen) => classify(screen).state === "model-picker")) {
    return timeoutAndClean("catalog");
  }
  if (!await send("filter-model", ["herdr", "pane", "send-text", pane, want.model])) {
    return failCleanly(commandFailure("model filter"));
  }
  const pick = await wait((screen) => screen.split(/\r?\n/).some((line) =>
    line.includes(want.model) && line.includes(`[${want.provider}]`)));
  if (!pick) {
    return timeoutAndClean("model-row");
  }
  if (!await send("select-model", ["herdr", "pane", "send-keys", pane, "Enter"])) {
    return failCleanly(commandFailure("model selection"));
  }
  let after = await wait((screen) => classify(screen).model.startsWith(want.model));
  if (!after) return timeoutAndClean("model-change");
  if (want.thinking && !classify(after).model.endsWith(`:${want.thinking}`)) {
    if (!await send("set-thinking", ["herdr", "pane", "send-text", pane, `/thinking ${want.thinking}`])) {
      return failCleanly(commandFailure("thinking command"));
    }
    if (!await wait((screen) => promptLineContains(screen, `/thinking ${want.thinking}`))) return timeoutAndClean("thinking-command");
    if (!await send("submit-thinking", ["herdr", "pane", "send-keys", pane, "Enter"])) {
      return failCleanly(commandFailure("thinking submit"));
    }
    after = await wait((screen) => classify(screen).model.endsWith(`:${want.thinking}`));
    if (!after) return timeoutAndClean("thinking-change");
  }
  if (!await wait(promptLineIsEmpty)) return timeoutAndClean("input-clear");
  return `MODEL_SWITCHED ${before} -> ${want.provider}/${want.model}`;
}

export async function fetchSlackThreadReplies(roots, fetchThread, signal, concurrency = SLACK_THREAD_CONCURRENCY) {
  const replies = [];
  for (let offset = 0; offset < roots.length; offset += concurrency) {
    if (signal.aborted) return null;
    const batch = await Promise.all(roots.slice(offset, offset + concurrency).map(async (root) => {
      try { return await fetchThread(root, signal); } catch (error) {
        fleetError("SLACK_THREAD", `root=${root.ts}`, error);
        return null;
      }
    }));
    if (batch.some((thread) => thread === null)) return null;
    replies.push(...batch.flat());
  }
  return replies;
}

export function reviewRequestThreadRoots(messages) {
  return messages.filter((message) => Number(message.reply_count) > 0 && isReviewRequest(message));
}

export function slackHistoryParams(since) {
  return new URLSearchParams({ channel: SLACK_REVIEW_CHANNEL, limit: "100", oldest: since, inclusive: "true" });
}

async function slackHistory(since) {
  const deadline = AbortSignal.timeout(SLACK_HISTORY_TIMEOUT_MS);
  const credentialPath = CONFIG.agentMessengerCredentialPath;
  if (!credentialPath || deadline.aborted) return null;
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
    const params = slackHistoryParams(since);
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
      const params = new URLSearchParams({ channel: SLACK_REVIEW_CHANNEL, ts: root.ts, limit: "200", oldest: since, inclusive: "true" });
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

async function slackHasHead(fullHead, sentAt, pr, runCommand = executeSignalCommand, fetchMessages = slackHistory) {
  if (!/^[a-f0-9]{40}$/i.test(fullHead || "")) return false;
  const sentTime = Date.parse(sentAt);
  if (!Number.isFinite(sentTime)) return false;
  const messages = await fetchMessages((sentTime / 1000).toFixed(6));
  if (!messages) return false;
  return cursorHeadMatches(messages, fullHead, pr, runCommand);
}

/**
 * A Cursor message accepts a head only when one line of its text carries both
 * an ACCEPT/APPROVE verdict and that head, and the same line has no
 * REJECT/REVISE verdict. A bare SHA mention, or a table row that reads REJECT,
 * never counts as acceptance.
 */
function referencesPullRequest(text, { repo, prNumber }) {
  if (!repo || !prNumber) return false;
  const source = String(text ?? "");
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const repoName = repo.split("/").at(-1);
  const escapedRepoName = repoName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const repoReference = `(?<![\\w./-])(?:${escapedRepo}|${escapedRepoName})`;
  return new RegExp(`(?:${repoReference}\\s*#\\s*${prNumber}\\b|${repoReference}\\s+PR\\s*#?\\s*${prNumber}\\b|https?://github\\.com/${escapedRepo}/pull/${prNumber}\\b)`, "i").test(source);
}

function referencesExactPullRequest(text, { repo, prNumber }) {
  if (!repo || !prNumber) return false;
  const source = String(text ?? "");
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const repoReference = `(?<![\\w./-])${escapedRepo}`;
  return new RegExp(`(?:${repoReference}\\s*#\\s*${prNumber}(?!\\d)|${repoReference}\\s+PR\\s*#?\\s*${prNumber}(?!\\d)|https?://github\\.com/${escapedRepo}/pull/${prNumber}(?!\\d))`, "i").test(source);
}

function referencesTask(text, taskKey) {
  if (!taskKey) return false;
  const escaped = taskKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, "i").test(String(text ?? ""));
}

async function commitsForPullRequest(repo, prNumber, runCommand) {
  const result = await runCommand(["gh", "api", `repos/${repo}/pulls/${prNumber}/commits`, "--paginate", "--jq", ".[].sha"]);
  if (result.exitCode !== 0) return null;
  const shas = result.stdout.match(/(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/gi) ?? [];
  return shas.map((sha) => sha.toLowerCase());
}

export async function cursorHeadMatches(messages, fullHead, pr, runCommand = executeSignalCommand) {
  const want = String(fullHead).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(want)) return false;
  let commits;
  for (const message of messages) {
    if (message.user !== CURSOR_USER_ID) continue;
    const text = String(message.text ?? "");
    const lines = text.split(/\n|(?<=\|)\s+(?=\|)/);
    for (const line of lines) {
      if (!/\b(?:ACCEPT|APPROVE)\b/i.test(line) || /\b(?:REJECT|REVISE)\b/i.test(line)) continue;
      const tokens = [...line.matchAll(/(?<![a-f0-9])[a-f0-9]{7,40}(?![a-f0-9])/gi)].map((match) => match[0].toLowerCase());
      const hasReference = pr && referencesPullRequest(line, pr);
      const hasTaskReference = referencesTask(line, pr?.taskKey);
      if (!hasReference && !hasTaskReference) continue;
      if (tokens.includes(want)) return true;
      if (!pr?.repo || !pr?.prNumber || !tokens.some((token) => token.length < 40 && want.startsWith(token))) continue;
      commits ??= await commitsForPullRequest(pr.repo, pr.prNumber, runCommand);
      if (!commits) continue;
      for (const token of tokens) {
        if (token.length === 40 || !want.startsWith(token)) continue;
        const matches = commits.filter((sha) => sha.startsWith(token));
        if (matches.length === 1 && matches[0] === want) return true;
      }
    }
  }
  return false;
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

export async function reviewStallEvents(nowMs, alerted, fetchMessages = slackHistory, since = ((nowMs - 24 * 60 * 60_000) / 1000).toFixed(6)) {
  let messages;
  try {
    messages = await fetchMessages(since);
  } catch (error) {
    fleetError("SLACK_REVIEW_STALL", `since=${since}`, error);
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

export async function pollReviewStalls(dbHandle, nowMs = Date.now(), fetchMessages = slackHistory) {
  const cursor = dbHandle.query("SELECT value FROM fleet_state WHERE key='slack-review-cursor'").get()?.value
    ?? ((nowMs - SLACK_HISTORY_BOOTSTRAP_DAYS * 24 * 60 * 60_000) / 1000).toFixed(6);
  let messages;
  try { messages = await fetchMessages(cursor); } catch (error) {
    fleetError("SLACK_REVIEW_POLL", `cursor=${cursor}`, error);
    return [];
  }
  if (!messages) return [];
  const requests = messages.filter(isReviewRequest);
  for (const request of requests) {
    dbHandle.query(`INSERT INTO fleet_review_requests(ts,channel,thread_ts,user,text) VALUES(?,?,?,?,?)
      ON CONFLICT(ts) DO UPDATE SET channel=excluded.channel,thread_ts=excluded.thread_ts,user=excluded.user,text=excluded.text`)
      .run(String(request.ts), request.channel ?? null, request.thread_ts ?? null, request.user ?? null, String(request.text ?? ""));
  }
  const pending = dbHandle.query("SELECT ts,channel,thread_ts,user,text FROM fleet_review_requests ORDER BY ts").all();
  const replies = messages.filter(isReviewResponder);
  const paired = pairReviewReplies(pending, replies);
  const alerted = new Set(dbHandle.query("SELECT key FROM fleet_alerts").all().map((row) => row.key));
  const drafts = reviewStallDrafts(pending, replies, nowMs, alerted);
  dbHandle.transaction(() => {
    for (const [requestTs] of paired) dbHandle.query("DELETE FROM fleet_review_requests WHERE ts=?").run(requestTs);
    for (const draft of drafts) {
      const requestTs = draft.match(/\brequest_ts=([\d.]+)/)?.[1];
      if (requestTs) dbHandle.query("INSERT OR IGNORE INTO fleet_alerts(key,alerted_at) VALUES(?,?)").run(requestTs, now());
    }
    const remaining = dbHandle.query("SELECT ts FROM fleet_review_requests ORDER BY ts LIMIT 1").get();
    const channelMessages = messages.filter((message) => !message.thread_ts || String(message.thread_ts) === String(message.ts));
    const latest = channelMessages.reduce((max, message) => Number(message.ts) > Number(max) ? String(message.ts) : max, cursor);
    const nextCursor = remaining?.ts ?? latest;
    dbHandle.query(`INSERT INTO fleet_state(key,value) VALUES('slack-review-cursor',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(nextCursor || cursor));
  }).immediate();
  return drafts;
}

function parsePullRequestSignal(signal) {
  const match = signal.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/);
  return match ? { repo: match[1].toLowerCase(), prNumber: match[2] } : null;
}

function configuredRepositoryValue(values, repo) {
  const normalized = String(repo ?? "").toLowerCase();
  const entry = Object.entries(values ?? {}).find(([candidate]) => candidate.toLowerCase() === normalized);
  return entry?.[1];
}

function headPrefixMatchesFull(fullHead, prefix) {
  const normalizedHead = String(fullHead ?? "").toLowerCase();
  const normalizedPrefix = String(prefix ?? "").toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalizedHead)
    && /^[a-f0-9]{7,40}$/.test(normalizedPrefix)
    && normalizedHead.startsWith(normalizedPrefix);
}

async function pullRequestHead(prSignal, abortSignal = AbortSignal.timeout(10000), runCommand = executeSignalCommand) {
  const pr = parsePullRequestSignal(prSignal);
  if (!pr) return null;
  try {
    const result = await runCommand(["gh", "pr", "view", pr.prNumber, "--repo", pr.repo, "--json", "headRefOid"], abortSignal);
    if (result.exitCode !== 0) {
      fleetError("PR_HEAD", `signal=${prSignal}`, `gh exited ${result.exitCode}`);
      return null;
    }
    return JSON.parse(result.stdout).headRefOid ?? null;
  } catch (error) {
    fleetError("PR_HEAD", `signal=${prSignal}`, error);
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
    if (exitCode !== 0) {
      fleetError("PR_CHECK_RUNS", `repo=${repo} head=${head.slice(0, 12)}`, `gh exited ${exitCode}`);
      return null;
    }
    const data = JSON.parse(text);
    return Array.isArray(data.check_runs) ? data.check_runs : [];
  } catch (error) {
    fleetError("PR_CHECK_RUNS", `repo=${repo} head=${head.slice(0, 12)}`, error);
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
    WHERE status IN ('sent','sent-unconfirmed','send-failed-unconfirmed','tracked-unconfirmed','working','done-claimed','not-done') AND done IS NOT NULL AND done!=''
    ORDER BY sent_at DESC LIMIT 20`).all();
  const targets = new Map();
  for (const task of tasks) {
    try {
      for (const signal of task.done.split(";").map((part) => part.trim())) {
        if (parsePullRequestSignal(signal) && !targets.has(signal)) targets.set(signal, task.key);
      }
    } catch (error) {
      fleetError("BUGBOT_TASK", `task=${task.key}`, error);
    }
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
      } catch (error) {
        fleetError("BUGBOT_LOOKUP", `task=${taskKey} signal=${signal}`, error);
        return null;
      }
    }));
    events.push(...batch.filter(Boolean));
  }
  return events;
}

function pullRequestSignal(text, task) {
  const taskSignals = task?.done?.split(";").map((part) => part.trim()).filter((part) => parsePullRequestSignal(part)) ?? [];
  const referencedSignal = taskSignals.find((signal) => referencesPullRequest(text, parsePullRequestSignal(signal)));
  if (referencedSignal) return referencedSignal;
  if (taskSignals.length) return taskSignals[0];
  const url = text.match(/\bhttps:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/i);
  if (url) return `pr:${url[1]}#${url[2]}`;
  const reference = text.match(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/);
  if (reference) return `pr:${reference[1]}#${reference[2]}`;
  return null;
}

export async function verifyClaims(text, task, checks = {}) {
  const results = [];
  const runCommand = checks.runCommand ?? executeSignalCommand;
  const getPrHead = checks.getPrHead ?? ((signal) => pullRequestHead(signal, AbortSignal.timeout(10000), runCommand));
  const checkSlackHead = checks.slackHasHead
    ?? ((head, sentAt, pr) => slackHasHead(head, sentAt, pr, runCommand, checks.slackHistory ?? slackHistory));
  const heads = new Map();
  const actualHeadFor = async (signal) => {
    if (!signal) return null;
    if (heads.has(signal)) return heads.get(signal);
    let actualHead = null;
    try {
      const head = await getPrHead(signal);
      if (typeof head === "string" && /^[a-f0-9]{40}$/i.test(head)) actualHead = head.toLowerCase();
    } catch (error) {
      fleetError("PR_HEAD_VERIFY", `signal=${signal}`, error);
    }
    heads.set(signal, actualHead);
    return actualHead;
  };
  const contextFor = (signal) => ({ ...(signal ? parsePullRequestSignal(signal) : {}), taskKey: task?.key });
  const acceptedLines = [...text.matchAll(/\bCursor\s+(?:ACCEPT|APPROVE)\b[^\n]*/gi)];
  for (const accepted of acceptedLines) {
    const claimLine = accepted[0];
    const signal = pullRequestSignal(claimLine, task);
    const actualHead = await actualHeadFor(signal);
    const pr = contextFor(signal);
    const acceptedPrefix = claimLine.match(/\bhead\s*[:=]\s*([0-9a-f]{7,40})\b/i)?.[1]
      ?? claimLine.match(/\b(?:ACCEPT|APPROVE)\b[^\n]*?\b([0-9a-f]{7,40})\b/i)?.[1];
    const normalizedHead = acceptedPrefix
      ? actualHead
        ? headPrefixMatchesFull(actualHead, acceptedPrefix) ? actualHead : null
        : /^[a-f0-9]{40}$/i.test(acceptedPrefix) ? acceptedPrefix.toLowerCase() : null
      : null;
    let ok = false;
    if (normalizedHead && task?.sent_at) {
      try { ok = await checkSlackHead(normalizedHead, task.sent_at, pr); } catch (error) {
        fleetError("SLACK_ACCEPT_CHECK", `signal=${signal ?? "unknown"}`, error);
      }
    }
    results.push({
      kind: "cursor-accept",
      signal,
      ok: Boolean(ok),
      head: normalizedHead,
      acceptedPrefix: acceptedPrefix?.toLowerCase() ?? null,
      actualHead,
      detail: !acceptedPrefix ? "head_missing_on_accept_line" : !normalizedHead ? "head_does_not_resolve_to_pr" : ok ? "slack_author_full_head_match" : "slack_author_or_head_mismatch",
    });
  }

  const readyLines = [...text.matchAll(/[^\n]*\bPR READY\s+head=([0-9a-f]{7,40})\b[^\n]*/gi)];
  for (const ready of readyLines) {
    const signal = pullRequestSignal(ready[0], task);
    const actualHead = await actualHeadFor(signal);
    const acceptedPrefix = ready[1].toLowerCase();
    const ok = Boolean(actualHead && headPrefixMatchesFull(actualHead, acceptedPrefix));
    results.push({
      kind: "pr-ready",
      signal,
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

export function hasListedTests(body) {
  const hasExecutedCounts = (text) => {
    const source = String(text ?? "");
    if (/^\s*(?:pending|skipped|todo|no[- ]tests?|none|n\/a|not run|not executed|not performed)\b/i.test(source)) return false;
    const passed = source.match(/\b(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/i)?.[1]
      ?? source.match(/\bpass(?:ed|ing)?\s*:\s*(\d+)\b/i)?.[1];
    const failed = source.match(/\b(\d+)\s+(?:tests?\s+)?fail(?:ed|ing)?\b/i)?.[1]
      ?? source.match(/\bfail(?:ed|ing)?\s*:\s*(\d+)\b/i)?.[1];
    return Number(passed) > 0 && Number(failed) === 0;
  };
  const lines = String(body ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    const inline = line.match(/^(?:tests?|testing)\s*:\s*(.+)$/i);
    if (inline && hasExecutedCounts(inline[1])) return true;
    if (!/^#{1,6}\s*(?:tests?|testing|test plan)\s*$/i.test(line)) continue;
    for (let next = index + 1; next < lines.length && !/^#{1,6}\s/.test(lines[next]); next++) {
      const item = lines[next].match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)?.[1]?.trim();
      if (item && hasExecutedCounts(item)) return true;
    }
  }
  return false;
}

function taskPrSignals(task) {
  const signals = new Set((task.done ?? "").split(";").map((part) => part.trim()).filter((part) => parsePullRequestSignal(part)));
  try {
    for (const signal of Object.keys(JSON.parse(task.claim_evidence || "{}"))) {
      if (parsePullRequestSignal(signal)) signals.add(signal);
    }
    for (const event of JSON.parse(task.history || "[]")) {
      if (event.claim === "pr-ready" && parsePullRequestSignal(event.signal)) signals.add(event.signal);
    }
  } catch (error) {
    fleetError("PR_LOOP_CLAIMS", `task=${task.key}`, error);
  }
  return [...signals];
}

function prReadyEvidence(task, signal) {
  try {
    const stored = JSON.parse(task.claim_evidence || "{}");
    const scoped = stored[signal]?.["pr-ready"] ?? (taskPrSignals(task).length === 1 ? stored._legacy?.["pr-ready"] : null);
    if (scoped) return scoped;
    const history = JSON.parse(task.history || "[]");
    return history.findLast((event) => event.claim === "pr-ready" && event.signal === signal) ?? null;
  } catch (error) {
    fleetError("PR_LOOP_CLAIMS", `task=${task.key} signal=${signal}`, error);
    return null;
  }
}

export function matchPrLoopVerdict(messages, { repo, prNumber, head, threadTs, afterTs, cursorUserId = CURSOR_USER_ID, replyAppId = REVIEW_REPLY_APP_ID }) {
  if (!/^[a-f0-9]{40}$/i.test(head || "")) return null;
  const fullHead = head.toLowerCase();
  const ordered = messages.slice().sort((a, b) => Number(a.ts) - Number(b.ts));
  let latest = null;
  for (const message of ordered) {
    if (message.user !== cursorUserId || message.app_id !== replyAppId) continue;
    if (String(message.thread_ts ?? "") !== String(threadTs) || Number(message.ts) <= Number(afterTs)) continue;
    for (const line of String(message.text ?? "").split(/\r?\n/)) {
      if (!referencesExactPullRequest(line, { repo, prNumber })) continue;
      const headMatches = [...line.matchAll(/(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/gi)];
      if (!headMatches.some((match) => match[0].toLowerCase() === fullHead)) continue;
      if (/\b(?:REJECT|REVISE)\b/i.test(line)) latest = { kind: "reject", text: line, ts: String(message.ts) };
      else if (/\b(?:ACCEPT|APPROVE)\b/i.test(line)) latest = { kind: "accept", text: line, ts: String(message.ts) };
    }
  }
  return latest;
}

async function prLoopPullRequestInfo(signal, runCommand) {
  const pr = parsePullRequestSignal(signal);
  if (!pr) return null;
  try {
    const result = await runCommand(["gh", "pr", "view", pr.prNumber, "--repo", pr.repo, "--json", "state,isDraft,headRefOid,url,body,mergeCommit"]);
    if (result.exitCode !== 0) {
      fleetError("PR_LOOP_VIEW", `signal=${signal}`, `gh exited ${result.exitCode}`);
      return null;
    }
    return { ...pr, ...JSON.parse(result.stdout) };
  } catch (error) {
    fleetError("PR_LOOP_VIEW", `signal=${signal}`, error);
    return null;
  }
}

async function defaultPrLoopPost(channel, threadTs, text) {
  const { SlackBotCredentialManager } = await import(CONFIG.agentMessengerCredentialPath);
  const credentials = await new SlackBotCredentialManager().getCredentials();
  if (!credentials?.token) throw new Error("BOT_CREDENTIAL_UNAVAILABLE");
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
    redirect: "error",
    signal: AbortSignal.timeout(SLACK_HISTORY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
  const posted = await response.json();
  if (posted.ok !== true || !posted.ts) throw new Error(posted.error || "Slack post had no timestamp");
  return posted;
}

async function defaultPrLoopReplies(channel, threadTs) {
  const { SlackBotCredentialManager } = await import(CONFIG.agentMessengerCredentialPath);
  const credentials = await new SlackBotCredentialManager().getCredentials();
  if (!credentials?.token) throw new Error("BOT_CREDENTIAL_UNAVAILABLE");
  const messages = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({ channel, ts: threadTs, limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
      headers: { Authorization: `Bearer ${credentials.token}` },
      signal: AbortSignal.timeout(SLACK_HISTORY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack replies HTTP ${response.status}`);
    const data = await response.json();
    if (data.ok !== true) throw new Error(data.error || "Slack replies failed");
    messages.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return messages;
}

export async function runDoriHeavyDeploy(repo, deploy, expectedMergeSha, timeoutMs, runCommand = executeSignalCommand, doriPath = process.env.DORI_SCRIPT || join(process.env.HOME || "", ".bun", "bin", "dori")) {
  if (!/^[a-f0-9]{40}$/i.test(expectedMergeSha ?? "")) throw new Error("invalid_expected_merge_sha");
  const timeoutSeconds = `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
  return runCommand([
    "bun", doriPath, "heavy", `fleet-pr-loop-${repo.replace(/[^a-z0-9-]/gi, "-")}`,
    "--", "timeout", "--signal=TERM", "--kill-after=5s", timeoutSeconds,
    "env", `FLEET_EXPECTED_MERGE_SHA=${expectedMergeSha.toLowerCase()}`, ...deploy.argv,
  ], AbortSignal.timeout(timeoutMs + 15_000));
}

async function defaultBranchSha(repo, runCommand) {
  const repoResult = await runCommand(
    ["gh", "repo", "view", repo, "--json", "defaultBranchRef"],
    AbortSignal.timeout(10_000),
  );
  if (repoResult.exitCode !== 0) throw new Error("default_branch_lookup_failed");
  const branch = JSON.parse(repoResult.stdout).defaultBranchRef?.name;
  if (typeof branch !== "string" || !branch) throw new Error("default_branch_missing");
  const branchResult = await runCommand(
    ["gh", "api", `repos/${repo}/branches/${encodeURIComponent(branch)}`],
    AbortSignal.timeout(10_000),
  );
  if (branchResult.exitCode !== 0) throw new Error("default_branch_lookup_failed");
  const sha = JSON.parse(branchResult.stdout).commit?.sha?.toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("default_branch_sha_missing");
  return sha;
}

export async function checkDeployHealth(url, timeoutMs, expectedMergeSha, fetchImpl = fetch) {
  if (!/^[a-f0-9]{40}$/i.test(expectedMergeSha ?? "")) throw new Error("invalid_expected_merge_sha");
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("invalid health URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("unsupported health URL");
  }
  const response = await fetchImpl(parsed, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  let reportedSha = body.trim();
  try {
    const data = JSON.parse(body);
    reportedSha = data.merge_sha ?? data.mergeSha ?? data.sha ?? data.revision ?? data.version ?? data.commit?.sha ?? "";
  } catch {}
  reportedSha = typeof reportedSha === "string" && /^[a-f0-9]{40}$/i.test(reportedSha.trim())
    ? reportedSha.trim().toLowerCase()
    : null;
  return { status: response.status, mergeSha: reportedSha };
}

async function ensurePrLoopReady(info, signal, runCommand) {
  if (!info?.isDraft) return info;
  if (!hasListedTests(info.body)) {
    fleetError("PR_LOOP_DRAFT", `signal=${signal}`, "draft PR has no listed tests");
    return null;
  }
  const ready = await runCommand(["gh", "pr", "ready", info.prNumber, "--repo", info.repo]);
  if (ready.exitCode !== 0) {
    fleetError("PR_LOOP_READY", `signal=${signal}`, `gh exited ${ready.exitCode}`);
    return null;
  }
  const refreshed = await prLoopPullRequestInfo(signal, runCommand);
  if (!refreshed || refreshed.state !== "OPEN" || refreshed.isDraft || refreshed.headRefOid?.toLowerCase() !== info.headRefOid?.toLowerCase()) {
    fleetError("PR_LOOP_READY", `signal=${signal}`, "PR remained draft or head changed");
    return null;
  }
  return refreshed;
}

function readPrLoopClaimedHead(task, signal, currentHead) {
  const hasDoneSignal = (task.done ?? "").split(";").map((part) => part.trim()).includes(signal);
  const claim = prReadyEvidence(task, signal);
  if (claim) {
    if (!claim.ok) return null;
    const claimed = claim.head ?? claim.actualHead;
    if (/^[a-f0-9]{40}$/i.test(claimed ?? "")) return claimed.toLowerCase();
    if (!hasDoneSignal && /^[a-f0-9]{40}$/i.test(claim.acceptedPrefix ?? "")) return claim.acceptedPrefix.toLowerCase();
    if (!hasDoneSignal) return null;
  }
  return hasDoneSignal && /^[a-f0-9]{40}$/i.test(currentHead ?? "") ? currentHead.toLowerCase() : null;
}

function reservePrLoopRequest(dbHandle, info, taskKey) {
  const token = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 30_000).toISOString();
  const claimed = dbHandle.transaction(() => dbHandle.query(`INSERT OR IGNORE INTO fleet_pr_loop
    (repo,pr_number,head,task_key,state,post_lease_token,post_lease_until,updated_at)
    VALUES(?,?,?,?,'posting',?,?,?)`)
    .run(info.repo, info.prNumber, info.headRefOid.toLowerCase(), taskKey, token, leaseUntil, now()).changes === 1).immediate();
  return claimed ? token : null;
}

function claimPrLoopReviewPost(dbHandle, row) {
  const token = crypto.randomUUID();
  const claimNow = now();
  const leaseUntil = new Date(Date.now() + 30_000).toISOString();
  const claimed = dbHandle.transaction(() => dbHandle.query(`UPDATE fleet_pr_loop
    SET state='posting',post_lease_token=?,post_lease_until=?,updated_at=?
    WHERE repo=? AND pr_number=? AND head=?
      AND (state='post-failed' OR (state='posting' AND (post_lease_until IS NULL OR post_lease_until<=?)))`)
    .run(token, leaseUntil, claimNow, row.repo, row.pr_number, row.head, claimNow).changes === 1).immediate();
  return claimed ? token : null;
}

function buildPrLoopReviewRequest(repo, prNumber, url, head) {
  const header = `서윤아, Cursor 검수 요청 ${repo}#${prNumber}`;
  const headLine = `head=${head}`;
  return {
    header,
    headLine,
    text: [header, url, headLine, `[<@${REVIEW_RELAY_USER_ID}> 서윤]`].join("\n"),
  };
}

async function postPrLoopRequest(dbHandle, task, info, config, postMessage, events) {
  if (info.state !== "OPEN") return false;
  const readyInfo = await ensurePrLoopReady(info, `pr:${info.repo}#${info.prNumber}`, config.runCommand);
  if (!readyInfo) return false;
  const claimedHead = readPrLoopClaimedHead(task, `pr:${info.repo}#${info.prNumber}`, readyInfo.headRefOid);
  if (!claimedHead || claimedHead !== readyInfo.headRefOid.toLowerCase()) {
    fleetError("PR_LOOP_HEAD_MISMATCH", `task=${task.key} signal=pr:${info.repo}#${info.prNumber}`,
      `claimed=${claimedHead ?? "missing"} actual=${readyInfo.headRefOid ?? "missing"}`);
    return false;
  }
  const postToken = reservePrLoopRequest(dbHandle, readyInfo, task.key);
  if (!postToken) return true;
  const signal = `pr:${readyInfo.repo}#${readyInfo.prNumber}`;
  const url = readyInfo.url || `https://github.com/${readyInfo.repo}/pull/${readyInfo.prNumber}`;
  const text = buildPrLoopReviewRequest(readyInfo.repo, readyInfo.prNumber, url, claimedHead).text;
  try {
    const posted = await postMessage(config.reviewChannel, config.reviewThreadTs, text);
    if (posted?.ok !== true || !posted.ts) throw new Error(posted?.error || "Slack post returned no timestamp");
    dbHandle.query(`UPDATE fleet_pr_loop SET state='awaiting-review',request_ts=?,updated_at=?
      ,post_lease_token=NULL,post_lease_until=NULL
      WHERE repo=? AND pr_number=? AND head=? AND state='posting' AND post_lease_token=?`)
      .run(String(posted.ts), now(), readyInfo.repo, readyInfo.prNumber, claimedHead, postToken);
    events.push(`FLEET_PR_REVIEW_REQUESTED ${task.key} ${signal} head=${claimedHead} request_ts=${posted.ts}`);
  } catch (error) {
    dbHandle.query(`UPDATE fleet_pr_loop SET state='post-failed',updated_at=?
      ,post_lease_token=NULL,post_lease_until=NULL
      WHERE repo=? AND pr_number=? AND head=? AND state='posting' AND post_lease_token=?`)
      .run(now(), readyInfo.repo, readyInfo.prNumber, claimedHead, postToken);
    fleetError("PR_LOOP_POST", `task=${task.key} signal=${signal}`, error);
  }
  return true;
}

function existingPrLoopRequestTs(replies, row, threadTs) {
  const request = buildPrLoopReviewRequest(row.repo, row.pr_number, "", row.head);
  const requestHeader = request.header.toLowerCase();
  const headLine = request.headLine.toLowerCase();
  const matchingMessage = replies.find((message) => {
    const lines = String(message.text ?? "").split(/\r?\n/).map((line) => line.trim().toLowerCase());
    return String(message.thread_ts ?? "") === String(threadTs)
      && lines[0] === requestHeader
      && lines.includes(headLine);
  });
  return matchingMessage?.ts ? String(matchingMessage.ts) : null;
}

async function retryPrLoopReviewPost(dbHandle, row, info, config, postMessage, events, runCommand) {
  const readyInfo = await ensurePrLoopReady(info, `pr:${row.repo}#${row.pr_number}`, runCommand);
  if (!readyInfo) return false;
  const postToken = claimPrLoopReviewPost(dbHandle, row);
  if (!postToken) return false;
  const url = readyInfo.url || `https://github.com/${row.repo}/pull/${row.pr_number}`;
  const text = buildPrLoopReviewRequest(row.repo, row.pr_number, url, row.head).text;
  try {
    const posted = await postMessage(config.reviewChannel, config.reviewThreadTs, text);
    if (posted?.ok !== true || !posted.ts) throw new Error(posted?.error || "Slack post returned no timestamp");
    dbHandle.query(`UPDATE fleet_pr_loop SET state='awaiting-review',request_ts=?,updated_at=?
      ,post_lease_token=NULL,post_lease_until=NULL
      WHERE repo=? AND pr_number=? AND head=? AND state='posting' AND post_lease_token=?`)
      .run(String(posted.ts), now(), row.repo, row.pr_number, row.head, postToken);
    events.push(`FLEET_PR_REVIEW_REQUESTED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} request_ts=${posted.ts}`);
  } catch (error) {
    dbHandle.query(`UPDATE fleet_pr_loop SET state='post-failed',updated_at=?
      ,post_lease_token=NULL,post_lease_until=NULL
      WHERE repo=? AND pr_number=? AND head=? AND state='posting' AND post_lease_token=?`)
      .run(now(), row.repo, row.pr_number, row.head, postToken);
    fleetError("PR_LOOP_POST", `task=${row.task_key} signal=pr:${row.repo}#${row.pr_number}`, error);
  }
  return true;
}

const PR_LOOP_REJECT_LEASE_MS = 120_000;

function claimPrLoopRejection(dbHandle, row, verdict = null) {
  const token = crypto.randomUUID();
  const deliveryAttempt = crypto.randomUUID();
  const claimedAt = now();
  const leaseUntil = new Date(Date.now() + PR_LOOP_REJECT_LEASE_MS).toISOString();
  const changed = dbHandle.transaction(() => verdict
    ? dbHandle.query(`UPDATE fleet_pr_loop SET state='rejecting',verdict=?,verdict_ts=?,
        reject_sent_at=NULL,reject_delivery_attempt=?,reject_submit_confirmed_at=NULL,
        merge_pending_since=NULL,merge_ambiguous_since=NULL,merge_ambiguous_count=0,merge_retry_at=NULL,merge_failure_reason=NULL,
        reject_lease_token=?,reject_lease_until=?,updated_at=?
        WHERE repo=? AND pr_number=? AND head=?
          AND state IN ('awaiting-review','accepted','merge-failed','merge-pending','merge-timeout','merge-needs-attention')`)
      .run(verdict.text, verdict.ts, deliveryAttempt, token, leaseUntil, claimedAt, row.repo, row.pr_number, row.head).changes
    : dbHandle.query(`UPDATE fleet_pr_loop SET state='rejecting',reject_delivery_attempt=COALESCE(reject_delivery_attempt,?),
        reject_lease_token=?,reject_lease_until=?,updated_at=?
        WHERE repo=? AND pr_number=? AND head=? AND reject_sent_at IS NULL
          AND (state='reject-failed' OR (state='rejecting' AND (reject_lease_until IS NULL OR reject_lease_until<=?)))`)
      .run(deliveryAttempt, token, leaseUntil, claimedAt, row.repo, row.pr_number, row.head, claimedAt).changes
  ).immediate();
  return changed === 1 ? token : null;
}

function prLoopRejectDeliveryMarker(row, attempt) {
  return `FLEET_REJECT_DELIVERY:${encodeURIComponent(row.task_key)}:${row.repo}#${row.pr_number}:${row.head}:${attempt}`;
}

const PR_LOOP_REJECT_SCROLLBACK_LINES = 10_000;

function prLoopRejectMarkerLocation(screen, marker) {
  const text = String(screen ?? "").replace(/\r/g, "");
  const prompt = [...text.matchAll(/^[ \t]*❯/gm)].at(-1);
  const compact = (value) => value.replace(/\s+/g, "");
  const compactMarker = compact(marker);
  if (!prompt) return compact(text).includes(compactMarker) ? "submitted" : "absent";
  if (compact(text.slice(0, prompt.index)).includes(compactMarker)) return "submitted";
  if (compact(text.slice(prompt.index)).includes(compactMarker)) return "input";
  return "absent";
}

function prLoopRejectScrollbackComplete(transcript) {
  if (transcript?.truncated === true) return false;
  const stdout = String(transcript?.stdout ?? "");
  const stderr = String(transcript?.stderr ?? "");
  if (/(?:output|scrollback).{0,24}(?:truncated|limit reached)|(?:truncated|limit reached).{0,24}(?:output|scrollback)/i.test(stderr))
    return false;
  if (/(?:^|\n)\s*\[?(?:output|scrollback)\s+truncated\b/im.test(stdout)) return false;
  return stdout.split(/\r?\n/).length < PR_LOOP_REJECT_SCROLLBACK_LINES;
}

function rejectDeliveryAttentionError(code, detail) {
  const error = new Error(detail);
  error.code = code;
  return error;
}

const PR_LOOP_REJECT_ALLOWED_TASK_STATES = [
  "done-claimed", "blocked", "not-done", "working", "tracked-unconfirmed", "sent-unconfirmed", "send-failed-unconfirmed",
];

async function sendPrLoopFollowup(dbHandle, row, verdict, runCommand, readPane, sendFollowup, rejectLeaseToken) {
  if (!rejectLeaseToken) throw new Error("REJECT_LEASE_REQUIRED");
  const task = dbHandle.query(`SELECT t.cat,c.pane,t.status,t.dispatch_attempt,t.send_attempted,t.completion_claimed
    FROM tasks t LEFT JOIN cats c ON c.id=t.cat WHERE t.key=?`).get(row.task_key);
  const pane = configuredCatPane(task?.cat, task?.pane);
  if (!pane || pane === "-") throw new Error("task pane unavailable");
  const delivery = dbHandle.query(`SELECT reject_delivery_attempt,reject_submit_confirmed_at FROM fleet_pr_loop
    WHERE repo=? AND pr_number=? AND head=? AND state='rejecting' AND reject_lease_token=?`)
    .get(row.repo, row.pr_number, row.head, rejectLeaseToken);
  if (!delivery) throw new Error("REJECT_LEASE_LOST");
  const deliveryAttempt = delivery.reject_delivery_attempt ?? row.reject_delivery_attempt;
  if (!deliveryAttempt) throw new Error("REJECT_DELIVERY_ATTEMPT_REQUIRED");
  const recordSendAttempt = () => dbHandle.transaction(() => {
    const current = dbHandle.query("SELECT status,dispatch_attempt,send_attempted,completion_claimed FROM tasks WHERE key=?").get(row.task_key);
    if (!current) throw new Error("REJECT_TASK_MISSING");
    if (["verified-done", "closed"].includes(current.status)
      || current.status !== task.status || current.dispatch_attempt !== task.dispatch_attempt
      || current.send_attempted !== task.send_attempted || current.completion_claimed !== task.completion_claimed)
      throw rejectDeliveryAttentionError("REJECT_TASK_STATE_CHANGED", `task state changed before follow-up send: ${current.status}`);
    if (current.dispatch_attempt === deliveryAttempt && current.send_attempted) return;
    if (!PR_LOOP_REJECT_ALLOWED_TASK_STATES.includes(current.status)
      && !(current.status === "dispatching" && current.dispatch_attempt === deliveryAttempt))
      throw rejectDeliveryAttentionError("REJECT_TASK_STATE_CHANGED", `task state is not eligible for follow-up send: ${current.status}`);
    const sentAt = now();
    const changed = dbHandle.query(`UPDATE tasks SET status='dispatching',sent_at=?,started_at=NULL,ended_at=NULL,
      result=NULL,completion_claimed=0,send_attempted=1,dispatch_attempt=? WHERE key=? AND status=?
      AND dispatch_attempt IS ? AND send_attempted=? AND completion_claimed=?
      AND status IN (${[...PR_LOOP_REJECT_ALLOWED_TASK_STATES, "dispatching"].map(() => "?").join(",")})`)
      .run(sentAt, deliveryAttempt, row.task_key, task.status, task.dispatch_attempt, task.send_attempted,
        task.completion_claimed, ...PR_LOOP_REJECT_ALLOWED_TASK_STATES, "dispatching").changes;
    if (!changed) throw rejectDeliveryAttentionError("REJECT_TASK_STATE_CHANGED", "task changed before follow-up send claim");
    appendHistoryInTransaction(dbHandle, row.task_key, {
      ev: "send-attempted", attempt: deliveryAttempt, source: "cursor-reject-followup", at: sentAt,
    });
  }).immediate();
  const marker = prLoopRejectDeliveryMarker(row, deliveryAttempt);
  const complete = () => {
    const sentAt = now();
    dbHandle.transaction(() => {
      const currentTask = dbHandle.query("SELECT status,dispatch_attempt,send_attempted,completion_claimed FROM tasks WHERE key=?")
        .get(row.task_key);
      if (!currentTask) throw rejectDeliveryAttentionError("REJECT_TASK_STATE_CHANGED", "task disappeared after follow-up submission");
      if (!["verified-done", "closed", "blocked", "done-claimed", "not-done"].includes(currentTask.status)
        && !currentTask.completion_claimed && currentTask.dispatch_attempt === deliveryAttempt && currentTask.send_attempted) {
        const taskChanged = dbHandle.query(`UPDATE tasks SET status='working',completion_claimed=0,result=NULL WHERE key=?
          AND dispatch_attempt=? AND send_attempted=1 AND completion_claimed=0
          AND status IN ('dispatching','sent-unconfirmed','send-failed-unconfirmed','working')`)
          .run(row.task_key, deliveryAttempt).changes;
        if (!taskChanged) throw rejectDeliveryAttentionError("REJECT_TASK_STATE_CHANGED", "task state changed after follow-up submission");
        appendHistoryInTransaction(dbHandle, row.task_key, {
          ev: "cursor-reject-followup", attempt: deliveryAttempt, signal: `pr:${row.repo}#${row.pr_number}`, head: row.head, text: verdict.text,
        });
      }
      const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state='rejected',verdict=?,verdict_ts=?,
        reject_sent_at=?,reject_submit_confirmed_at=COALESCE(reject_submit_confirmed_at,?),
        reject_lease_token=NULL,reject_lease_until=NULL,updated_at=?
        WHERE repo=? AND pr_number=? AND head=? AND state='rejecting' AND reject_lease_token=?`)
        .run(verdict.text, verdict.ts, sentAt, sentAt, sentAt, row.repo, row.pr_number, row.head, rejectLeaseToken).changes;
      if (!changed) throw new Error("REJECT_LEASE_LOST");
    }).immediate();
  };
  const readScrollback = async () => {
    const transcript = await readPane(pane);
    if (transcript?.exitCode !== 0)
      throw rejectDeliveryAttentionError("REJECT_SCROLLBACK_INCOMPLETE", `pane scrollback read failed with exit ${transcript?.exitCode ?? "unavailable"}`);
    return transcript;
  };
  if (delivery.reject_submit_confirmed_at) {
    recordSendAttempt();
    complete();
    return;
  }
  const transcript = await readScrollback();
  const markerLocation = prLoopRejectMarkerLocation(transcript.stdout, marker);
  if (markerLocation === "submitted") {
    recordSendAttempt();
    complete();
    return;
  }
  if (markerLocation === "input") {
    recordSendAttempt();
    const enter = await runCommand(["herdr", "pane", "send-keys", pane, "Enter"]);
    if (enter.exitCode !== 0) throw rejectDeliveryAttentionError("REJECT_ENTER_RETRYABLE", `pane Enter exited ${enter.exitCode}`);
  } else {
    if (!prLoopRejectScrollbackComplete(transcript))
      throw rejectDeliveryAttentionError("REJECT_SCROLLBACK_INCOMPLETE", "pane scrollback cannot prove the rejection marker is absent");
    recordSendAttempt();
    const text = `Cursor REJECT for ${row.repo}#${row.pr_number} head=${row.head} attempt=${deliveryAttempt}:\n${verdict.text}\nUse attempt=${deliveryAttempt} in the final ${row.task_key}_DONE or ${row.task_key}_BLOCKED marker.\n${marker}`;
    if (sendFollowup) {
      if (!await sendFollowup(pane, text, row))
        throw rejectDeliveryAttentionError("REJECT_SEND_FAILED", "pane follow-up send failed");
    } else {
      const sent = await runCommand(["herdr", "pane", "send-text", pane, text]);
      if (sent.exitCode !== 0) throw rejectDeliveryAttentionError("REJECT_SEND_FAILED", `pane send-text exited ${sent.exitCode}`);
      const enter = await runCommand(["herdr", "pane", "send-keys", pane, "Enter"]);
      if (enter.exitCode !== 0) throw rejectDeliveryAttentionError("REJECT_ENTER_RETRYABLE", `pane Enter exited ${enter.exitCode}`);
    }
  }
  const confirmation = await readScrollback();
  if (prLoopRejectMarkerLocation(confirmation.stdout, marker) !== "submitted")
    throw rejectDeliveryAttentionError("REJECT_SUBMIT_UNCONFIRMED", "pane does not show the rejection marker in submitted output");
  complete();
}

function recordPrLoopRejectFailure(dbHandle, row, rejectLeaseToken, error, events, signal) {
  const result = dbHandle.transaction(() => {
    const owned = dbHandle.query(`SELECT reject_delivery_attempt FROM fleet_pr_loop
      WHERE repo=? AND pr_number=? AND head=? AND state='rejecting' AND reject_lease_token=?`)
      .get(row.repo, row.pr_number, row.head, rejectLeaseToken);
    if (!owned) return { changed: false, reason: null };
    const deliveryAttempt = owned.reject_delivery_attempt ?? row.reject_delivery_attempt;
    let taskNeedsAttention = false;
    const task = deliveryAttempt
      ? dbHandle.query("SELECT status,dispatch_attempt,send_attempted,completion_claimed FROM tasks WHERE key=?").get(row.task_key)
      : null;
    let retryableEnterFailure = false;
    if (error?.code === "REJECT_ENTER_RETRYABLE" && task?.dispatch_attempt === deliveryAttempt
      && task.send_attempted && task.status === "dispatching" && !task.completion_claimed) {
      const detail = String(error?.message ?? error).slice(0, 240);
      const taskChanged = dbHandle.query(`UPDATE tasks SET status='sent-unconfirmed',result=?
        WHERE key=? AND status='dispatching' AND dispatch_attempt=? AND send_attempted=1 AND completion_claimed=0`)
        .run(`Cursor REJECT Enter remains unconfirmed: ${detail}`, row.task_key, deliveryAttempt).changes;
      if (taskChanged) {
        appendHistoryInTransaction(dbHandle, row.task_key, {
          ev: "sent-unconfirmed", attempt: deliveryAttempt, source: "cursor-reject-followup", detail,
        });
        retryableEnterFailure = true;
      }
    }
    if (!retryableEnterFailure && task?.dispatch_attempt === deliveryAttempt && task.send_attempted
      && task.status === "dispatching" && !task.completion_claimed) {
      const detail = String(error?.message ?? error).slice(0, 240);
      const definitelyNotDelivered = error?.code === "REJECT_SEND_FAILED";
      const taskChanged = definitelyNotDelivered
        ? dbHandle.query(`UPDATE tasks SET status='blocked',result=?,ended_at=?,completion_claimed=0
          WHERE key=? AND status='dispatching' AND dispatch_attempt=? AND send_attempted=1 AND completion_claimed=0`)
          .run(`Cursor REJECT follow-up needs attention: ${detail}`, now(), row.task_key, deliveryAttempt).changes
        : dbHandle.query(`UPDATE tasks SET status='sent-unconfirmed',result=?,completion_claimed=0
          WHERE key=? AND status='dispatching' AND dispatch_attempt=? AND send_attempted=1 AND completion_claimed=0`)
          .run(`Cursor REJECT follow-up delivery is unconfirmed: ${detail}`, row.task_key, deliveryAttempt).changes;
      if (taskChanged) {
        appendHistoryInTransaction(dbHandle, row.task_key, {
          ev: definitelyNotDelivered ? "cursor-reject-followup-failed" : "sent-unconfirmed",
          attempt: deliveryAttempt,
          source: "cursor-reject-followup",
          reason: definitelyNotDelivered ? "send_failed" : "delivery_unconfirmed",
          text: detail,
        });
        taskNeedsAttention = true;
      }
    }
    const reason = error?.code === "REJECT_SCROLLBACK_INCOMPLETE" ? "scrollback_incomplete"
      : error?.code === "REJECT_SUBMIT_UNCONFIRMED" ? "submit_unconfirmed"
        : error?.code === "REJECT_TASK_STATE_CHANGED" ? "task_state_changed"
          : error?.code === "REJECT_ENTER_RETRYABLE" && retryableEnterFailure ? null
          : error?.code === "REJECT_SEND_FAILED" ? "send_failed"
            : taskNeedsAttention ? "delivery_unconfirmed"
            : null;
    const state = reason ? "reject-needs-attention" : "reject-failed";
    const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state=?,reject_lease_token=NULL,reject_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='rejecting' AND reject_lease_token=?`)
      .run(state, now(), row.repo, row.pr_number, row.head, rejectLeaseToken).changes;
    return { changed, reason };
  }).immediate();
  if (result.changed && result.reason)
    events.push(`FLEET_PR_REJECT_NEEDS_ATTENTION ${row.task_key} ${signal} head=${row.head} reason=${result.reason}`);
  fleetError("PR_LOOP_REJECT", `task=${row.task_key} signal=${signal}`, error);
}

const activePrLoopMerges = new Set();
const PR_LOOP_MERGE_LEASE_MS = 120_000;
const MAX_PR_LOOP_MERGE_ATTEMPTS = 3;
const PR_LOOP_MERGE_RETRY_BASE_MS = 30_000;
const PR_LOOP_MERGE_RETRY_MAX_MS = 300_000;
const PR_LOOP_MERGE_AMBIGUOUS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function classifyPrLoopMergeFailure(result) {
  const exitCode = Number(result?.exitCode);
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}\n${result?.message ?? ""}`.toLowerCase();
  const rateLimitStatus = /\b(?:http\s*)?(?:403|429)\b/i.test(text);
  const rateLimitText = /rate[\s-]?limit|secondary rate|abuse|retry[\s-]?after|api rate limit exceeded/i.test(text);
  if (rateLimitStatus && rateLimitText) return null;
  if (/\b(?:http\s*)?403\b/i.test(text)) return "permission_denied";
  if (exitCode === 4) return "authentication_required";
  if (/authentication required|not logged in|gh auth login|unauthorized/.test(text))
    return "authentication_required";
  if (/permission denied|permission to .* denied|resource not accessible|forbidden|must have (?:admin|administrator|write)|admin\/write|\bpermission\b/.test(text))
    return "permission_denied";
  if (/not mergeable|merge conflict|conflicts with|has conflicts/.test(text))
    return "not_mergeable";
  if (/pull request.{0,40}\bclosed\b|\bpr\b.{0,40}\bclosed\b|closed without merge/.test(text))
    return "pull_request_closed";
  return null;
}

async function mergeAcceptedPrLoopHead(dbHandle, row, config, runCommand) {
  const mergeKey = `${row.repo}#${row.pr_number}@${row.head}`;
  if (activePrLoopMerges.has(mergeKey)) return null;
  const method = configuredRepositoryValue(config.mergeMethods, row.repo) ?? "merge";
  const mergeFlag = { merge: "--merge", squash: "--squash", rebase: "--rebase" }[method];
  if (!mergeFlag) {
    const reason = `invalid_merge_method=${method}`;
    dbHandle.query("UPDATE fleet_pr_loop SET state='merge-failed',updated_at=? WHERE repo=? AND pr_number=? AND head=? AND state='accepted'")
      .run(now(), row.repo, row.pr_number, row.head);
    return `FLEET_PR_MERGE_FAILED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=${reason}`;
  }
  const mergeLeaseToken = crypto.randomUUID();
  const mergeLeaseUntil = new Date(Date.now() + PR_LOOP_MERGE_LEASE_MS).toISOString();
  const claimed = dbHandle.transaction(() => dbHandle.query(`UPDATE fleet_pr_loop
    SET state='merging',merge_lease_token=?,merge_lease_until=?,updated_at=?
    WHERE repo=? AND pr_number=? AND head=? AND state='accepted'`)
    .run(mergeLeaseToken, mergeLeaseUntil, now(), row.repo, row.pr_number, row.head).changes === 1).immediate();
  if (!claimed) return null;
  activePrLoopMerges.add(mergeKey);
  const retry = (reason) => {
    dbHandle.query(`UPDATE fleet_pr_loop SET state='accepted',merge_lease_token=NULL,merge_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .run(now(), row.repo, row.pr_number, row.head, mergeLeaseToken);
    return `FLEET_PR_MERGE_RETRY ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=${reason}`;
  };
  const pending = (reason) => {
    const pendingAt = now();
    dbHandle.query(`UPDATE fleet_pr_loop SET state='merge-pending',
      merge_pending_since=COALESCE(merge_pending_since,?),merge_retry_at=NULL,
      merge_ambiguous_since=NULL,merge_ambiguous_count=0,merge_failure_reason=NULL,
      merge_lease_token=NULL,merge_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .run(pendingAt, pendingAt, row.repo, row.pr_number, row.head, mergeLeaseToken);
    return `FLEET_PR_MERGE_PENDING ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=${reason}`;
  };
  const retryableFailure = (reason) => {
    const current = dbHandle.query(`SELECT merge_failure_count FROM fleet_pr_loop
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .get(row.repo, row.pr_number, row.head, mergeLeaseToken);
    if (!current) return null;
    const attempts = Number(current.merge_failure_count ?? 0) + 1;
    const retryAt = attempts >= MAX_PR_LOOP_MERGE_ATTEMPTS
      ? null
      : new Date(Date.now() + Math.min(PR_LOOP_MERGE_RETRY_BASE_MS * (2 ** (attempts - 1)), PR_LOOP_MERGE_RETRY_MAX_MS)).toISOString();
    const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state='merge-failed',merge_failure_count=?,
      merge_retry_at=?,merge_failure_reason=?,merge_pending_since=NULL,merge_ambiguous_since=NULL,
      merge_ambiguous_count=0,merge_lease_token=NULL,merge_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .run(attempts, retryAt, reason, now(), row.repo, row.pr_number, row.head, mergeLeaseToken).changes;
    if (!changed) return null;
    const retry = retryAt ? ` retry_at=${retryAt}` : " retry=exhausted";
    return `FLEET_PR_MERGE_FAILED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=${reason} attempt=${attempts}/${MAX_PR_LOOP_MERGE_ATTEMPTS}${retry}`;
  };
  const ambiguousFailure = (reason) => {
    const current = dbHandle.query(`SELECT merge_ambiguous_count,merge_ambiguous_since FROM fleet_pr_loop
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .get(row.repo, row.pr_number, row.head, mergeLeaseToken);
    if (!current) return null;
    const pendingAt = now();
    const ambiguousSince = current.merge_ambiguous_since ?? pendingAt;
    const elapsed = Date.now() - Date.parse(ambiguousSince);
    const attempts = Number(current.merge_ambiguous_count ?? 0) + 1;
    const attention = Number.isFinite(elapsed) && elapsed >= PR_LOOP_MERGE_AMBIGUOUS_TIMEOUT_MS;
    const retryAt = attention ? null
      : new Date(Date.now() + Math.min(PR_LOOP_MERGE_RETRY_BASE_MS * (2 ** (attempts - 1)), PR_LOOP_MERGE_RETRY_MAX_MS)).toISOString();
    const state = attention ? "merge-needs-attention" : "merge-pending";
    const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state=?,merge_pending_since=COALESCE(merge_pending_since,?),
      merge_ambiguous_since=?,merge_ambiguous_count=?,merge_retry_at=?,merge_failure_reason=?,
      merge_lease_token=NULL,merge_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .run(state, pendingAt, ambiguousSince, attempts, retryAt, reason, now(),
        row.repo, row.pr_number, row.head, mergeLeaseToken).changes;
    if (!changed) return null;
    return attention
      ? `FLEET_PR_MERGE_NEEDS_ATTENTION ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=ambiguous_timeout`
      : `FLEET_PR_MERGE_PENDING ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=ambiguous_${reason} retry_at=${retryAt} ambiguous_attempt=${attempts}`;
  };
  const closedEvent = () => {
    const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state='closed',
      merge_failure_count=COALESCE(merge_failure_count,0)+1,merge_failure_reason='pull_request_closed',
      merge_pending_since=NULL,merge_ambiguous_since=NULL,merge_ambiguous_count=0,merge_retry_at=NULL,
      merge_lease_token=NULL,merge_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .run(now(), row.repo, row.pr_number, row.head, mergeLeaseToken).changes;
    return changed ? `FLEET_PR_CLOSED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head}` : null;
  };
  const fail = (reason) => {
    dbHandle.query(`UPDATE fleet_pr_loop SET state='merge-failed',merge_lease_token=NULL,merge_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .run(now(), row.repo, row.pr_number, row.head, mergeLeaseToken);
    return `FLEET_PR_MERGE_FAILED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=${reason}`;
  };
  const mergedEvent = (mergeSha) => {
    dbHandle.query(`UPDATE fleet_pr_loop SET state='merged',merge_sha=?,merge_pending_since=NULL,
      merge_ambiguous_since=NULL,merge_ambiguous_count=0,merge_retry_at=NULL,
      merge_lease_token=NULL,merge_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='merging' AND merge_lease_token=?`)
      .run(mergeSha, now(), row.repo, row.pr_number, row.head, mergeLeaseToken);
    return `FLEET_PR_MERGED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} merge_sha=${mergeSha}`;
  };
  let mergeCommandAttempted = false;
  try {
    let info = await prLoopPullRequestInfo(`pr:${row.repo}#${row.pr_number}`, runCommand);
    if (!info) return retry("pr_lookup_unavailable");
    if (info.headRefOid?.toLowerCase() !== row.head) {
      const reason = `head changed actual=${info.headRefOid ?? "unavailable"}`;
      fleetError("PR_LOOP_MERGE", `signal=pr:${row.repo}#${row.pr_number}`, reason);
      return fail(reason);
    }
    if (info.isDraft) return retry("pr_is_draft");
    if (info.state === "MERGED" && /^[a-f0-9]{40}$/i.test(info.mergeCommit?.oid || "")) {
      return mergedEvent(info.mergeCommit.oid.toLowerCase());
    }
    if (info.state !== "OPEN") return retry("pr_not_open");
    mergeCommandAttempted = true;
    const merged = await runCommand([
      "gh", "pr", "merge", row.pr_number, "-R", row.repo, mergeFlag, "--match-head-commit", row.head,
    ], AbortSignal.timeout(30_000));
    if (merged.exitCode !== 0) {
      const reason = classifyPrLoopMergeFailure(merged);
      if (reason === "pull_request_closed") return closedEvent();
      return reason ? retryableFailure(reason) : ambiguousFailure(`merge_command_exit_${merged.exitCode}`);
    }
    const result = await runCommand([
      "gh", "pr", "view", row.pr_number, "-R", row.repo, "--json", "state,headRefOid,mergeCommit",
    ], AbortSignal.timeout(10_000));
    if (result.exitCode !== 0) return pending("merge_status_pending");
    let data;
    try { data = JSON.parse(result.stdout); } catch { return pending("merge_status_unavailable"); }
    if (data.headRefOid?.toLowerCase() !== row.head) return fail(`head changed actual=${data.headRefOid ?? "unavailable"}`);
    const mergeSha = data.mergeCommit?.oid?.toLowerCase();
    if (data.state === "MERGED" && /^[a-f0-9]{40}$/.test(mergeSha ?? "")) return mergedEvent(mergeSha);
    if (data.state === "OPEN") return pending("checks_pending");
    if (data.state === "CLOSED") return fail("pr_closed_without_merge");
    return pending("merge_status_inconclusive");
  } catch (error) {
    fleetError("PR_LOOP_MERGE", `signal=pr:${row.repo}#${row.pr_number}`, error);
    const reason = classifyPrLoopMergeFailure({
      exitCode: error?.exitCode,
      stdout: error?.stdout,
      stderr: error?.stderr,
      message: error?.message,
    });
    if (reason === "pull_request_closed") return closedEvent();
    if (reason) return retryableFailure(reason);
    if (mergeCommandAttempted) return ambiguousFailure("merge_command_result_unknown");
    return fail(String(error?.message ?? error).slice(0, 120));
  } finally {
    activePrLoopMerges.delete(mergeKey);
  }
}

const activePrLoopDeployments = new Set();
const pendingPrLoopDeployEvents = [];
const MAX_PR_LOOP_DEPLOYMENTS = 1;

function reportPrLoopDeployCompletion(io, event) {
  if (typeof io.onDeploySettled === "function") {
    try { io.onDeploySettled(event); } catch (error) {
      fleetError("PR_LOOP_DEPLOY_NOTIFY", "background", error);
    }
  } else {
    pendingPrLoopDeployEvents.push(event);
  }
}

function deployMergedPrLoopRow(dbHandle, row, config, io, events, runCommand) {
  if (!["merged", "deploying"].includes(row.state)) return;
  const deployment = configuredRepositoryValue(config.deploy, row.repo);
  if (!deployment) {
    if (row.state === "merged") {
      const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state='merged-no-deploy',updated_at=?
        WHERE repo=? AND pr_number=? AND head=? AND state='merged'`)
        .run(now(), row.repo, row.pr_number, row.head).changes;
      if (changed) events.push(`FLEET_MERGED_NO_DEPLOY owner=omonyang ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head}`);
      return;
    }
    const deploymentKey = `${row.repo}#${row.pr_number}@${row.head}`;
    if (activePrLoopDeployments.has(deploymentKey)) return;
    const checkedAt = now();
    const changed = dbHandle.transaction(() => dbHandle.query(`UPDATE fleet_pr_loop
      SET state='deploy-needs-attention',deploy_lease_token=NULL,deploy_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='deploying'
        AND (deploy_lease_until IS NULL OR deploy_lease_until<=?)`)
      .run(checkedAt, row.repo, row.pr_number, row.head, checkedAt).changes).immediate();
    if (changed) {
      appendTaskHistory(dbHandle, row.task_key, {
        ev: "deploy-needs-attention", signal: `pr:${row.repo}#${row.pr_number}`, head: row.head,
        merge_sha: row.merge_sha, detail: "deploy_config_removed_after_lease_expired",
      });
      events.push(`FLEET_DEPLOY_NEEDS_ATTENTION ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=deploy_config_removed`);
    }
    return;
  }
  if (!Array.isArray(deployment.argv) || !deployment.argv.length || typeof deployment.healthUrl !== "string") {
    dbHandle.query("UPDATE fleet_pr_loop SET state='deploy-failed',updated_at=? WHERE repo=? AND pr_number=? AND head=? AND state='merged'")
      .run(now(), row.repo, row.pr_number, row.head);
    events.push(`FLEET_DEPLOY_FAILED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=invalid_deploy_config`);
    return;
  }
  if (activePrLoopDeployments.size >= MAX_PR_LOOP_DEPLOYMENTS) return;
  const timeoutMs = Number(config.deployTimeoutMs) > 0 ? Number(config.deployTimeoutMs) : 300_000;
  const deploymentLeaseToken = crypto.randomUUID();
  const deploymentLeaseUntil = new Date(Date.now() + Math.max(60_000, timeoutMs * 2 + 60_000)).toISOString();
  const claimNow = now();
  const claimed = dbHandle.transaction(() => dbHandle.query(`UPDATE fleet_pr_loop
    SET state='deploying',deploy_lease_token=?,deploy_lease_until=?,updated_at=?
    WHERE repo=? AND pr_number=? AND head=?
      AND (state='merged' OR (state='deploying' AND (deploy_lease_until IS NULL OR deploy_lease_until<=?)))`)
    .run(deploymentLeaseToken, deploymentLeaseUntil, claimNow, row.repo, row.pr_number, row.head, claimNow).changes === 1).immediate();
  if (!claimed) return;
  const expectedMergeSha = row.merge_sha?.toLowerCase() ?? "";
  const deploymentKey = `${row.repo}#${row.pr_number}@${row.head}`;
  activePrLoopDeployments.add(deploymentKey);
  events.push(`FLEET_DEPLOY_STARTED ${row.task_key} pr:${row.repo}#${row.pr_number} merge_sha=${expectedMergeSha}`);
  const getMainSha = io.getMainSha ?? ((repo) => defaultBranchSha(repo, runCommand));
  const runDeploy = io.runDeploy ?? ((repo, deploy, mergeSha, timeout) =>
    runDoriHeavyDeploy(repo, deploy, mergeSha, timeout, runCommand));
  const checkHealth = io.checkHealth ?? checkDeployHealth;
  const job = (async () => {
    let failure = "";
    try {
      if (!/^[a-f0-9]{40}$/.test(expectedMergeSha)) throw new Error("invalid_merge_sha");
      const mainBefore = String(await getMainSha(row.repo) ?? "").toLowerCase();
      if (mainBefore !== expectedMergeSha) throw new Error(`default_branch_sha_mismatch expected=${expectedMergeSha} actual=${mainBefore || "unavailable"}`);
      const result = await runDeploy(row.repo, deployment, expectedMergeSha, timeoutMs);
      if (result.exitCode !== 0) throw new Error(`deploy_exit_${result.exitCode}`);
      const health = await checkHealth(deployment.healthUrl, timeoutMs, expectedMergeSha);
      if (health?.status !== 200) throw new Error(`health_http_${health?.status ?? "unavailable"}`);
      const reportedMergeSha = String(health.mergeSha ?? health.sha ?? health.revision ?? "").toLowerCase();
      if (reportedMergeSha !== expectedMergeSha) throw new Error("health_merge_sha_mismatch");
      const mainAfter = String(await getMainSha(row.repo) ?? "").toLowerCase();
      if (mainAfter !== expectedMergeSha) throw new Error(`default_branch_sha_moved expected=${expectedMergeSha} actual=${mainAfter || "unavailable"}`);
    } catch (error) {
      failure = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 120);
    }
    const state = failure ? "deploy-failed" : "deployed";
    const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state=?,deploy_lease_token=NULL,deploy_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='deploying' AND deploy_lease_token=?`)
      .run(state, now(), row.repo, row.pr_number, row.head, deploymentLeaseToken).changes;
    if (!changed) return null;
    appendTaskHistory(dbHandle, row.task_key, {
      ev: state, signal: `pr:${row.repo}#${row.pr_number}`, head: row.head, merge_sha: expectedMergeSha,
      detail: failure || `health_http_200 merge_sha=${expectedMergeSha}`,
    });
    return failure
      ? `FLEET_DEPLOY_FAILED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=${failure}`
      : `FLEET_DEPLOYED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} merge_sha=${expectedMergeSha} health=200`;
  })();
  void job.then((event) => {
    activePrLoopDeployments.delete(deploymentKey);
    if (event) reportPrLoopDeployCompletion(io, event);
  }, (error) => {
    activePrLoopDeployments.delete(deploymentKey);
    fleetError("PR_LOOP_DEPLOY", `pr:${row.repo}#${row.pr_number}`, error);
    const event = `FLEET_DEPLOY_FAILED ${row.task_key} pr:${row.repo}#${row.pr_number} head=${row.head} reason=internal_error`;
    try {
      dbHandle.query(`UPDATE fleet_pr_loop SET state='deploy-failed',deploy_lease_token=NULL,deploy_lease_until=NULL,updated_at=?
        WHERE repo=? AND pr_number=? AND head=? AND state='deploying' AND deploy_lease_token=?`)
        .run(now(), row.repo, row.pr_number, row.head, deploymentLeaseToken);
      appendTaskHistory(dbHandle, row.task_key, {
        ev: "deploy-failed", signal: `pr:${row.repo}#${row.pr_number}`, head: row.head, merge_sha: expectedMergeSha, detail: "internal_error",
      });
    } catch (persistError) {
      fleetError("PR_LOOP_DEPLOY_PERSIST", `pr:${row.repo}#${row.pr_number}`, persistError);
    }
    reportPrLoopDeployCompletion(io, event);
  });
}

export async function processPrLoopEvents(dbHandle = db, config = CONFIG.prLoop, io = {}) {
  if (!config?.enabled) return [];
  const runCommand = io.runCommand ?? executeSignalCommand;
  const readPane = io.readPane ?? ((pane) => runCommand([
    "herdr", "pane", "read", pane, "--source", "recent",
    "--lines", String(PR_LOOP_REJECT_SCROLLBACK_LINES), "--format", "text",
  ]));
  const postMessage = io.postMessage ?? defaultPrLoopPost;
  const fetchReplies = io.fetchReplies ?? defaultPrLoopReplies;
  const events = pendingPrLoopDeployEvents.splice(0);
  const leaseCheckAt = now();
  const waiting = dbHandle.query(`SELECT repo,pr_number,head,state,merge_pending_since,merge_ambiguous_since,merge_retry_at,merge_ambiguous_count FROM fleet_pr_loop
    WHERE state IN ('awaiting-review','accepted','posting','post-failed','merge-failed','merge-pending','merge-timeout','merge-needs-attention')
      OR (state='merging' AND (merge_lease_until IS NULL OR merge_lease_until<=?))
      `).all(leaseCheckAt);
  const needsReplies = waiting.some((row) => {
    if (row.state === "merging") return !activePrLoopMerges.has(`${row.repo}#${row.pr_number}@${row.head}`);
    if (row.state === "merge-pending") {
      const ambiguousSince = Date.parse(row.merge_ambiguous_since ?? row.merge_pending_since ?? "");
      if (Number(row.merge_ambiguous_count ?? 0) > 0 && Number.isFinite(ambiguousSince)
        && Date.now() - ambiguousSince >= PR_LOOP_MERGE_AMBIGUOUS_TIMEOUT_MS) return false;
    }
    return true;
  });
  let replies = [];
  let repliesAvailable = !needsReplies;
  if (needsReplies) {
    try {
      const fetched = await fetchReplies(config.reviewChannel, config.reviewThreadTs);
      if (Array.isArray(fetched)) {
        replies = fetched;
        repliesAvailable = true;
      }
    } catch (error) {
      fleetError("PR_LOOP_SLACK_READ", `thread=${config.reviewThreadTs}`, error);
    }
  }
  for (const row of dbHandle.query("SELECT repo,pr_number,head FROM fleet_pr_loop WHERE state='merging'").all()) {
    const mergeKey = `${row.repo}#${row.pr_number}@${row.head}`;
    if (activePrLoopMerges.has(mergeKey)) continue;
    dbHandle.query(`UPDATE fleet_pr_loop SET state='accepted',merge_lease_token=NULL,merge_lease_until=NULL,updated_at=?
      WHERE repo=? AND pr_number=? AND head=? AND state='merging'
        AND (merge_lease_until IS NULL OR merge_lease_until<=?)`)
      .run(leaseCheckAt, row.repo, row.pr_number, row.head, leaseCheckAt);
  }
  const tasks = dbHandle.query(`SELECT key,cat,done,status,completion_claimed,claim_evidence,history FROM tasks
    WHERE status NOT IN ('closed','blocked') AND (
      (completion_claimed=1 AND status IN ('done-claimed','not-done'))
      OR key IN (SELECT task_key FROM fleet_pr_loop
        WHERE state IN ('awaiting-review','accepted','posting','post-failed','rejecting','reject-failed','reject-needs-attention','merging','merge-pending','merge-timeout','merge-needs-attention','merge-failed'))
    ) ORDER BY sent_at`).all();
  for (const task of tasks) {
    if (task.status === "working" && !task.completion_claimed
      && dbHandle.query("SELECT 1 FROM fleet_pr_loop WHERE task_key=? AND state='rejected' LIMIT 1").get(task.key)) continue;
    const taskSignals = taskPrSignals(task);
    const pendingRejections = new Map();
    for (const candidateSignal of taskSignals) {
      const parsed = parsePullRequestSignal(candidateSignal);
      if (!parsed) continue;
      const candidate = dbHandle.query(`SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=?
        AND task_key=? AND state IN ('awaiting-review','accepted','merge-failed','merge-pending','merge-timeout','merge-needs-attention') ORDER BY updated_at DESC LIMIT 1`)
        .get(parsed.repo, parsed.prNumber, task.key);
      const interruptedReject = dbHandle.query(`SELECT head FROM fleet_pr_loop WHERE repo=? AND pr_number=?
        AND task_key=? AND state IN ('rejecting','reject-failed','reject-needs-attention') LIMIT 1`)
        .get(parsed.repo, parsed.prNumber, task.key);
      if (interruptedReject) pendingRejections.set(candidateSignal, true);
      if (!candidate) continue;
      const verdict = matchPrLoopVerdict(replies, {
        repo: parsed.repo,
        prNumber: parsed.prNumber,
        head: candidate.head,
        threadTs: config.reviewThreadTs,
        afterTs: candidate.request_ts,
      });
      if (verdict?.kind === "reject" && Number(verdict.ts) > Number(candidate.verdict_ts ?? candidate.request_ts)) {
        pendingRejections.set(candidateSignal, { row: candidate, verdict });
      }
    }
    taskSignals.sort((a, b) => Number(pendingRejections.has(b)) - Number(pendingRejections.has(a)));
    let rejectedTaskThisCycle = false;
    for (const signal of taskSignals) {
      if (rejectedTaskThisCycle) continue;
      const { repo, prNumber } = parsePullRequestSignal(signal);
      const pendingReject = pendingRejections.get(signal);
      if (pendingReject && typeof pendingReject === "object") {
        const row = pendingReject.row;
        const verdict = pendingReject.verdict;
        const rejectLeaseToken = claimPrLoopRejection(dbHandle, row, verdict);
        if (!rejectLeaseToken) {
          rejectedTaskThisCycle = true;
          continue;
        }
        try {
          await sendPrLoopFollowup(dbHandle, { ...row, state: "rejecting" }, verdict, runCommand, readPane, io.sendFollowup, rejectLeaseToken);
          events.push(`FLEET_PR_REJECT_FOLLOWUP ${row.task_key} ${signal} head=${row.head}`);
        } catch (error) {
          recordPrLoopRejectFailure(dbHandle, row, rejectLeaseToken, error, events, signal);
        }
        rejectedTaskThisCycle = true;
        continue;
      }
      const rejected = dbHandle.query(`SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=?
        AND task_key=? AND state IN ('rejecting','reject-failed','reject-needs-attention') ORDER BY updated_at DESC LIMIT 1`)
        .get(repo, prNumber, task.key);
      if (rejected) {
        const rejectLeaseToken = claimPrLoopRejection(dbHandle, rejected);
        if (!rejectLeaseToken) {
          rejectedTaskThisCycle = true;
          continue;
        }
        try {
          if (!rejected.verdict) throw new Error("stored reject verdict missing");
          await sendPrLoopFollowup(
            dbHandle,
            rejected,
            { kind: "reject", text: rejected.verdict, ts: String(rejected.verdict_ts ?? "") },
            runCommand,
            readPane,
            io.sendFollowup,
            rejectLeaseToken,
          );
          events.push(`FLEET_PR_REJECT_FOLLOWUP ${rejected.task_key} ${signal} head=${rejected.head}`);
        } catch (error) {
          recordPrLoopRejectFailure(dbHandle, rejected, rejectLeaseToken, error, events, signal);
        }
        rejectedTaskThisCycle = true;
        continue;
      }
      let info = await prLoopPullRequestInfo(signal, runCommand);
      if (!info || !/^[a-f0-9]{40}$/i.test(info.headRefOid || "")) continue;
      const head = info.headRefOid.toLowerCase();
      for (const stale of dbHandle.query(`SELECT head FROM fleet_pr_loop WHERE repo=? AND pr_number=?
        AND head!=? AND state IN ('awaiting-review','accepted','posting','post-failed','merge-pending','merge-timeout','merge-needs-attention','merge-failed')`).all(repo, prNumber, head)) {
        dbHandle.query(`UPDATE fleet_pr_loop SET state='stale-head',updated_at=?
          WHERE repo=? AND pr_number=? AND head=? AND state IN ('awaiting-review','accepted','posting','post-failed','merge-pending','merge-timeout','merge-needs-attention','merge-failed')`)
          .run(now(), repo, prNumber, stale.head);
      }
      let row = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
        .get(repo, prNumber, head);
      const existingRow = Boolean(row);
      if (!row && info.state === "OPEN") {
        const doneSignals = new Set((task.done ?? "").split(";").map((part) => part.trim()));
        const readyClaim = prReadyEvidence(task, signal);
        if (readyClaim && !readyClaim.ok) {
          fleetError("PR_LOOP_CLAIM", `task=${task.key} signal=${signal}`, readyClaim.detail || "PR READY claim not verified");
          continue;
        }
        let claimedHead = readyClaim?.head ?? readyClaim?.actualHead;
        if (claimedHead && /^[a-f0-9]{40}$/i.test(claimedHead)) claimedHead = claimedHead.toLowerCase();
        if (doneSignals.has(signal)) {
          claimedHead = claimedHead || head;
        } else {
          claimedHead = readyClaim && /^[a-f0-9]{40}$/i.test(readyClaim.acceptedPrefix ?? "")
            ? readyClaim.acceptedPrefix.toLowerCase()
            : null;
        }
        if (!claimedHead || head !== claimedHead) {
          fleetError("PR_LOOP_HEAD_MISMATCH", `task=${task.key} signal=${signal}`,
            `claimed=${claimedHead ?? "missing"} actual=${head}`);
          continue;
        }
        info = await ensurePrLoopReady(info, signal, runCommand);
        if (!info) continue;
        const postToken = reservePrLoopRequest(dbHandle, info, task.key);
        if (postToken) {
          const url = info.url || `https://github.com/${repo}/pull/${prNumber}`;
          const text = buildPrLoopReviewRequest(repo, prNumber, url, claimedHead).text;
          try {
            const posted = await postMessage(config.reviewChannel, config.reviewThreadTs, text);
            if (posted?.ok !== true || !posted.ts) throw new Error(posted?.error || "Slack post returned no timestamp");
            dbHandle.query(`UPDATE fleet_pr_loop SET state='awaiting-review',request_ts=?,post_lease_token=NULL,post_lease_until=NULL,updated_at=?
              WHERE repo=? AND pr_number=? AND head=? AND state='posting' AND post_lease_token=?`)
              .run(String(posted.ts), now(), repo, prNumber, claimedHead, postToken);
            events.push(`FLEET_PR_REVIEW_REQUESTED ${task.key} ${signal} head=${claimedHead} request_ts=${posted.ts}`);
          } catch (error) {
            dbHandle.query(`UPDATE fleet_pr_loop SET state='post-failed',post_lease_token=NULL,post_lease_until=NULL,updated_at=?
              WHERE repo=? AND pr_number=? AND head=? AND state='posting' AND post_lease_token=?`)
              .run(now(), repo, prNumber, claimedHead, postToken);
            fleetError("PR_LOOP_POST", `task=${task.key} signal=${signal}`, error);
          }
        }
        row = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
          .get(repo, prNumber, claimedHead);
      }
      if (!row) continue;
      if (row.state === "merge-failed") {
        const retryAt = Date.parse(row.merge_retry_at ?? "");
        const currentCycleVerdict = repliesAvailable ? matchPrLoopVerdict(replies, {
          repo: row.repo,
          prNumber: row.pr_number,
          head: row.head,
          threadTs: config.reviewThreadTs,
          afterTs: row.request_ts,
        }) : null;
        if (!Number.isFinite(retryAt) || Date.now() < retryAt
          || Number(row.merge_failure_count ?? 0) >= MAX_PR_LOOP_MERGE_ATTEMPTS
          || currentCycleVerdict?.kind !== "accept") continue;
        const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state='accepted',merge_retry_at=NULL,updated_at=?
          WHERE repo=? AND pr_number=? AND head=? AND state='merge-failed'
            AND merge_retry_at=? AND merge_failure_count<?`)
          .run(now(), row.repo, row.pr_number, row.head, row.merge_retry_at, MAX_PR_LOOP_MERGE_ATTEMPTS).changes;
        if (!changed) continue;
        row = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
          .get(repo, prNumber, row.head);
      }
      if (existingRow && ["posting", "post-failed"].includes(row.state)) {
        if (!repliesAvailable) continue;
        const requestTs = existingPrLoopRequestTs(replies, row, config.reviewThreadTs);
        if (requestTs) {
          dbHandle.query(`UPDATE fleet_pr_loop SET state='awaiting-review',request_ts=?,
            post_lease_token=NULL,post_lease_until=NULL,updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state IN ('posting','post-failed')`)
            .run(requestTs, now(), row.repo, row.pr_number, row.head);
          events.push(`FLEET_PR_REVIEW_RECOVERED ${row.task_key} ${signal} head=${row.head} request_ts=${requestTs}`);
          row = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
            .get(repo, prNumber, row.head);
        } else if (info.state === "OPEN") {
          await retryPrLoopReviewPost(dbHandle, row, info, config, postMessage, events, runCommand);
          row = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
            .get(repo, prNumber, row.head);
        } else if (info.state === "CLOSED" || info.state === "MERGED") {
          dbHandle.query(`UPDATE fleet_pr_loop SET state='closed',updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state IN ('posting','post-failed')`)
            .run(now(), row.repo, row.pr_number, row.head);
          events.push(`FLEET_PR_CLOSED ${row.task_key} ${signal} head=${row.head}`);
          continue;
        } else {
          continue;
        }
      }
      if (["merge-pending", "merge-timeout", "merge-needs-attention"].includes(row.state)) {
        if (info.headRefOid?.toLowerCase() !== row.head) {
          dbHandle.query(`UPDATE fleet_pr_loop SET state='stale-head',updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state IN ('merge-pending','merge-timeout','merge-needs-attention')`)
            .run(now(), row.repo, row.pr_number, row.head);
          fleetError("PR_LOOP_STALE", `task=${task.key} signal=${signal}`,
            `expected=${row.head} actual=${info.headRefOid ?? "unavailable"}`);
          continue;
        }
        if (info.state === "MERGED" && /^[a-f0-9]{40}$/i.test(info.mergeCommit?.oid || "")) {
          const mergeSha = info.mergeCommit.oid.toLowerCase();
          dbHandle.query(`UPDATE fleet_pr_loop SET state='merged',merge_sha=?,merge_pending_since=NULL,
            merge_ambiguous_since=NULL,merge_ambiguous_count=0,merge_retry_at=NULL,updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state IN ('merge-pending','merge-timeout','merge-needs-attention')`)
            .run(mergeSha, now(), row.repo, row.pr_number, row.head);
          events.push(`FLEET_PR_MERGED ${row.task_key} ${signal} head=${row.head} merge_sha=${mergeSha}`);
          row = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
            .get(repo, prNumber, row.head);
        } else if (info.state === "CLOSED") {
          dbHandle.query(`UPDATE fleet_pr_loop SET state='closed',merge_pending_since=NULL,
            merge_ambiguous_since=NULL,merge_ambiguous_count=0,merge_retry_at=NULL,updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state IN ('merge-pending','merge-timeout','merge-needs-attention')`)
            .run(now(), row.repo, row.pr_number, row.head);
          events.push(`FLEET_PR_CLOSED ${row.task_key} ${signal} head=${row.head}`);
          continue;
        } else if (info.state === "OPEN" && row.state === "merge-pending") {
          const pendingSince = Date.parse(row.merge_pending_since ?? row.updated_at ?? "");
          const ambiguousCount = Number(row.merge_ambiguous_count ?? 0);
          const ambiguousSince = Date.parse(row.merge_ambiguous_since ?? row.merge_pending_since ?? "");
          if (ambiguousCount > 0 && Number.isFinite(ambiguousSince)
            && Date.now() - ambiguousSince >= PR_LOOP_MERGE_AMBIGUOUS_TIMEOUT_MS) {
            const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state='merge-needs-attention',
              merge_retry_at=NULL,updated_at=?
              WHERE repo=? AND pr_number=? AND head=? AND state='merge-pending'`)
              .run(now(), repo, prNumber, row.head).changes;
            if (changed) events.push(`FLEET_PR_MERGE_NEEDS_ATTENTION ${row.task_key} ${signal} head=${row.head} reason=ambiguous_timeout`);
            continue;
          }
          const ambiguousRetryAt = Date.parse(row.merge_retry_at ?? "");
          if (ambiguousCount > 0 && Number.isFinite(ambiguousRetryAt) && Date.now() >= ambiguousRetryAt) {
            const currentCycleVerdict = repliesAvailable ? matchPrLoopVerdict(replies, {
              repo: row.repo,
              prNumber: row.pr_number,
              head: row.head,
              threadTs: config.reviewThreadTs,
              afterTs: row.request_ts,
            }) : null;
            if (currentCycleVerdict?.kind === "accept") {
              const changed = dbHandle.query(`UPDATE fleet_pr_loop SET state='accepted',merge_retry_at=NULL,updated_at=?
                WHERE repo=? AND pr_number=? AND head=? AND state='merge-pending' AND merge_retry_at=?`)
                .run(now(), repo, prNumber, row.head, row.merge_retry_at).changes;
              if (!changed) continue;
              row = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
                .get(repo, prNumber, row.head);
            } else {
              const delay = Math.min(PR_LOOP_MERGE_RETRY_BASE_MS * (2 ** Math.max(0, ambiguousCount - 1)),
                PR_LOOP_MERGE_RETRY_MAX_MS);
              const nextRetryAt = new Date(Date.now() + delay).toISOString();
              dbHandle.query(`UPDATE fleet_pr_loop SET merge_retry_at=?,updated_at=?
                WHERE repo=? AND pr_number=? AND head=? AND state='merge-pending' AND merge_retry_at=?`)
                .run(nextRetryAt, now(), repo, prNumber, row.head, row.merge_retry_at);
              continue;
            }
          }
          const timeoutMs = Number(config.mergePendingTimeoutMs) > 0 ? Number(config.mergePendingTimeoutMs) : 1_800_000;
          if (ambiguousCount === 0 && Number.isFinite(pendingSince) && Date.now() - pendingSince >= timeoutMs) {
            dbHandle.query(`UPDATE fleet_pr_loop SET state='merge-timeout',updated_at=?
              WHERE repo=? AND pr_number=? AND head=? AND state='merge-pending'`)
              .run(now(), row.repo, prNumber, row.head);
            events.push(`FLEET_PR_MERGE_TIMEOUT ${row.task_key} ${signal} head=${row.head} timeout_ms=${timeoutMs}`);
          }
        }
        if (row.state === "merge-pending" || row.state === "merge-timeout") continue;
      }
      if (row.state === "awaiting-review") {
        let info = await prLoopPullRequestInfo(signal, runCommand);
        if (!info) continue;
        if (info.headRefOid?.toLowerCase() !== row.head) {
          dbHandle.query(`UPDATE fleet_pr_loop SET state='stale-head',updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state='awaiting-review'`)
            .run(now(), row.repo, row.pr_number, row.head);
          fleetError("PR_LOOP_STALE", `task=${task.key} signal=${signal}`,
            `expected=${row.head} actual=${info?.headRefOid ?? "unavailable"}`);
          continue;
        }
        if (info.state === "CLOSED") {
          dbHandle.query(`UPDATE fleet_pr_loop SET state='closed',updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state='awaiting-review'`)
            .run(now(), row.repo, row.pr_number, row.head);
          events.push(`FLEET_PR_CLOSED ${row.task_key} ${signal} head=${row.head}`);
          continue;
        }
        if (!["OPEN", "MERGED"].includes(info.state)) continue;
        if (info.state === "OPEN" && info.isDraft) continue;
        const verdict = matchPrLoopVerdict(replies, {
          repo: row.repo,
          prNumber: row.pr_number,
          head: row.head,
          threadTs: config.reviewThreadTs,
          afterTs: row.request_ts,
        });
        if (!verdict) continue;
        let rejectLeaseToken = null;
        let claimed;
        if (verdict.kind === "reject") {
          rejectLeaseToken = claimPrLoopRejection(dbHandle, row, verdict);
          claimed = Boolean(rejectLeaseToken);
        } else {
          claimed = dbHandle.transaction(() => {
            const changed = dbHandle.query(`UPDATE fleet_pr_loop
              SET state='accepted',verdict=?,verdict_ts=?,updated_at=?
              WHERE repo=? AND pr_number=? AND head=? AND state='awaiting-review'`)
              .run(verdict.text, verdict.ts, now(), row.repo, row.pr_number, row.head).changes === 1;
            if (!changed) return false;
            recordTaskClaimEvidenceInTransaction(dbHandle, row.task_key, {
              kind: "cursor-accept", signal, ok: true, head: row.head,
              acceptedPrefix: row.head, actualHead: row.head, detail: "accepted_exact_pr_head",
            });
            return true;
          }).immediate();
        }
        if (claimed && verdict.kind === "reject") {
          try {
            await sendPrLoopFollowup(dbHandle, row, verdict, runCommand, readPane, io.sendFollowup, rejectLeaseToken);
            events.push(`FLEET_PR_REJECT_FOLLOWUP ${row.task_key} ${signal} head=${row.head}`);
          } catch (error) {
            recordPrLoopRejectFailure(dbHandle, row, rejectLeaseToken, error, events, signal);
          }
        } else if (claimed) {
          events.push(`FLEET_PR_ACCEPTED ${row.task_key} ${signal} head=${row.head}${config.autoMerge ? "" : " auto_merge=disabled"}`);
        }
      }
      row = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
        .get(repo, prNumber, row.head);
      if (row?.state === "accepted") {
        const currentCycleVerdict = repliesAvailable ? matchPrLoopVerdict(replies, {
          repo: row.repo,
          prNumber: row.pr_number,
          head: row.head,
          threadTs: config.reviewThreadTs,
          afterTs: row.request_ts,
        }) : null;
        const info = await prLoopPullRequestInfo(signal, runCommand);
        if (!info) continue;
        if (info?.state === "MERGED" && info.headRefOid?.toLowerCase() === row.head
          && /^[a-f0-9]{40}$/i.test(info.mergeCommit?.oid || "")) {
          const mergeSha = info.mergeCommit.oid.toLowerCase();
          dbHandle.query(`UPDATE fleet_pr_loop SET state='merged',merge_sha=?,updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state='accepted'`)
            .run(mergeSha, now(), repo, prNumber, row.head);
          events.push(`FLEET_PR_MERGED ${row.task_key} ${signal} head=${row.head} merge_sha=${mergeSha}`);
        } else if (info?.state === "CLOSED" && info.headRefOid?.toLowerCase() === row.head) {
          dbHandle.query(`UPDATE fleet_pr_loop SET state='closed',updated_at=?
            WHERE repo=? AND pr_number=? AND head=? AND state='accepted'`)
            .run(now(), repo, prNumber, row.head);
          events.push(`FLEET_PR_CLOSED ${row.task_key} ${signal} head=${row.head}`);
        } else if (config.autoMerge && !info.isDraft && currentCycleVerdict?.kind === "accept") {
          const merge = await mergeAcceptedPrLoopHead(dbHandle, row, config, runCommand);
          if (merge) events.push(merge);
        }
      }
      const finalRow = dbHandle.query("SELECT * FROM fleet_pr_loop WHERE repo=? AND pr_number=? AND head=?")
        .get(repo, prNumber, row.head);
      if (finalRow?.state === "merged") deployMergedPrLoopRow(dbHandle, finalRow, config, io, events, runCommand);
    }
  }
  for (const row of dbHandle.query("SELECT * FROM fleet_pr_loop WHERE state IN ('merged','deploying')").all()) {
    deployMergedPrLoopRow(dbHandle, row, config, io, events, runCommand);
  }
  return events;
}

export function claimEvent(catId, key, claim) {
  return `FLEET_CLAIM_${claim.ok ? "OK" : "FALSE"} ${catId} ${key} ${claim.kind} ${claim.detail}`;
}

function queueDispatch(catId, key, prompt, options, reason) {
  const { type = "impl", skill = "ulw", done = "", title = "", keepModel = false, after } = options;
  db.query(`INSERT INTO tasks(key,cat,title,prompt,skill,done,status,sent_at,depends_on,dispatch_type,keep_model)
    VALUES(?,?,?,?,?,?,'waiting',?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET cat=excluded.cat, title=excluded.title, prompt=excluded.prompt, skill=excluded.skill, done=excluded.done, status='waiting', sent_at=excluded.sent_at, result=NULL, evidence=NULL, depends_on=excluded.depends_on, dispatch_type=excluded.dispatch_type, keep_model=excluded.keep_model, completion_claimed=0, send_attempted=0, dispatch_attempt=NULL, claim_evidence='{}'`)
    .run(key, catId, title || key, prompt, skill, done, now(), after || null, type, keepModel ? 1 : 0);
  log(key, { ev: after ? "dependency-wait" : "dispatch-wait", after: after || null, reason });
  return after ? `FLEET_DEPENDENCY_WAIT ${key} after=${after} ${reason}` : `FLEET_DISPATCH_WAIT ${key} cat=${catId} ${reason}`;
}

// Verified send (Dori panes.ts idea): only into an idle agent prompt, one send, then confirm the agent actually started.
export async function dispatch(catId, key, prompt, { type = "impl", skill = "ulw", done = "", title = "", keepModel = false, after = "", runCommand = executeSignalCommand, sleep = Bun.sleep, switchPaneModel } = {}) {
  if (typeof key !== "string" || !key.trim()) throw new Error("INVALID_TASK_KEY");
  const c = db.query("SELECT * FROM cats WHERE id=?").get(catId);
  if (!c) throw new Error(`cat ${catId} has no pane`);
  c.pane = configuredCatPane(catId, c.pane);
  if (c.pane === "-") throw new Error(`cat ${catId} has no pane`);
  const applyPaneModel = switchPaneModel ?? ((pane, want) => switchModel(pane, want, runCommand));
  const paneRead = async () => runCommand(["herdr", "pane", "read", c.pane, "--source", "visible", "--format", "text"]);
  let existing = db.query("SELECT cat,status FROM tasks WHERE key=?").get(key);
  if (existing?.status === "dispatching") {
    const screen = await paneRead();
    await recoverInterruptedDispatches(db, [{ id: catId, state: screen.exitCode === 0 ? classify(screen.stdout).state : "unknown" }]);
    existing = db.query("SELECT cat,status FROM tasks WHERE key=?").get(key);
  }
  const retainedReservation = db.query("SELECT pane FROM dispatch_reservations WHERE key=?").get(key);
  if (retainedReservation && existing?.cat === catId && existing.status === "waiting") {
    const detail = "queued retry found a retained pane reservation";
    db.query("UPDATE tasks SET status='dispatch-error',result=? WHERE key=? AND status='waiting'").run(detail, key);
    log(key, { ev: "dispatch-error", detail });
    existing.status = "dispatch-error";
  }
  if (retainedReservation && existing?.cat === catId && existing.status === "dispatch-error")
    return `DISPATCH_HOLD ${catId} reservation-retained; not queued`;
  if (existing && (existing.cat !== catId || !["waiting", "dispatch-interrupted", "dispatch-error", "dispatch-held", "dispatch-failed-before-send"].includes(existing.status))) return `DISPATCH_HOLD ${catId} duplicate-key; not sent`;
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
    if (existing && (existing.cat !== catId || !["waiting", "dispatch-interrupted", "dispatch-error", "dispatch-held", "dispatch-failed-before-send"].includes(existing.status))) return { hold: "duplicate-key" };
    if (db.query(`SELECT r.key FROM dispatch_reservations r JOIN tasks t ON t.key=r.key
      WHERE r.pane=? OR t.cat=? LIMIT 1`).get(c.pane, catId)) return { hold: "pane-reserved" };
    const active = db.query(`SELECT t.key FROM tasks t JOIN cats c ON c.id=t.cat
      WHERE (c.pane=? OR t.cat=?) AND t.key!=? AND t.status NOT IN ('waiting','verified-done','blocked','closed','prompt-lost','send-failed-unconfirmed','dispatch-interrupted','dispatch-error','dispatch-held','dispatch-failed-before-send') LIMIT 1`).get(c.pane, catId, key);
    if (active) return { hold: "prior-task-unresolved" };
    const attempt = crypto.randomUUID();
    const model = want ? `${want.provider}/${want.model}:${want.thinking}` : "kept";
    if (existing) {
      db.query(`UPDATE tasks SET title=?,prompt=?,skill=?,model=?,done=?,status='dispatching',sent_at=?,started_at=NULL,ended_at=NULL,result=NULL,evidence=NULL,
        depends_on=?,dispatch_type=?,keep_model=?,completion_claimed=0,send_attempted=0,dispatch_attempt=?,claim_evidence='{}' WHERE key=?`)
        .run(title || key, prompt, skill, model, done, now(), after || null, type, keepModel ? 1 : 0, attempt, key);
    } else {
      db.query(`INSERT INTO tasks(key,cat,title,prompt,skill,model,done,status,sent_at,depends_on,dispatch_type,keep_model,dispatch_attempt,history)
        VALUES(?,?,?,?,?,?,?,'dispatching',?,?,?,?,?,?)`)
        .run(key, catId, title || key, prompt, skill, model, done, now(), after || null, type, keepModel ? 1 : 0, attempt, "[]");
    }
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at,recovery_token,recovery_started_at) VALUES(?,?,?, ?,NULL,NULL)").run(c.pane, key, attempt, now());
    db.query("UPDATE cats SET task=? WHERE id=?").run(key, catId);
    return { attempt, model };
  }).immediate();
  if (claim.hold) return `DISPATCH_HOLD ${catId} ${claim.hold}; not sent`;
  const { attempt, model } = claim;
  let sendAttempted = false;
  let enterAttempted = false;
  const releaseUnsent = (status) => db.transaction(() => {
    if (!db.query("SELECT 1 FROM dispatch_reservations WHERE pane=? AND key=? AND attempt=? AND recovery_token IS NULL").get(c.pane, key, attempt)) return false;
    db.query("UPDATE tasks SET status=? WHERE key=?").run(status, key);
    db.query("DELETE FROM dispatch_reservations WHERE pane=? AND attempt=? AND recovery_token IS NULL").run(c.pane, attempt);
    return true;
  }).immediate();
  const ownsReservation = () => Boolean(db.query("SELECT 1 FROM dispatch_reservations WHERE pane=? AND key=? AND attempt=? AND recovery_token IS NULL").get(c.pane, key, attempt));
  let leaseHeartbeat;
  try {
    leaseHeartbeat = setInterval(() => {
      try {
        db.query("UPDATE dispatch_reservations SET reserved_at=? WHERE pane=? AND key=? AND attempt=? AND recovery_token IS NULL")
          .run(now(), c.pane, key, attempt);
      } catch (error) {
        fleetError("DISPATCH_LEASE_HEARTBEAT", `task=${key} attempt=${attempt}`, error);
      }
    }, 30_000);
    leaseHeartbeat.unref?.();
    const modelNote = keepModel ? "MODEL_KEPT" : await applyPaneModel(c.pane, want);
    if (modelNote.startsWith("MODEL_SWITCH_FAILED") || modelNote.startsWith("MODEL_SWITCH_TIMEOUT") || modelNote.startsWith("MODEL_SWITCH_DIRTY")) {
      if (modelNote.startsWith("MODEL_SWITCH_DIRTY")) {
        db.query("UPDATE tasks SET status='dispatch-error',result=? WHERE key=? AND status='dispatching'").run(modelNote, key);
        log(key, { ev: "dispatch-error", attempt, detail: modelNote });
        return `DISPATCH_ERROR ${catId} ${key}: model switch input cleanup unverified; reservation retained`;
      }
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
    const msg = `${head}: 지시문 파일 ${prompt} 전체를 읽고 그대로 수행해. 끝나면 마지막 줄에 ${key}_DONE attempt=${attempt} <한 줄 요약> 또는 ${key}_BLOCKED attempt=${attempt} reason=<한 줄>.`;
    if (!recordDispatchSendAttempt(db, c.pane, key, attempt)) return `DISPATCH_HOLD ${catId} reservation-reclaimed; not sent`;
    sendAttempted = true;
    const text = await runCommand(["herdr", "pane", "send-text", c.pane, msg]);
    if (text.exitCode !== 0) throw new Error("SEND_TEXT_FAILED");
    await sleep(700);
    enterAttempted = true;
    const enter = await runCommand(["herdr", "pane", "send-keys", c.pane, "Enter"]);
    if (enter.exitCode !== 0) throw new Error("SEND_ENTER_FAILED");
    db.query("UPDATE tasks SET status='sent-unconfirmed',model=? WHERE key=?").run(model, key);
    log(key, { ev: "sent-unconfirmed", attempt });
    for (let i = 0; i < 12; i++) {
      const screen = await paneRead();
      const state = screen.exitCode === 0 ? classify(screen.stdout).state : "unknown";
      if (state === "working") {
        const observedAt = now();
        db.query("UPDATE tasks SET status='working',started_at=? WHERE key=? AND dispatch_attempt=?")
          .run(observedAt, key, attempt);
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
  } catch (error) {
    fleetError("DISPATCH", `task=${key} attempt=${attempt}`, error);
    if (sendAttempted) {
      if (enterAttempted) {
        for (let i = 0; i < 12; i++) {
          const screen = await paneRead();
          const state = screen.exitCode === 0 && screen.stdout.trim() ? classify(screen.stdout).state : "unknown";
          if (state === "working") {
            const observedAt = now();
            db.query("UPDATE tasks SET status='working',started_at=? WHERE key=? AND dispatch_attempt=?")
              .run(observedAt, key, attempt);
            log(key, { ev: "started-after-enter-error", attempt });
            return `DISPATCH_OK ${catId} ${key} started after Enter error`;
          }
          if (state === "compaction-failed") {
            markTaskPromptLost(key, attempt);
            return `DISPATCH_PROMPT_LOST ${catId} ${key}: compaction failed after Enter error`;
          }
          if (i < 11) await sleep(5000);
        }
      }
      const released = await reconcileFailedDispatch(db, { pane: c.pane, key, attempt }, paneRead, runCommand).catch((error) => {
        fleetError("DISPATCH_RECONCILE", `task=${key} attempt=${attempt}`, error);
        return false;
      });
      if (!released) {
        db.query("UPDATE tasks SET status='send-failed-unconfirmed' WHERE key=?").run(key);
        log(key, { ev: "send-failed-unconfirmed", attempt });
      }
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
        try { logOn(dbHandle, task.key, { ev: status, detail }); } catch (error) {
          fleetError("DISPATCH_HISTORY", `task=${task.key}`, error);
        }
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
async function executeSignalCommand(argv, signal = AbortSignal.timeout(10000)) {
  const proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe", signal });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export async function checkSignal(sig, runCommand = executeSignalCommand) {
  sig = sig.trim();
  let m;
  if ((m = sig.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/))) {
    const command = await runCommand(["gh", "pr", "view", m[2], "--repo", m[1], "--json", "state,mergeCommit,headRefOid"]);
    let j = {};
    // Malformed GitHub JSON intentionally falls back to {} and fails the MERGED check below.
    try { j = JSON.parse(command.stdout || "{}"); } catch (error) {
      fleetError("PR_SIGNAL_JSON", `signal=${sig}`, error);
    }
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
  if (t.status === "closed") return `VERIFY_CLOSED ${key}: task is terminal`;
  const history = JSON.parse(t.history || "[]");
  const hasCompletionClaim = Boolean(t.completion_claimed) || t.status === "done-claimed";
  if (t.status !== "done-claimed" && !(t.status === "not-done" && hasCompletionClaim)) return `VERIFY_UNCONFIRMED ${key}: worker completion claim missing`;
  if (!t.done) return `VERIFY_NO_SIGNAL ${key}: no Done= spec; cannot be verified-done`;
  const res = [];
  for (const s of t.done.split(";").map((part) => part.trim()).filter(Boolean)) res.push({ s, ...(await check(s)) });
  const durableClaims = JSON.parse(t.claim_evidence || "{}");
  const prSignals = res.filter((result) => parsePullRequestSignal(result.s));
  const requiredClaims = prSignals.map((result) => {
    const headRefOid = /^[a-f0-9]{40}$/i.test(result.headRefOid || "") ? result.headRefOid.toLowerCase() : null;
    const signalClaims = [
      ...history.filter((event) => (event.ev === "claim-ok" || event.ev === "claim-false")
        && (event.signal === result.s || (!event.signal && (prSignals.length === 1 || result.s === prSignals[0].s)))),
      ...Object.entries(durableClaims[result.s] ?? (result.s === prSignals[0].s ? durableClaims._legacy ?? durableClaims : {}))
        .filter(([claim]) => ["cursor-accept", "pr-ready"].includes(claim))
        .map(([claim, event]) => ({ ...event, claim, ev: event.ok ? "claim-ok" : "claim-false" })),
    ];
    const cursorAccept = headRefOid && signalClaims.findLast((event) => event.ev === "claim-ok"
      && event.claim === "cursor-accept"
      && event.head?.toLowerCase() === headRefOid
      && event.actualHead?.toLowerCase() === headRefOid);
    const prReady = headRefOid && signalClaims.findLast((event) => event.ev === "claim-ok"
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
  const terminal = db.transaction(() => {
    const current = db.query("SELECT status FROM tasks WHERE key=?").get(key);
    if (["closed", "verified-done"].includes(current?.status)) return current.status;
    db.query("UPDATE tasks SET status=?, evidence=?, ended_at=? WHERE key=?").run(ok ? "verified-done" : "not-done", evidence, ok ? now() : null, key);
    if (ok) db.query("DELETE FROM dispatch_reservations WHERE key=?").run(key);
    appendHistoryInTransaction(db, key, { ev: ok ? "verified" : "not-done", detail: evidence });
    return null;
  }).immediate();
  if (terminal === "closed") return `VERIFY_CLOSED ${key}: task is terminal`;
  if (terminal === "verified-done") return `VERIFIED_DONE ${key}: already verified`;
  return `${ok ? "VERIFIED_DONE" : "NOT_DONE"} ${key}: ${evidence}`;
}

let retryNotDoneCursor = null;

export async function retryNotDoneTasks(dbHandle = db, verifyTask = verify) {
  const tasks = dbHandle.query("SELECT key,done FROM tasks WHERE status='not-done' AND completion_claimed=1 ORDER BY key").all();
  if (!tasks.length) {
    retryNotDoneCursor = null;
    return [];
  }
  const start = retryNotDoneCursor === null ? 0 : Math.max(0, tasks.findIndex((task) => task.key > retryNotDoneCursor));
  const batch = Array.from({ length: Math.min(3, tasks.length) }, (_, index) => tasks[(start + index) % tasks.length]);
  retryNotDoneCursor = batch.at(-1).key;
  return Promise.all(batch.map(async (task) => {
    try {
      const signals = task.done.split(";").map((signal) => signal.trim()).filter(Boolean);
      if (!signals.length || !signals.every((signal) => /^pr:[\w.-]+\/[\w.-]+#\d+$/.test(signal))) return null;
      return await verifyTask(task.key);
    } catch (error) {
      return `VERIFY_RETRY_ERROR ${task.key} ${String(error?.message ?? error).slice(0, 160)}`;
    }
  })).then((events) => events.filter(Boolean));
}

export async function track(key, cat, done, title) {
  return db.transaction(() => {
    if (db.query("SELECT key FROM tasks WHERE key=?").get(key)) return `TRACK_HOLD ${key}: duplicate-key`;
    const c = db.query("SELECT * FROM cats WHERE id=?").get(cat);
    if (!c) throw new Error("NO_CAT");
    if (db.query("SELECT key FROM dispatch_reservations WHERE pane=?").get(c.pane)
      || db.query(`SELECT key FROM tasks WHERE cat=? AND status NOT IN ('verified-done','blocked','closed','prompt-lost','send-failed-unconfirmed','dispatch-interrupted','dispatch-error','dispatch-held','dispatch-failed-before-send') LIMIT 1`).get(cat)) {
      return `TRACK_HOLD ${key}: prior-task-unresolved`;
    }
    db.query("INSERT INTO tasks(key,cat,title,done,status,sent_at) VALUES(?,?,?,?,'tracked-unconfirmed',?)").run(key, cat, title || key, done || "", now());
    appendHistoryInTransaction(db, key, { ev: "tracked" });
    db.query("UPDATE tasks SET sent_at=? WHERE key=?").run(now(), key);
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
  } catch (error) {
    fleetError("COMMAND", `${command} ${args[0] ?? ""}`, error);
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
  try { return JSON.parse(text); } catch (error) {
    fleetError("PR_INFO_JSON", `repo=${repo} number=${number}`, error);
    return null;
  }
}

async function pullRequestsForBranch(repo, branch, repoRoot) {
  const fields = "number,title,url,state,isDraft";
  const text = await commandOutput("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", fields], repoRoot);
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : null;
  } catch (error) {
    fleetError("PR_LIST_JSON", `repo=${repo} branch=${branch}`, error);
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
    WHERE status IN ('sent','sent-unconfirmed','send-failed-unconfirmed','tracked-unconfirmed','working','done-claimed','not-done') AND done IS NOT NULL AND done!=''
    ORDER BY sent_at DESC LIMIT 20`).all();
  for (const task of tasks) {
    try {
      for (const signal of task.done.split(";").map((part) => part.trim())) {
        if (parsePullRequestSignal(signal) && !signals.has(signal)) signals.set(signal, task.key);
      }
    } catch (error) {
      fleetError("BOARD_TASK", `task=${task.key}`, error);
    }
  }

  const pullRequests = [];
  for (const [signal, source] of signals) {
    try {
      const target = parsePullRequestSignal(signal);
      const info = await pullRequestInfo(target.repo, target.prNumber, repoRoot);
      const checkRuns = info?.headRefOid ? await checkRunsForHead(target.repo, info.headRefOid) : null;
      pullRequests.push({ target, source, info, checkRuns });
    } catch (error) {
      fleetError("BOARD_PR", `signal=${signal}`, error);
    }
  }
  const bySignal = new Map(pullRequests.map((pr) => [`pr:${pr.target.repo}#${pr.target.prNumber}`, pr]));
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
      ? `- #${target.prNumber} ${info.state || "UNKNOWN"}${info.isDraft ? " draft" : ""} ${String(info.title || "").replace(/\s+/g, " ").trim()} head=${info.headRefOid?.slice(0, 7) || "UNKNOWN"}`
      : `- #${target.prNumber} UNKNOWN (GitHub data unavailable)`)
    : ["- UNKNOWN (no PR references or GitHub data unavailable)"];
  const reviewLines = pullRequests.length
    ? pullRequests.map(({ target, info, checkRuns }) => {
      const decision = info?.reviewDecision || "UNKNOWN";
      const wait = decision === "REVIEW_REQUIRED" ? "WAITING" : decision === "APPROVED" ? "NO" : "UNKNOWN";
      return `- #${target.prNumber} wait=${wait} decision=${decision} Cursor Bugbot=${bugbotState(checkRuns)}`;
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

function markTaskObservedWorking(dbHandle, key) {
  const task = dbHandle.query("SELECT status,started_at,sent_at,history,dispatch_attempt,send_attempted FROM tasks WHERE key=?").get(key);
  if (!task || !["dispatching", "sent-unconfirmed", "send-failed-unconfirmed", "tracked-unconfirmed", "working"].includes(task.status)) return false;
  const sent = task.dispatch_attempt && task.send_attempted
    ? JSON.parse(task.history || "[]").findLast((event) => event.ev === "send-attempted" && event.attempt === task.dispatch_attempt)
    : null;
  const sendAt = Date.parse(sent?.at ?? "");
  const sentAt = Date.parse(task.sent_at ?? "");
  const refreshSentAt = Boolean(task.dispatch_attempt && task.send_attempted
    && (!task.started_at || (Number.isFinite(sendAt) && (!Number.isFinite(sentAt) || sentAt < sendAt))));
  const newlyWorking = task.status !== "working" || !task.started_at;
  if (!newlyWorking && !refreshSentAt) return false;
  const observedAt = now();
  dbHandle.transaction(() => {
    dbHandle.query(`UPDATE tasks SET status='working',started_at=COALESCE(started_at,?),
      sent_at=CASE WHEN ? THEN ? ELSE sent_at END WHERE key=?`)
      .run(observedAt, refreshSentAt ? 1 : 0, sent?.at ?? observedAt, key);
    if (newlyWorking && task.dispatch_attempt && task.send_attempted)
      appendHistoryInTransaction(dbHandle, key, { ev: "started", attempt: task.dispatch_attempt, source: "watch-observed", at: observedAt });
  }).immediate();
  return newlyWorking;
}

// Watch: emits only transitions. Gajae: surface recovery_hold / speech suppressed with reason.
async function watch(intervalSec = 30) {
  const last = new Map();
  const completionRejectionsReported = new Set();
  const usageAlerted = new Map();
  const bugbotAlerted = new Map();
  // journalctl --since takes local time; keep the cursor in epoch seconds to avoid TZ drift.
  let jcursor = Math.floor(Date.now() / 1000) - 60;
  for (;;) {
    try {
      const rows = await refresh();
      for (const event of await recoverInterruptedDispatches(db, rows)) console.log(event);
      for (const r of rows) {
        try {
        const completionCandidates = r.doneCandidates ?? (r.done ? [r.done] : []);
        const completionChecks = completionCandidates.map((marker) => {
          const task = db.query(`SELECT key,cat,status,sent_at,history,dispatch_attempt,send_attempted,completion_claimed
            FROM tasks WHERE key=?`).get(marker.key);
          return { marker, task, reason: completionRejectionReason(r.id, r.task, marker, task) };
        });
        const currentChecks = completionChecks.filter(({ marker, reason }) => marker.key === r.task
          && !["filtered", "stale-attempt", "other-task", "already-claimed"].includes(reason));
        const latestCurrentCheck = currentChecks.at(-1);
        let rejectionIdentity = null;
        let rejectionEvent = null;
        if (r.id !== "omonyang" && ["attempt-missing", "attempt-mismatch", "not-sent"].includes(latestCurrentCheck?.reason)) {
          const { marker, reason } = latestCurrentCheck;
          rejectionIdentity = `${r.id}:${marker.attempt ?? `missing:${marker.key}:${marker.kind}`}`;
          if (!completionRejectionsReported.has(rejectionIdentity)) {
            rejectionEvent = `FLEET_COMPLETION_REJECTED ${r.id} ${marker.key} reason=${reason}`;
          }
        }
        const holdUntrackedTask = ["attempt-missing", "attempt-mismatch"].includes(latestCurrentCheck?.reason)
          && latestCurrentCheck.task?.status === "tracked-unconfirmed"
          && !latestCurrentCheck.task.dispatch_attempt && !latestCurrentCheck.task.send_attempted;
        const currentCompletion = latestCurrentCheck?.reason === null ? latestCurrentCheck : null;
        const doneMarker = currentCompletion?.marker ?? null;
        const doneTask = currentCompletion?.task ?? null;
        const sig = JSON.stringify({
          task: r.task,
          state: r.state,
          doneKey: doneMarker?.key ?? "",
          doneKind: doneMarker?.kind ?? "",
          doneAttempt: doneMarker?.attempt ?? "",
          doneText: doneMarker?.text ?? "",
          completionCandidates: completionCandidates.map(({ key, kind, attempt, text, filtered }) => ({ key, kind, attempt, text, filtered })),
          readyLine: r.readyLine ?? "",
          readyHead: r.ready?.head ?? "",
          claimText: r.claimText ?? "",
          questionText: r.questionText ?? "",
        });
        const previous = last.has(r.id) ? JSON.parse(last.get(r.id)) : null;
        if (!previous || last.get(r.id) !== sig) {
          if (previous && r.state !== previous.state && r.id !== "omonyang") console.log(`FLEET_STATE ${r.id} ${previous.state} -> ${r.state}`);
          if (r.task && r.state === "working" && !holdUntrackedTask && markTaskObservedWorking(db, r.task)) console.log(`FLEET_TASK_STARTED ${r.id} ${r.task}`);
          const doneChanged = r.id !== "omonyang" && doneMarker
            && (!previous || previous.task !== r.task || doneMarker.key !== previous.doneKey || doneMarker.kind !== previous.doneKind || doneMarker.attempt !== previous.doneAttempt)
            && doneTask?.cat === r.id;
          const readyChanged = r.ready && (!previous || r.ready.head !== previous.readyHead);
          const readyLineChanged = r.readyLine && (!previous || r.readyLine !== previous.readyLine);
          const claimTextChanged = r.claimText && (!previous || r.claimText !== previous.claimText);
          if (doneChanged) {
            const recorded = db.transaction(() => {
              const currentTask = db.query("SELECT cat,status,completion_claimed,dispatch_attempt,send_attempted FROM tasks WHERE key=?").get(doneMarker.key);
              if (!currentTask || currentTask.cat !== r.id || currentTask.dispatch_attempt !== doneMarker.attempt
                || !currentTask.send_attempted || ["verified-done", "closed", "done-claimed"].includes(currentTask.status)
                || currentTask.completion_claimed) return false;
              if (doneMarker.kind === "BLOCKED") {
                const changed = db.query(`UPDATE tasks SET status='blocked',result=? WHERE key=? AND cat=?
                  AND dispatch_attempt=? AND send_attempted=1 AND completion_claimed=0 AND status NOT IN ('verified-done','closed')`)
                  .run(doneMarker.text, doneMarker.key, r.id, doneMarker.attempt).changes;
                if (!changed) return false;
                db.query("DELETE FROM dispatch_reservations WHERE key=?").run(doneMarker.key);
                appendHistoryInTransaction(db, doneMarker.key, { ev: "blocked", attempt: doneMarker.attempt, text: doneMarker.text });
                return true;
              }
              const changed = db.query(`UPDATE tasks SET status='done-claimed',result=?,completion_claimed=1 WHERE key=? AND cat=?
                AND dispatch_attempt=? AND send_attempted=1 AND status NOT IN ('verified-done','closed','done-claimed') AND completion_claimed=0`)
                .run(doneMarker.text, doneMarker.key, r.id, doneMarker.attempt).changes;
              if (!changed) return false;
              appendHistoryInTransaction(db, doneMarker.key, { ev: "done-claimed", attempt: doneMarker.attempt, text: doneMarker.text });
              return true;
            }).immediate();
            if (recorded) console.log(`FLEET_TASK_${doneMarker.kind} ${r.id} ${doneMarker.key} ${doneMarker.text}`);
          }
          if (doneChanged || readyChanged || readyLineChanged || claimTextChanged) {
            const taskKey = doneMarker?.key ?? r.task;
            const task = taskKey ? db.query("SELECT * FROM tasks WHERE key=?").get(taskKey) : null;
            const claims = await verifyClaims(r.claimText ?? "", task);
            for (const claim of claims) {
              console.log(claimEvent(r.id, taskKey ?? "-", claim));
              if (taskKey) recordTaskClaimEvidence(db, taskKey, claim);
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
            try {
              answered = await answerPaneQuestion(r.pane, r.questionText, policy.answer);
            } catch (error) {
              fleetError("AUTO_ANSWER", `cat=${r.id} task=${taskKey} policy=${policy.id}`, error);
            }
            if (answered) {
              console.log(`FLEET_AUTO_ANSWER ${r.id} ${taskKey} policy=${policy.id}`);
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
        if (rejectionEvent) {
          completionRejectionsReported.add(rejectionIdentity);
          console.log(rejectionEvent);
        }
        if (r.task) {
          const t = db.query("SELECT status,sent_at FROM tasks WHERE key=?").get(r.task);
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
      for (const event of await processPrLoopEvents(db, CONFIG.prLoop)) console.log(event);
      for (const event of await retryNotDoneTasks(db)) console.log(event);
      for (const event of await pollReviewStalls(db, Date.now())) console.log(event);
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
    close: () => markTaskClosed(a[0], a.slice(1).join(" ")),
    verify: () => verify(a[0]),
    tasks: async () => db.query("SELECT key,cat,status,depends_on,skill,model,done,evidence FROM tasks ORDER BY sent_at DESC LIMIT 20").all().map((t) => JSON.stringify(t)).join("\n"),
    beat: async () => JSON.stringify(db.query("SELECT * FROM beats").all()),
    routes: async () => JSON.stringify(ROUTES, null, 1),
    watch: () => watch(Number(a[0] || 30)),
  }[cmd] ?? (async () => "usage: fleet init|status|report|board|dispatch <cat> <KEY> <prompt> [--after <KEY>] [--type plan|impl|review|secure|quick] [--skill ulw|ulw-loop|mass-ulw|ulw-plan|ulw-execute|ulw-research] [--done 'pr:o/r#N;url:..=200;cmd:..'] [--keep-model]|track <KEY> <cat> --done ..|close <KEY> <reason>|verify <KEY>|tasks|beat|routes|watch [sec]"))();
  if (out !== undefined) console.log(out);
}
