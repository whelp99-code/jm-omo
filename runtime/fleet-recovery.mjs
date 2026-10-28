#!/usr/bin/env bun
// Limited recovery decisions for the existing watchdog. No live restart, timer, or Slack write.

import { markAttempt, openRecoveryStore, readAttempt, reserveScope } from "./fleet-recovery-store.mjs";
export function botKey(observation) {
  if (!observation?.role || !observation.owner || !observation.session || !observation.generation) return null;
  return JSON.stringify([observation.role, observation.owner, observation.session, observation.generation]);
}

const SAFE_PART = /^[A-Za-z0-9_.:|-]{1,160}$/;
export function sharedKey(observation) {
  if (observation?.sharedDependency !== true || !SAFE_PART.test(String(observation.cause ?? ""))) return null;
  return JSON.stringify(["shared", observation.cause]);
}
export async function settleEffect(effect, observation) {
  if (typeof effect !== "function") return { outcome: "not_dispatched", calls: 0, error: "adapter_absent" };
  try {
    const result = await effect(observation);
    return { outcome: "delivered", calls: 1, value: result ?? null };
  } catch (error) {
    return { outcome: "failure", calls: 1, error: error instanceof Error ? error.message : "effect_failed" };
  }
}
export { openRecoveryStore };
export const ROLES = ["dinobot", "gajaegun", "omonyang", "dori", "nahee", "seoyun", "cursor", "shared"];
export const COOLDOWN_MS = 600_000;
export const SUSPECT_MS = 300_000;
export const STATES = new Set([
  "UNKNOWN", "HEALTHY", "WORKING", "WAITING_HUMAN", "PLANNED_STOP", "POLICY_SILENT",
  "SUSPECT", "CONFIRMED_FAULT", "RECOVERY_REQUESTED", "VERIFYING", "RECOVERED", "ESCALATED",
]);

const REMOTE = {
  nahee: { owner: "nahee-app-operator", app: "A0C5YFPRG3E" },
  seoyun: { owner: "seoyun-remote-operator", app: "relay" },
  cursor: { owner: "cursor-operator", app: "A08SKDT6QUW" },
};

export function supportMatrix() {
  return ROLES.filter((role) => role !== "shared").map((role) => {
    if (REMOTE[role]) {
      return { role, support: "unsupported", owner: REMOTE[role].owner, reason: "remote_api_unverified" };
    }
    return { role, support: "decision_only", owner: "existing_native_owner", reason: "no_live_adapter" };
  });
}


export function incidentKey(observation) {
  const parts = [observation?.role, observation?.owner, observation?.session, observation?.generation, observation?.cause];
  if (!parts.every((part) => typeof part === "string" && SAFE_PART.test(part))) return null;
  return JSON.stringify(parts);
}

function validObservation(observation, nowMs) {
  if (!Number.isFinite(nowMs)) return false;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return false;
  if (!ROLES.includes(observation.role) || observation.role === "shared" || !incidentKey(observation)) return false;
  if (observation.ownerMismatch === true || observation.schemaError === true) return false;
  if (observation.pidReused === true || observation.partialAttribution === true) return false;
  const observed = Date.parse(observation.observedAt);
  const started = Date.parse(observation.collectionStartedAt);
  const finished = Date.parse(observation.collectionFinishedAt);
  if (![observed, started, finished].every(Number.isFinite)) return false;
  if (started > finished || finished > nowMs || observed < started || observed > finished || observed > nowMs) return false;
  if (nowMs - observed > 120_000) return false;
  return true;
}

export function classifyRole(observation, nowMs) {
  if (!validObservation(observation, nowMs)) return { state: "UNKNOWN", action: "none", reason: "invalid_observation" };
  if (REMOTE[observation.role] && observation.managementApi !== true) return { state: "UNKNOWN", action: "handoff", reason: "remote_unsupported" };
  if (observation.localPidAbsent === true && REMOTE[observation.role]) return { state: "UNKNOWN", action: "none", reason: "remote_pid_not_fault" };
  if (observation.peerSilent === true) return { state: "POLICY_SILENT", action: "none", reason: "policy_silent" };
  if (observation.waitingHuman === true || observation.draft === true) return { state: "WAITING_HUMAN", action: "none", reason: "human_wait" };
  if (observation.plannedStop === true) return { state: "PLANNED_STOP", action: "none", reason: "planned_stop" };
  if (observation.working === true || observation.toolRunning === true) return { state: "WORKING", action: "none", reason: "working" };
  if (observation.authExpired === true || observation.providerLimit === true) return { state: "ESCALATED", action: "notify", reason: "auth_or_limit" };
  if (observation.sharedDependency === true) return { state: "ESCALATED", action: "notify_parent", reason: "shared_dependency" };
  if (observation.processDead === true && observation.attributed === true && observation.supervisorRestart !== true) {
    return { state: "ESCALATED", action: "handoff", reason: "dead_without_supervisor" };
  }
  if (observation.processDead === true && observation.attributed === true && observation.supervisorRestart === true) {
    return { state: "CONFIRMED_FAULT", action: "delegate_to_supervisor", reason: "supervisor_owns_restart" };
  }
  if (observation.receiverDown === true && observation.officialReconnect === true) {
    return { state: "CONFIRMED_FAULT", action: "reconnect_once", reason: "official_reconnect" };
  }
  if (observation.receiverDown === true) return { state: "ESCALATED", action: "handoff", reason: "no_official_reconnect" };
  if (observation.replyUnlinked === true) return { state: "VERIFYING", action: "none", reason: "reply_not_linked" };
  const waitStarted = Date.parse(observation.waitStartedAt ?? "");
  if (observation.stage === "awaiting_reply" && Number.isFinite(waitStarted) && nowMs - waitStarted >= SUSPECT_MS && nowMs - Date.parse(observation.observedAt) <= 120_000) {
    return { state: "SUSPECT", action: "none", reason: "suspect_not_fault" };
  }
  return { state: "HEALTHY", action: "none", reason: "healthy" };
}

export function recovered(proof) {
  if (!proof || typeof proof !== "object") return false;
  if (proof.ack || proof.pong || proof.globalMax || proof.healthz || proof.exit0) return false;
  const same = (left, right) => typeof left === "string" && left.length > 0 && left === right;
  return same(proof.inputId, proof.actualInputId)
    && same(proof.session, proof.actualSession)
    && same(proof.generation, proof.actualGeneration)
    && same(proof.provider, proof.actualProvider)
    && same(proof.model, proof.actualModel)
    && same(proof.expectedAccountId, proof.actualAccountId)
    && same(proof.expectedThreadId, proof.actualThreadId)
    && same(proof.expectedReplyId, proof.actualReplyId)
    && proof.threadReread === true
    && proof.inference === true;
}

function parentKey(observation) {
  if (!observation) return null;
  if (observation.sharedDependency === true) {
    if (!SAFE_PART.test(String(observation.cause ?? ""))) return null;
    return JSON.stringify(["shared", "shared", "shared", "shared", observation.cause]);
  }
  return incidentKey(observation);
}

function commit(store, key, incident) {
  const next = { incidents: { ...store.incidents, [key]: incident }, locks: { ...store.locks } };
  if (store.commit) store.commit(JSON.stringify(next));
  store.incidents = next.incidents;
  store.locks = next.locks;
}

export async function evaluate(store, observation, nowMs, effects = {}) {
  const decision = classifyRole(observation, nowMs);
  const key = parentKey(observation);
  const counts = { restart: 0, reconnect: 0, probe: 0, resend: 0, notify: 0, daemon: 0, timer: 0 };
  if (!key || !STATES.has(decision.state)) return { state: "UNKNOWN", reason: "invalid_observation", effects: counts, incident: null };
  const existing = store.incidents?.[key];
  if (decision.action === "none" || decision.action === "handoff" && decision.state !== "ESCALATED") {
    return { state: decision.state, reason: decision.reason, effects: counts, incident: existing ?? null };
  }
  if (existing?.budgetUsed && decision.action !== "notify" && decision.action !== "notify_parent") {
    return { state: existing.uncertain ? "ESCALATED" : existing.state, reason: "budget_used", effects: counts, incident: existing };
  }
  if (existing?.notifications > 0 && (decision.action === "notify" || decision.action === "notify_parent")) {
    return { state: existing.state, reason: "notification_recorded", effects: counts, incident: existing };
  }
  if (existing && Number.isFinite(existing.lastAt) && nowMs - existing.lastAt < COOLDOWN_MS && decision.action !== "notify" && decision.action !== "notify_parent") {
    return { state: existing.state, reason: "cooldown", effects: counts, incident: existing };
  }
  const lock = incidentKey({ ...observation, cause: "lock" });
  if (!existing && Object.values(store.locks ?? {}).includes(key)) {
    return { state: "UNKNOWN", reason: "incident_locked", effects: counts, incident: null };
  }
  if (lock && store.locks?.[lock] && store.locks[lock] !== key) {
    return { state: "UNKNOWN", reason: "generation_or_lock_conflict", effects: counts, incident: existing ?? null };
  }
  const incident = existing ?? { key, state: decision.state, budgetUsed: false, notifications: 0, lastAt: nowMs, uncertain: false, effectError: null };
  incident.lastAt = nowMs;
  if (lock) store.locks[lock] = key;
  if (decision.action === "reconnect_once" || decision.action === "notify" || decision.action === "notify_parent") {
    if (existing?.attempts >= 1) {
      return { state: existing.state, reason: "attempt_reserved", effects: counts, incident: existing };
    }
    incident.attempts = 1;
    incident.budgetUsed = true;
    incident.uncertain = true;
    incident.state = "ESCALATED";
    incident.delivery = "unknown";
    commit(store, key, incident);
    const effect = decision.action === "reconnect_once" ? effects.reconnect : effects.notify;
    if (typeof effect !== "function") {
      incident.delivery = "not_dispatched";
      incident.effectError = "adapter_absent";
      incident.state = "ESCALATED";
      commit(store, key, incident);
      return { state: incident.state, reason: "adapter_absent", effects: counts, incident };
    }
    const settled = await settleEffect(effect, observation);
    incident.delivery = settled.outcome === "not_dispatched" ? "not_dispatched" : settled.outcome;
    incident.effectError = settled.outcome === "failure" ? settled.error : settled.outcome === "not_dispatched" ? "adapter_absent" : null;
    incident.uncertain = settled.outcome !== "delivered" || observation.resultUnknown === true;
    incident.state = decision.action === "reconnect_once" && settled.outcome === "delivered" && observation.resultUnknown !== true
      ? "RECOVERY_REQUESTED"
      : "ESCALATED";
    if (decision.action === "reconnect_once" && settled.calls === 1) counts.reconnect = 1;
    if (decision.action !== "reconnect_once" && settled.calls === 1) counts.notify = 1;
    commit(store, key, incident);
    return { state: incident.state, reason: incident.effectError ?? decision.reason, effects: counts, incident };
  }
  if (decision.action === "delegate_to_supervisor" || decision.action === "handoff") {
    incident.state = "ESCALATED";
    incident.reason = decision.reason;
    commit(store, key, incident);
  }
  return { state: incident.state, reason: decision.reason, effects: counts, incident };
}

function incidentRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.key !== "string" || !STATES.has(value.state) || !Number.isFinite(value.lastAt)) return null;
  if (value.attempts != null && (!Number.isInteger(value.attempts) || value.attempts < 0)) return null;
  return value;
}

function safeRecord(value, records = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return null;
    if (records && item != null && (typeof item !== "object" || !incidentRecord(item))) return null;
    out[key] = item;
  }
  return out;
}
export function loadStore(text) {
  if (!text) return { incidents: Object.create(null), locks: Object.create(null) };
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad store");
  const incidents = safeRecord(parsed.incidents, true);
  const locks = safeRecord(parsed.locks, false);
  if (!incidents || !locks) throw new Error("bad store");
  return { incidents, locks };
}

export function productionCallCount(sourceText) {
  return sourceText.split("\n").filter((line) => /\bspawnSync\(|\bsystemctl\b|\bslackWrite\b|\bsetInterval\(/.test(line)).length;
}
export async function evaluateDurable(db, observation, nowMs, effects = {}) {
  const decision = classifyRole(observation, nowMs);
  const key = parentKey(observation);
  const bot = botKey(observation);
  const shared = sharedKey(observation);
  if (!key || !bot || !db) return { state: "UNKNOWN", reason: "invalid_observation", reserved: false, calls: 0 };
  if (decision.action !== "reconnect_once" && decision.action !== "notify" && decision.action !== "notify_parent") {
    return { state: decision.state, reason: decision.reason, reserved: false, calls: 0 };
  }
  if (!reserveScope(db, key, shared ? null : bot, shared, nowMs)) {
    return { state: "ESCALATED", reason: "attempt_reserved", reserved: false, calls: 0 };
  }
  const effect = decision.action === "reconnect_once" ? effects.reconnect : effects.notify;
  const settled = await settleEffect(effect, observation);
  const state = decision.action === "reconnect_once" && settled.outcome === "delivered" ? "RECOVERY_REQUESTED" : "ESCALATED";
  markAttempt(db, key, settled.outcome === "delivered" ? state : settled.outcome);
  return {
    state: settled.outcome === "not_dispatched" ? "ESCALATED" : state,
    reason: settled.error ?? settled.outcome,
    reserved: true,
    calls: settled.calls,
    attempts: readAttempt(db, key)?.attempts ?? 0,
  };
}
