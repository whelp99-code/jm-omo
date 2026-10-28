#!/usr/bin/env bun
// Read-only observation for omonyang, dinobot, dori, gajaegun.
// PR1 does not call a model, write native DBs, restart, or post to Slack.

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const BOTS = ["omonyang", "dinobot", "dori", "gajaegun"];
export const FRESH_MS = 120_000;
export const COLLECT_SKEW_MS = 2_000;
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

export function ageClass(observedAt, nowMs, skewMs = 0) {
  if (!Number.isFinite(nowMs)) return "unconfirmed";
  const parsed = parseTime(observedAt);
  if (!parsed.ok) return "unconfirmed";
  if (parsed.ms > nowMs + skewMs) return "unconfirmed";
  if (nowMs - parsed.ms > FRESH_MS) return "unconfirmed";
  return "fresh";
}

function safeReadError(value) {
  return READ_ERROR_KINDS.has(value) ? value : "unreadable";
}

export function classify(bot) {
  const base = {
    bot: bot.bot,
    identity: bot.identity ?? bot.sessionId ?? null,
    source: bot.source ?? null,
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
    collectedFields: bot.collectedFields ?? [],
    uncollectedFields: bot.uncollectedFields ?? [],
  };
  if (!Number.isFinite(bot.nowMs)) {
    return { ...base, state: "unconfirmed", reason: "invalid_now" };
  }
  if (bot.readError) {
    return { ...base, state: "unconfirmed", reason: "read_failed", readError: safeReadError(bot.readError) };
  }
  if (ageClass(bot.observedAt, bot.nowMs, bot.collectSkewMs ?? 0) !== "fresh") {
    return { ...base, state: "unconfirmed", reason: "stale_or_bad_clock" };
  }
  if (bot.maintenance === true) return { ...base, state: "maintenance", reason: "intentional_stop" };
  if (bot.plannedStop === true) return { ...base, state: "planned_stop", reason: "planned_stop" };
  if (bot.intentionalSilence === true) return { ...base, state: "intentional_silence", reason: "policy_silence" };
  if (bot.awaitingHuman === true) return { ...base, state: "awaiting_human", reason: "awaiting_human" };
  if (currentAuthError(bot)) {
    return { ...base, state: "auth_required", reason: "current_provider_auth" };
  }
  if (bot.processAlive === false && bot.processEvidence === "bound") {
    return { ...base, state: "fault", reason: "process_absent" };
  }
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
  if (!existsSync(path)) return { ok: false, reason: "missing_db" };
  const db = new Database(path, { readonly: true, create: false });
  return { ok: true, db };
}

export function readGajaegun(snapshot) {
  if (snapshot.readError) {
    return { bot: "gajaegun", readError: safeReadError(snapshot.readError), source: snapshot.source ?? null, observedAt: snapshot.observedAt ?? null };
  }
  const stalePidRejected = snapshot.pidAlive === true && Boolean(snapshot.pidSessionId) && snapshot.pidSessionId !== snapshot.sessionId;
  const bound = Boolean(snapshot.pid) && snapshot.pidAlive === true && snapshot.pidSessionId === snapshot.sessionId && Boolean(snapshot.sessionId);
  return {
    bot: "gajaegun",
    identity: snapshot.sessionId ?? null,
    source: snapshot.source ?? "gateway-readonly",
    observedAt: snapshot.observedAt,
    generation: bound ? snapshot.generation ?? String(snapshot.pid) : null,
    sessionId: snapshot.sessionId ?? null,
    processAlive: bound ? true : (snapshot.processEvidence === "bound" ? snapshot.processAlive : null),
    processEvidence: bound ? "bound" : "unconfirmed",
    receiverPresent: snapshot.receiverPresent ?? null,
    dbReadable: snapshot.dbReadable ?? null,
    provider: snapshot.provider ?? null,
    providerError: snapshot.providerError ?? null,
    providerErrorProvider: snapshot.providerErrorProvider ?? null,
    providerErrorGeneration: snapshot.providerErrorGeneration ?? null,
    working: snapshot.working === true,
    awaitingHuman: snapshot.awaitingHuman === true,
    intentionalSilence: snapshot.intentionalSilence === true,
    plannedStop: snapshot.plannedStop === true,
    maintenance: snapshot.maintenance === true,
    autostart: snapshot.autostart ?? "systemd",
    stalePidRejected,
    collectedFields: snapshot.collectedFields ?? [],
    uncollectedFields: snapshot.uncollectedFields ?? [],
    collectSkewMs: snapshot.collectSkewMs ?? 0,
  };
}

export function readGeneric(bot, snapshot) {
  if (!snapshot || snapshot.readError) {
    return {
      bot,
      identity: `${bot}:unconfirmed`,
      readError: safeReadError(snapshot?.readError ?? "missing"),
      source: snapshot?.source ?? null,
      observedAt: snapshot?.observedAt ?? null,
    };
  }
  const { bot: ignoredBot, ...rest } = snapshot;
  const bound = rest.processEvidence === "bound";
  const pidAlive = rest.pidAlive === true && Boolean(rest.pid);
  return {
    ...rest,
    bot,
    processAlive: bound ? rest.processAlive === true && (rest.pid == null || pidAlive) : null,
    processEvidence: bound && rest.processAlive === true ? "bound" : rest.processEvidence ?? "unconfirmed",
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
    unitType: fields.Type ?? null,
    processAlive: fields.Type === "simple" && active,
    processEvidence: fields.Type === "simple" && active ? "bound" : "unconfirmed",
    pid: active ? Number(fields.MainPID) : null,
    pidAlive: active,
    generation: active ? fields.MainPID : null,
    receiverPresent: null,
    autostart: "unconfirmed",
    collectedFields: ["ActiveState", "MainPID", "Type"],
    uncollectedFields: ["provider", "replyLink"],
  };
}

function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

function procAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return existsSync(`/proc/${pid}/cmdline`);
}

function readOmonyang() {
  const healthPath = "/home/jm/.omo/omonyang/recovery-health.json";
  const health = readJsonFile(healthPath);
  const observedAt = new Date().toISOString();
  if (!health.ok) return { readError: health.reason, source: healthPath, observedAt };
  const pid = Number(health.value.runtime_pid);
  const alive = procAlive(pid);
  return {
    source: "recovery-health.json",
    observedAt,
    sessionId: typeof health.value.session_id === "string" ? health.value.session_id : null,
    identity: typeof health.value.session_id === "string" ? health.value.session_id : null,
    generation: alive ? String(pid) : null,
    pid: alive ? pid : null,
    pidAlive: alive,
    processAlive: alive,
    processEvidence: alive ? "bound" : "unconfirmed",
    recoveryUnit: "not-runtime-evidence",
    autostart: "existing-timer-unverified",
    collectedFields: ["session_id", "runtime_pid", "proc"],
    uncollectedFields: ["provider", "receiver", "replyLink"],
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
  const processes = Array.isArray(parsed.processes) ? parsed.processes : [];
  const nativeAlive = parsed.nativeOwner?.alive === true;
  const bound = processes.length > 0 || nativeAlive;
  return {
    source: "dori-runtime-cli.ts inspect",
    observedAt,
    sessionId,
    identity: sessionId,
    processAlive: bound,
    processEvidence: bound ? "bound" : "unconfirmed",
    generation: parsed.nativeOwner?.processIdentity ?? null,
    provider: null,
    autostart: "unconfirmed",
    collectedFields: ["sessionId", "processes", "nativeOwner.alive"],
    uncollectedFields: ["provider", "replyLink"],
  };
}

export function liveOnce() {
  const started = Date.now();
  const gajaegun = readGajaegunLive();
  const omonyang = readOmonyang();
  const dinobot = { ...systemctlShow("dinobot.service"), receiverPresent: null, autostart: "systemd" };
  const dori = readDori();
  const finished = Date.now();
  return collect({
    now: new Date(finished).toISOString(),
    omonyang: { ...omonyang, collectSkewMs: COLLECT_SKEW_MS },
    dinobot: { ...dinobot, collectSkewMs: COLLECT_SKEW_MS },
    dori: { ...dori, collectSkewMs: COLLECT_SKEW_MS },
    gajaegun: { ...gajaegun, collectSkewMs: COLLECT_SKEW_MS, collectionStartedAt: new Date(started).toISOString() },
  });
}

function readGajaegunLive() {
  const observedAt = new Date().toISOString();
  const gateway = systemctlShow("gajaeway-gateway.service");
  const adapter = systemctlShow("gajaeway-adapter-slack.service");
  const db = openReadonly("/home/jm/.gajaegun/gajaeway/gateway.db");
  let dbReadable = false;
  if (db.ok) {
    try {
      db.db.query("SELECT 1").get();
      dbReadable = true;
    } catch {
      dbReadable = false;
    } finally {
      db.db.close();
    }
  }
  const bound = gateway.processEvidence === "bound";
  return {
    source: "gajaeway-gateway.service+adapter+db-ro",
    observedAt,
    dbReadable,
    processAlive: bound,
    processEvidence: bound ? "bound" : "unconfirmed",
    pid: gateway.pid,
    pidAlive: gateway.pidAlive,
    pidSessionId: bound ? `pid:${gateway.pid}` : null,
    sessionId: bound ? `pid:${gateway.pid}` : null,
    generation: gateway.generation,
    receiverPresent: adapter.processEvidence === "bound" ? true : null,
    provider: null,
    collectedFields: ["gateway.ActiveState", "adapter.ActiveState", "db.readable"],
    uncollectedFields: ["boundConversationSession", "provider", "replyLink"],
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
