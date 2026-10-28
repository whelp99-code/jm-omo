#!/usr/bin/env bun
// Read-only observation for omonyang, dinobot, dori, gajaegun.
// PR1 does not call a model, write native DBs, restart, or post to Slack.

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const BOTS = ["omonyang", "dinobot", "dori", "gajaegun"];
export const FRESH_MS = 120_000;
export const SECRET_KEYS = [
  "token", "access_token", "refresh_token", "authorization", "cookie", "password", "secret", "api_key",
];

const STATES = new Set([
  "response_confirmed", "idle_or_working", "awaiting_human", "intentional_silence",
  "planned_stop", "auth_required", "fault", "unconfirmed", "maintenance",
]);

export function parseTime(value) {
  if (value == null || value === "") return { ok: false, reason: "missing" };
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return { ok: false, reason: "unparseable" };
  return { ok: true, ms };
}

export function ageClass(observedAt, nowMs) {
  const parsed = parseTime(observedAt);
  if (!parsed.ok) return "unconfirmed";
  if (parsed.ms > nowMs) return "unconfirmed";
  if (nowMs - parsed.ms > FRESH_MS) return "unconfirmed";
  return "fresh";
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
    replyLink: "unsupported",
    autostart: bot.autostart ?? "unconfirmed",
    externalWatch: "unsupported",
    recoveryInvoked: false,
    modelInvoked: false,
    slackWrite: false,
    stalePidRejected: bot.stalePidRejected === true,
  };
  if (bot.readError) {
    return { ...base, state: "unconfirmed", reason: "read_failed", readError: bot.readError };
  }
  if (ageClass(bot.observedAt, bot.nowMs) !== "fresh") {
    return { ...base, state: "unconfirmed", reason: "stale_or_bad_clock" };
  }
  if (bot.maintenance === true) return { ...base, state: "maintenance", reason: "intentional_stop" };
  if (bot.plannedStop === true) return { ...base, state: "planned_stop", reason: "planned_stop" };
  if (bot.intentionalSilence === true) return { ...base, state: "intentional_silence", reason: "policy_silence" };
  if (bot.awaitingHuman === true) return { ...base, state: "awaiting_human", reason: "awaiting_human" };
  if (bot.providerError && bot.providerErrorGeneration === bot.generation && isAuthError(bot.providerError)) {
    return { ...base, state: "auth_required", reason: "current_provider_auth" };
  }
  if (bot.processAlive === false) return { ...base, state: "fault", reason: "process_absent" };
  if (bot.receiverPresent === false && bot.processAlive === true) {
    return { ...base, state: "fault", reason: "receiver_absent" };
  }
  if (bot.working === true || bot.processAlive === true) {
    return { ...base, state: "idle_or_working", reason: bot.working ? "working" : "process_alive_not_response" };
  }
  return { ...base, state: "unconfirmed", reason: "insufficient" };
}

function isAuthError(code) {
  return code === "invalid_grant" || code === "invalid_state" || code === "auth_expired";
}

export function synthesize(observations, nowMs) {
  const byBot = new Map(observations.map((item) => [item.bot, { ...item, nowMs }]));
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
    if (SECRET_KEYS.includes(String(key).toLowerCase())) return "[redacted]";
    if (typeof item === "string" && /xox[baprs]-|sk-ant-|refresh_token/i.test(item)) return "[redacted]";
    return item;
  }));
}

export function openReadonly(path) {
  if (!existsSync(path)) return { ok: false, reason: "missing_db" };
  const db = new Database(path, { readonly: true, create: false });
  return { ok: true, db };
}

export function readGajaegun(snapshot) {
  if (snapshot.readError) return { bot: "gajaegun", readError: snapshot.readError, source: snapshot.source ?? null, observedAt: snapshot.observedAt ?? null };
  const stalePidRejected = snapshot.pidAlive === true && Boolean(snapshot.pidSessionId) && snapshot.pidSessionId !== snapshot.sessionId;
  const pidOk = Boolean(snapshot.pid) && snapshot.pidAlive === true && snapshot.pidSessionId === snapshot.sessionId;
  return {
    bot: "gajaegun",
    identity: snapshot.sessionId ?? null,
    source: "gateway-readonly",
    observedAt: snapshot.observedAt,
    generation: snapshot.generation ?? snapshot.sessionId ?? null,
    sessionId: snapshot.sessionId ?? null,
    processAlive: pidOk ? true : snapshot.processAlive,
    receiverPresent: snapshot.receiverPresent,
    provider: snapshot.provider ?? null,
    providerError: snapshot.providerError ?? null,
    providerErrorGeneration: snapshot.providerErrorGeneration ?? snapshot.generation ?? null,
    working: snapshot.working === true,
    awaitingHuman: snapshot.awaitingHuman === true,
    intentionalSilence: snapshot.intentionalSilence === true,
    plannedStop: snapshot.plannedStop === true,
    maintenance: snapshot.maintenance === true,
    autostart: "systemd",
    stalePidRejected,
  };
}

export function readGeneric(bot, snapshot) {
  if (!snapshot || snapshot.readError) {
    return {
      bot,
      identity: `${bot}:unconfirmed`,
      readError: snapshot?.readError ?? "missing",
      source: snapshot?.source ?? null,
      observedAt: snapshot?.observedAt ?? null,
    };
  }
  return { bot, ...snapshot, processAlive: snapshot.pidAlive === false ? false : snapshot.processAlive };
}

export function collect(input) {
  const nowMs = Date.parse(input.now);
  const observations = [
    readGeneric("omonyang", input.omonyang),
    readGeneric("dinobot", input.dinobot),
    readGeneric("dori", input.dori),
    readGajaegun(input.gajaegun ?? { readError: "missing" }),
  ];
  return {
    schema: "bot-response-watchdog.pr1",
    now: input.now,
    externalWatch: "unsupported",
    replyLink: "unsupported",
    bots: redact(synthesize(observations, nowMs)),
  };
}

export function forbiddenCallSites(sourceText) {
  return sourceText.split("\n").filter((line) => {
    if (!/spawnSync\(/.test(line)) return false;
    return !line.includes("\"show\"");
  });
}

function systemctlShow(unit) {
  const result = spawnSync("systemctl", ["--user", "show", unit, "-p", "ActiveState", "-p", "MainPID", "-p", "NRestarts", "--no-pager"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}` },
  });
  if (result.status !== 0) return { readError: "systemctl_failed", source: unit };
  const fields = Object.fromEntries(result.stdout.split("\n").filter(Boolean).map((line) => line.split("=")));
  return {
    source: unit,
    observedAt: new Date().toISOString(),
    processAlive: fields.ActiveState === "active",
    pidAlive: fields.ActiveState === "active" && fields.MainPID !== "0",
    generation: fields.MainPID && fields.MainPID !== "0" ? fields.MainPID : null,
    autostart: "unconfirmed",
  };
}

export function liveOnce() {
  const gajaegun = { readError: "live_gateway_not_in_pr1_default" };
  try {
    const dbPath = "/home/jm/.gajaegun/gajaeway/gateway.db";
    const opened = openReadonly(dbPath);
    if (!opened.ok) {
      gajaegun.readError = opened.reason;
    } else {
      const row = opened.db.query("SELECT origin_key FROM sessions LIMIT 1").get();
      opened.db.close();
      gajaegun.readError = null;
      gajaegun.observedAt = new Date().toISOString();
      gajaegun.processAlive = true;
      gajaegun.sessionId = row ? "present" : null;
      gajaegun.source = "gateway.db?mode=ro";
      gajaegun.working = false;
    }
  } catch (error) {
    gajaegun.readError = "readonly_query_failed";
  }
  const doriInspect = "/home/jm/.dori/docs/runtime-recovery.md";
  return collect({
    now: new Date().toISOString(),
    omonyang: { ...systemctlShow("omonyang-herdr.service"), autostart: "existing-timer-unverified" },
    dinobot: { ...systemctlShow("dinobot.service"), receiverPresent: null, autostart: "systemd" },
    dori: existsSync(doriInspect)
      ? { source: "runtime-recovery.md", observedAt: null, readError: "inspect_not_run_in_pr1_once", autostart: "unconfirmed" }
      : { readError: "recovery_doc_missing", autostart: "unconfirmed" },
    gajaegun,
  });
}

function main() {
  const args = process.argv.slice(2);
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
    console.error("refusing to loop or write a timer; pass --once or a fixture path");
    process.exit(2);
  }
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : null;
  const fixture = args.find((arg) => arg.endsWith(".json") && arg !== out);
  const report = fixture ? collect(JSON.parse(readFileSync(fixture, "utf8"))) : liveOnce();
  const body = JSON.stringify(report, null, 2);
  if (!out || args.includes("--stdout")) process.stdout.write(`${body}\n`);
  else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${body}\n`);
  }
}

if (import.meta.main) main();
