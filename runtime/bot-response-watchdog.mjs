#!/usr/bin/env bun
// Read-only observation for omonyang, dinobot, dori, gajaegun.
// PR1 does not call a model, write native DBs, restart, or post to Slack.

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const BOTS = ["omonyang", "dinobot", "dori", "gajaegun"];
export const FRESH_MS = 120_000;
export const OUTPUT_FIELDS = [
  "bot", "identity", "source", "observedAt", "generation", "sessionId",
  "receiverPresent", "provider", "providerError", "providerErrorGeneration",
  "dbReadable", "processEvidence", "replyLink", "autostart", "externalWatch",
  "recoveryInvoked", "modelInvoked", "slackWrite", "stalePidRejected",
  "collectedFields", "uncollectedFields", "state", "reason", "readError",
  "attribution", "processAlive", "processAbsent", "healthCheckedAt",
];
export const READ_ERROR_KINDS = new Set([
  "missing", "missing_adapter", "missing_db", "permission_denied", "query_failed",
  "readonly_query_failed", "systemctl_failed", "inspect_failed", "unreadable", "unsupported",
]);

const STATES = new Set([
  "response_confirmed", "idle_or_working", "awaiting_human", "intentional_silence",
  "planned_stop", "auth_required", "fault", "unconfirmed", "maintenance",
]);

export function parseTime(value) {
  if (value == null || value === "") return { ok: false, reason: "missing" };
  if (typeof value === "number" && Number.isFinite(value)) return { ok: true, ms: value };
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return { ok: false, reason: "unparseable" };
  return { ok: true, ms };
}

export function requireNow(value) {
  const parsed = parseTime(value);
  if (!parsed.ok) return { ok: false, reason: "invalid_now" };
  return parsed;
}

export function ageClass(observedAt, nowMs, bounds = {}) {
  if (!Number.isFinite(nowMs)) return "unconfirmed";
  if (bounds == null || typeof bounds !== "object" || Array.isArray(bounds)) return "unconfirmed";
  const parsed = parseTime(observedAt);
  if (!parsed.ok) return "unconfirmed";
  const started = parseTime(bounds.collectionStartedAt);
  const finished = parseTime(bounds.collectionFinishedAt ?? nowMs);
  if (!started.ok || !finished.ok) return "unconfirmed";
  if (started.ms > finished.ms) return "unconfirmed";
  if (parsed.ms < started.ms || parsed.ms > finished.ms || parsed.ms > nowMs) return "unconfirmed";
  if (nowMs - parsed.ms > FRESH_MS) return "unconfirmed";
  return "fresh";
}

export function healthCheckedAt(value, collectedAtMs) {
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "bad_health_time" };
  const ms = value * 1000;
  if (!Number.isFinite(collectedAtMs) || ms > collectedAtMs || collectedAtMs - ms > FRESH_MS) {
    return { ok: false, reason: "stale_or_future_health", ms };
  }
  return { ok: true, ms };
}
export function acceptHealthRecord(value, collectedAtMs) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!record || !("runtime_pid" in record) || !("session_id" in record) || !("checked_at" in record)) {
    return { ok: false, reason: "bad_health_shape" };
  }
  const checked = healthCheckedAt(record.checked_at, collectedAtMs);
  if (!checked.ok) return checked;
  return {
    ok: true,
    pid: Number.isInteger(Number(record.runtime_pid)) ? Number(record.runtime_pid) : null,
    sessionId: typeof record.session_id === "string" ? record.session_id : null,
    checkedAtMs: checked.ms,
  };
}

function safeReadError(value) {
  return READ_ERROR_KINDS.has(value) ? value : "unreadable";
}

export function attribution(snapshot) {
  const sessionId = typeof snapshot.sessionId === "string" && snapshot.sessionId.length > 0 ? snapshot.sessionId : null;
  const generation = snapshot.generation ?? null;
  if (!sessionId || !generation) return { bound: false, reason: "missing_session_or_generation" };
  if (snapshot.pidSessionId && snapshot.pidSessionId !== sessionId) return { bound: false, reason: "foreign_pid_session" };
  if (snapshot.ownerSessionId && snapshot.ownerSessionId !== sessionId) return { bound: false, reason: "foreign_owner_session" };
  if (snapshot.sessionMatchesProcess !== true) return { bound: false, reason: "process_not_attributed" };
  if (snapshot.pid != null && snapshot.pidAlive == null) return { bound: false, reason: "missing_pid_alive" };
  if (snapshot.pid != null && snapshot.pidAlive === false && snapshot.sessionMatchesProcess === true) return { bound: false, reason: "dead_pid", processAbsent: true };
  if (snapshot.processAlive !== true) return { bound: false, reason: "process_absent", processAbsent: true };
  return { bound: true, reason: "attributed" };
}

function publicRow(bot, extra = {}) {
  const row = {};
  for (const key of OUTPUT_FIELDS) {
    if (bot[key] !== undefined) row[key] = bot[key];
  }
  return { ...row, ...extra };
}

export function classify(bot) {
  const base = publicRow(bot, {
    identity: bot.identity ?? bot.sessionId ?? null,
    source: typeof bot.source === "string" ? bot.source : null,
    observedAt: bot.observedAt ?? null,
    generation: bot.generation ?? null,
    sessionId: bot.sessionId ?? null,
    receiverPresent: bot.receiverPresent ?? null,
    provider: bot.provider ?? null,
    providerError: bot.providerError ?? null,
    providerErrorGeneration: bot.providerErrorGeneration ?? null,
    dbReadable: bot.dbReadable ?? null,
    processEvidence: bot.processEvidence ?? null,
    replyLink: "unsupported",
    autostart: bot.autostart ?? "unconfirmed",
    externalWatch: "unsupported",
    recoveryInvoked: false,
    modelInvoked: false,
    slackWrite: false,
    stalePidRejected: bot.stalePidRejected === true,
    collectedFields: Array.isArray(bot.collectedFields) ? bot.collectedFields.filter((item) => typeof item === "string") : [],
    uncollectedFields: Array.isArray(bot.uncollectedFields) ? bot.uncollectedFields.filter((item) => typeof item === "string") : [],
    healthCheckedAt: typeof bot.healthCheckedAt === "number" ? bot.healthCheckedAt : null,
  });
  if (!Number.isFinite(bot.nowMs)) {
    return { ...base, state: "unconfirmed", reason: "invalid_now" };
  }
  if (bot.readError) {
    return { ...base, state: "unconfirmed", reason: "read_failed", readError: safeReadError(bot.readError) };
  }
  if (ageClass(bot.observedAt, bot.nowMs, bot) !== "fresh") {
    return { ...base, state: "unconfirmed", reason: "stale_or_bad_clock" };
  }
  if (bot.maintenance === true) return { ...base, state: "maintenance", reason: "intentional_stop" };
  if (bot.plannedStop === true) return { ...base, state: "planned_stop", reason: "planned_stop" };
  if (bot.intentionalSilence === true) return { ...base, state: "intentional_silence", reason: "policy_silence" };
  if (bot.awaitingHuman === true) return { ...base, state: "awaiting_human", reason: "awaiting_human" };
  if (currentAuthError(bot)) {
    return { ...base, state: "auth_required", reason: "current_provider_auth" };
  }
  if (bot.processAbsent === true) return { ...base, state: "fault", reason: "process_absent" };
  if (bot.receiverPresent === false && bot.processAlive === true && bot.processEvidence === "bound") {
    return { ...base, state: "fault", reason: "receiver_absent" };
  }
  if (bot.working === true && bot.processEvidence === "bound") {
    return { ...base, state: "idle_or_working", reason: "working" };
  }
  if (bot.processAlive === true && bot.processEvidence === "bound") {
    return { ...base, state: "idle_or_working", reason: "process_alive_not_response" };
  }
  return { ...base, state: "unconfirmed", reason: "insufficient" };
}

function currentAuthError(bot) {
  if (!isAuthError(bot.providerError)) return false;
  if (!bot.provider || !bot.providerErrorProvider) return false;
  if (bot.provider !== bot.providerErrorProvider) return false;
  if (!bot.generation || !bot.providerErrorGeneration) return false;
  return bot.providerErrorGeneration === bot.generation;
}

function isAuthError(code) {
  return code === "invalid_grant" || code === "invalid_state" || code === "auth_expired";
}

export function synthesize(observations, nowMs) {
  const byBot = new Map();
  for (const item of observations) {
    if (!BOTS.includes(item.bot)) continue;
    if (byBot.has(item.bot)) continue;
    byBot.set(item.bot, { ...item, nowMs });
  }
  return BOTS.map((bot) => {
    const found = byBot.get(bot);
    if (!found) return classify({ bot, nowMs, readError: "missing_adapter" });
    const row = classify(found);
    if (!STATES.has(row.state)) throw new Error(`bad state ${row.state}`);
    return row;
  });
}

export function redact(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (typeof item === "string" && /xox[baprs]-|sk-ant-|refresh_token|Bearer /i.test(item)) return "[redacted]";
    if (/token|authorization|cookie|password|secret|api_key/i.test(String(key))) return "[redacted]";
    return item;
  }));
}

export function openReadonly(path) {
  try {
    if (!existsSync(path)) return { ok: false, reason: "missing_db" };
    const db = new Database(path, { readonly: true, create: false });
    db.query("SELECT 1").get();
    return { ok: true, db };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

function readErrorRow(bot, snapshot) {
  return {
    bot,
    identity: `${bot}:unconfirmed`,
    readError: safeReadError(snapshot?.readError ?? "missing"),
    source: typeof snapshot?.source === "string" ? snapshot.source : null,
    observedAt: snapshot?.observedAt ?? null,
  };
}

export function readGajaegun(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.readError) {
    return readErrorRow("gajaegun", snapshot);
  }
  const normalized = readGeneric("gajaegun", snapshot);
  return {
    ...normalized,
    dbReadable: snapshot.dbReadable ?? null,
    boundConversationSession: snapshot.boundConversationSession ?? null,
    runtimeProcessIdentity: snapshot.runtimeProcessIdentity ?? null,
    sessionId: snapshot.sessionId ?? null,
    identity: snapshot.sessionId ?? snapshot.boundConversationSession ?? null,
    attribution: normalized.attribution,
    stalePidRejected: normalized.stalePidRejected,
  };
}

export function readGeneric(bot, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.readError) {
    return readErrorRow(bot, snapshot);
  }
  const { bot: ignoredBot, processEvidence: ignoredEvidence, ...rest } = snapshot;
  const attributed = attribution(rest);
  return {
    ...rest,
    bot,
    source: typeof rest.source === "string" ? rest.source : null,
    sessionId: rest.sessionId ?? null,
    boundConversationSession: rest.boundConversationSession ?? null,
    runtimeProcessIdentity: rest.runtimeProcessIdentity ?? null,
    processAlive: attributed.bound,
    processAbsent: attributed.processAbsent === true,
    stalePidRejected: rest.pidAlive === true && Boolean(rest.pidSessionId) && rest.pidSessionId !== rest.sessionId,
    processEvidence: attributed.bound ? "bound" : "unconfirmed",
    attribution: attributed.reason,
    providerErrorGeneration: rest.providerErrorGeneration ?? null,
  };
}

export function collect(input) {
  const now = requireNow(input.now);
  const observations = [
    readGeneric("omonyang", input.omonyang),
    readGeneric("dinobot", input.dinobot),
    readGeneric("dori", input.dori),
    readGajaegun(input.gajaegun ?? { readError: "missing" }),
  ];
  return {
    schema: "bot-response-watchdog.pr1",
    now: now.ok ? new Date(now.ms).toISOString() : null,
    nowError: now.ok ? null : now.reason,
    externalWatch: "unsupported",
    replyLink: "unsupported",
    bots: redact(synthesize(observations, now.ms)),
  };
}

export function forbiddenCallSites(sourceText) {
  return sourceText.split("\n").filter((line) => /spawnSync\(/.test(line) && !line.includes("\"show\"") && !line.includes("\"inspect\""));
}

function systemctlShow(unit) {
  const result = spawnSync("systemctl", ["--user", "show", unit, "-p", "ActiveState", "-p", "MainPID", "-p", "Type", "-p", "NRestarts", "--no-pager"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}` },
  });
  if (result.status !== 0) return { readError: "systemctl_failed", source: unit, observedAt: new Date().toISOString() };
  const fields = Object.fromEntries(result.stdout.split("\n").filter(Boolean).map((line) => line.split("=")));
  const active = fields.ActiveState === "active" && fields.MainPID !== "0";
  return {
    source: unit,
    observedAt: new Date().toISOString(),
    pid: active ? Number(fields.MainPID) : null,
    pidAlive: active,
    receiverPresent: null,
    autostart: "unconfirmed",
    generation: null,
    sessionId: null,
    sessionMatchesProcess: false,
    collectedFields: ["ActiveState", "MainPID", "Type"],
    uncollectedFields: ["provider", "replyLink", "generation", "processAttribution", "sessionId"],
  };
}

function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

function readOmonyang() {
  const healthPath = "/home/jm/.omo/omonyang/recovery-health.json";
  const collectedAt = new Date().toISOString();
  const health = readJsonFile(healthPath);
  if (!health.ok) return { readError: health.reason, source: healthPath, observedAt: collectedAt };
  const accepted = acceptHealthRecord(health.value, Date.parse(collectedAt));
  if (!accepted.ok) return { readError: "unreadable", source: healthPath, observedAt: collectedAt, healthCheckedAt: accepted.reason === "stale_or_future_health" ? null : null };
  return {
    source: "recovery-health.json",
    observedAt: collectedAt,
    sessionId: accepted.sessionId,
    identity: accepted.sessionId,
    generation: null,
    pid: accepted.pid,
    pidAlive: null,
    sessionMatchesProcess: false,
    processAlive: false,
    healthCheckedAt: accepted.checkedAtMs,
    healthFresh: true,
    collectedFields: ["session_id", "runtime_pid", "checked_at"],
    uncollectedFields: ["provider", "receiver", "replyLink", "processStartTime", "generation", "processAttribution"],
  };
}

function readDori() {
  const cli = "/home/jm/.dori/dori-runtime-cli.ts";
  const observedAt = new Date().toISOString();
  if (!existsSync(cli)) return { readError: "missing", source: cli, observedAt };
  const result = spawnSync("bun", [cli, "inspect"], { encoding: "utf8", timeout: 8000 });
  if (result.status !== 0) return { readError: "inspect_failed", source: cli, observedAt };
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return { readError: "unreadable", source: cli, observedAt }; }
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
  const ownerSessionId = parsed.nativeOwner?.sessionId ?? null;
  const processes = Array.isArray(parsed.processes) ? parsed.processes : [];
  const identity = parsed.nativeOwner?.processIdentity ?? null;
  const matched = processes.find((item) => item.processIdentity === identity);
  const sessionMatchesProcess = false;
  return {
    source: "dori-runtime-cli.ts inspect",
    observedAt,
    sessionId,
    ownerSessionId,
    identity: sessionId,
    pid: matched?.pid ?? null,
    pidAlive: matched == null ? null : parsed.nativeOwner?.alive === true,
    pidSessionId: null,
    processAlive: false,
    sessionMatchesProcess,
    generation: null,
    runtimeProcessIdentity: null,
    collectedFields: ["sessionId", "nativeOwner.sessionId", "processes.processIdentity"],
    uncollectedFields: ["provider", "replyLink", "generation", "processStartTime", "processAttribution"],
  };
}

export function liveOnce() {
  const started = new Date().toISOString();
  const adapters = [
    ["gajaegun", readGajaegunLive],
    ["omonyang", readOmonyang],
    ["dinobot", () => ({ ...systemctlShow("dinobot.service"), receiverPresent: null, autostart: "systemd" })],
    ["dori", readDori],
  ];
  const input = { now: null };
  for (const [bot, read] of adapters) {
    try {
      input[bot] = read();
    } catch {
      input[bot] = { readError: "unreadable", source: bot, observedAt: new Date().toISOString() };
    }
  }
  const finished = new Date().toISOString();
  input.now = finished;
  for (const bot of BOTS) {
    input[bot] = { ...input[bot], collectionStartedAt: started, collectionFinishedAt: finished };
  }
  return collect(input);
}

function readGajaegunLive() {
  const observedAt = new Date().toISOString();
  let gateway = { readError: "systemctl_failed" };
  let adapter = { readError: "systemctl_failed" };
  let dbReadable = false;
  try { gateway = systemctlShow("gajaeway-gateway.service"); } catch { gateway = { readError: "systemctl_failed" }; }
  try { adapter = systemctlShow("gajaeway-adapter-slack.service"); } catch { adapter = { readError: "systemctl_failed" }; }
  try {
    const db = openReadonly("/home/jm/.gajaegun/gajaeway/gateway.db");
    if (db.ok) {
      try { db.db.query("SELECT 1").get(); dbReadable = true; } catch { dbReadable = false; }
      finally { db.db.close(); }
    }
  } catch {
    dbReadable = false;
  }
  return {
    source: "gajaeway-gateway.service+adapter+db-ro",
    observedAt,
    dbReadable,
    pid: gateway.pid ?? null,
    pidAlive: gateway.pidAlive === true,
    runtimeProcessIdentity: null,
    sessionId: null,
    boundConversationSession: null,
    generation: null,
    sessionMatchesProcess: false,
    processAlive: false,
    receiverPresent: adapter.pidAlive === true ? true : null,
    provider: null,
    collectedFields: ["gateway.ActiveState", "adapter.ActiveState", "db.readable"],
    uncollectedFields: ["boundConversationSession", "provider", "replyLink", "generation", "processAttribution"],
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--out") || args.includes("--fixture")) {
    console.error("stdout only; --out and file writes are refused");
    process.exit(2);
  }
  if (args.includes("--self-test")) {
    const text = readFileSync(new URL(import.meta.url).pathname, "utf8");
    const hits = forbiddenCallSites(text);
    if (hits.length) {
      console.error(JSON.stringify({ forbidden: hits }));
      process.exit(2);
    }
    process.exit(0);
  }
  if (!args.includes("--once")) {
    console.error("refusing to loop or write a timer; pass --once");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(liveOnce(), null, 2)}\n`);
}

if (import.meta.main) main();
