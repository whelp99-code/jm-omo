#!/usr/bin/env bun
// Limited recovery decisions for the existing watchdog. No live restart, timer, or Slack write.

export const ROLES = ["dinobot", "gajaegun", "omonyang", "dori", "nahee", "seoyun", "cursor"];
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

export function supportMatrix(adapters = {}) {
  return ROLES.map((role) => {
    if (REMOTE[role]) {
      const api = adapters[role]?.managementApi === true;
      return { role, support: api ? "supported" : "unsupported", owner: REMOTE[role].owner, reason: api ? "verified_remote_api" : "no_verified_remote_api" };
    }
    return { role, support: "supported", owner: "existing_native_owner", reason: "existing_supervisor_path" };
  });
}

export function incidentKey(observation) {
  return [observation.role, observation.owner, observation.session, observation.generation, observation.cause].join("|");
}

function validObservation(observation, nowMs) {
  if (!observation || typeof observation !== "object") return false;
  if (!ROLES.includes(observation.role)) return false;
  if (!observation.owner || !observation.session || !observation.generation) return false;
  if (observation.ownerMismatch === true || observation.schemaError === true) return false;
  if (observation.pidReused === true || observation.partialAttribution === true) return false;
  const observed = Date.parse(observation.observedAt);
  const started = Date.parse(observation.collectionStartedAt);
  const finished = Date.parse(observation.collectionFinishedAt);
  if (![observed, started, finished].every(Number.isFinite)) return false;
  if (observed < started || observed > finished || observed > nowMs || nowMs - observed > 120_000) return false;
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
  if (observation.processDead === true && observation.attributed === true && observation.supervisorRestart) {
    return { state: "CONFIRMED_FAULT", action: "delegate_to_supervisor", reason: "supervisor_owns_restart" };
  }
  if (observation.receiverDown === true && observation.officialReconnect === true) {
    return { state: "CONFIRMED_FAULT", action: "reconnect_once", reason: "official_reconnect" };
  }
  if (observation.receiverDown === true) return { state: "ESCALATED", action: "handoff", reason: "no_official_reconnect" };
  if (observation.replyUnlinked === true) return { state: "VERIFYING", action: "none", reason: "reply_not_linked" };
  if (nowMs - Date.parse(observation.observedAt) >= SUSPECT_MS && observation.stage === "awaiting_reply") {
    return { state: "SUSPECT", action: "none", reason: "suspect_not_fault" };
  }
  return { state: "HEALTHY", action: "none", reason: "healthy" };
}

export function recovered(proof) {
  if (!proof || proof.ack || proof.pong || proof.globalMax || proof.healthz || proof.exit0) return false;
  return Boolean(
    proof.inputId && proof.sameInput && proof.sameSession && proof.sameGeneration
    && proof.inference && proof.replyId && proof.threadReread && proof.expectedAccount,
  );
}

function parentKey(observation) {
  if (!observation) return "invalid";
  return observation.sharedDependency ? `parent|${observation.cause}` : incidentKey(observation);
}

export function evaluate(store, observation, nowMs, effects = {}) {
  const decision = classifyRole(observation, nowMs);
  const key = parentKey(observation);
  const bot = observation?.role ?? "unknown";
  const existing = store.incidents[key];
  const counts = { restart: 0, reconnect: 0, probe: 0, resend: 0, notify: 0, daemon: 0, timer: 0 };
  if (!STATES.has(decision.state)) throw new Error("bad state");
  if (decision.state === "UNKNOWN" || ["none"].includes(decision.action) && decision.state !== "CONFIRMED_FAULT") {
    return { state: decision.state, reason: decision.reason, effects: counts, incident: existing ?? null };
  }
  if (existing?.budgetUsed && decision.action !== "notify" && decision.action !== "notify_parent") {
    return { state: existing.uncertain ? "ESCALATED" : existing.state, reason: "budget_used", effects: counts, incident: existing };
  }
  if (existing && nowMs - existing.lastAt < COOLDOWN_MS && decision.action !== "notify" && decision.action !== "notify_parent") {
    return { state: existing.state, reason: "cooldown", effects: counts, incident: existing };
  }
  const lock = `${bot}|${observation.owner}|${observation.session}|${observation.generation}`;
  if (!existing && Object.values(store.locks).includes(key)) {
    return { state: "UNKNOWN", reason: "incident_locked", effects: counts, incident: null };
  }
  if (store.locks[lock] && store.locks[lock] !== key) {
    return { state: "UNKNOWN", reason: "generation_or_lock_conflict", effects: counts, incident: existing ?? null };
  }
  store.locks[lock] = key;
  const incident = existing ?? { key, state: decision.state, budgetUsed: false, notifications: 0, lastAt: nowMs, uncertain: false };
  if (decision.action === "delegate_to_supervisor") {
    incident.state = "ESCALATED";
    incident.reason = "delegate_to_supervisor";
  } else if (decision.action === "reconnect_once") {
    if (!incident.budgetUsed) {
      counts.reconnect = 1;
      effects.reconnect?.(observation);
      incident.budgetUsed = true;
      incident.uncertain = observation.resultUnknown === true;
      incident.state = incident.uncertain ? "ESCALATED" : "RECOVERY_REQUESTED";
    }
  } else if (decision.action === "notify" || decision.action === "notify_parent") {
    counts.notify = 1;
    effects.notify?.(key);
    incident.notifications += 1;
    incident.state = "ESCALATED";
  } else if (decision.action === "handoff") {
    incident.state = "ESCALATED";
    incident.reason = decision.reason;
  }
  incident.lastAt = nowMs;
  store.incidents[key] = incident;
  return { state: incident.state, reason: decision.reason, effects: counts, incident };
}

export function loadStore(text) {
  if (!text) return { incidents: {}, locks: {} };
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad store");
  return { incidents: parsed.incidents ?? {}, locks: parsed.locks ?? {} };
}

export function productionCallCount(sourceText) {
  return sourceText.split("\n").filter((line) => /\bspawnSync\(|\bsystemctl\b|\bslackWrite\b|\bsetInterval\(/.test(line)).length;
}
