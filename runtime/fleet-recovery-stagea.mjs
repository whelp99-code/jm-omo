import { Database } from "bun:sqlite";

const DB_BUDGET_MS = 2_000;
const FORBIDDEN = ["/home/jm/.gajaegun/gajaeway/gateway.db", "/home/jm/.dinobot/"];
const QSTATES = new Set(["UNKNOWN", "HEALTHY", "ESCALATED", "RECOVERY_REQUESTED"]);
const PHASES = new Set(["PREPARED", "DISPATCH_INTENT", "SETTLED"]);
const OUTCOMES = new Set(["pending", "accepted", "delivered", "failed", "unknown", "not_dispatched"]);

export function openStageStore(path, nowMs = Date.now()) {
  const started = Date.now();
  if (typeof path !== "string" || FORBIDDEN.some((prefix) => path.startsWith(prefix))) {
    return { ok: false, reason: "native_db_refused" };
  }
  let db;
  try {
    db = new Database(path);
    db.exec(`PRAGMA busy_timeout=${DB_BUDGET_MS}`);
    if (Date.now() - started > DB_BUDGET_MS) return closed(db, "busy");
    db.exec("PRAGMA foreign_keys=ON");
    const fk = db.query("PRAGMA foreign_keys").get();
    if (fk?.foreign_keys !== 1) return closed(db, "schema_failed");
    const versions = db.query("SELECT schema_version FROM meta ORDER BY schema_version").all();
    if (versions.length === 0) return initializeSchema(db, nowMs, started);
    if (versions.length !== 1 || versions[0].schema_version !== 1) return closed(db, "unsupported_schema");
    return { ok: true, db, budgetMs: DB_BUDGET_MS, openedAt: nowMs };
  } catch (error) {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return openEmptySchema(path, nowMs, started);
    }
    return { ok: false, reason: /busy/i.test(String(error)) ? "busy" : "schema_failed" };
  }
}

function openEmptySchema(path, nowMs, started) {
  let db;
  try {
    db = new Database(path);
    db.exec(`PRAGMA busy_timeout=${DB_BUDGET_MS}`);
    db.exec("PRAGMA foreign_keys=ON");
    if (db.query("PRAGMA foreign_keys").get()?.foreign_keys !== 1) return closed(db, "schema_failed");
    return initializeSchema(db, nowMs, started);
  } catch (error) {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
    return { ok: false, reason: /busy/i.test(String(error)) ? "busy" : "schema_failed" };
  }
}

function initializeSchema(db, nowMs, started) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (schema_version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL,
        qstate TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER,
        revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (
        observation_key TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id));
      CREATE TABLE IF NOT EXISTS bot_locks (
        bot_key TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), held_generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (
        incident_id TEXT NOT NULL REFERENCES incidents(id), kind TEXT NOT NULL,
        phase TEXT NOT NULL, budget_used INTEGER NOT NULL, outcome TEXT NOT NULL,
        opened_at INTEGER NOT NULL, PRIMARY KEY (incident_id, kind));
      CREATE TABLE IF NOT EXISTS target_history (
        bot_key TEXT PRIMARY KEY, last_incident_id TEXT NOT NULL REFERENCES incidents(id), last_at INTEGER NOT NULL);`);
  db.query("INSERT OR IGNORE INTO meta (schema_version) VALUES (1)").run();
  const versions = db.query("SELECT schema_version FROM meta ORDER BY schema_version").all();
  if (versions.length !== 1 || versions[0].schema_version !== 1) return closed(db, "unsupported_schema");
  if (Date.now() - started > DB_BUDGET_MS) return closed(db, "busy");
  return { ok: true, db, budgetMs: DB_BUDGET_MS, openedAt: nowMs };
}

function closed(db, reason) {
  db.close();
  return { ok: false, reason };
}

export function transition(db, command) {
  if (!command || command.trustedClock !== true || !Number.isFinite(command.nowMs)) return { ok: false, reason: "untrusted_clock" };
  if (!command.observationKey || !command.botKey || !command.generation) return { ok: false, reason: "missing_identity" };
  const run = db.transaction(() => {
    const alias = db.query("SELECT incident_id FROM aliases WHERE observation_key = ?").get(command.observationKey);
    const lock = db.query("SELECT incident_id FROM bot_locks WHERE bot_key = ?").get(command.botKey);
    const shared = command.sharedKey
      ? db.query("SELECT id FROM incidents WHERE scope_kind = 'shared' AND scope_key = ? AND closed_at IS NULL").get(command.sharedKey)
      : null;
    const incidentId = alias?.incident_id ?? shared?.id ?? lock?.incident_id ?? null;
    if (!incidentId && command.independentEpisode !== true) return { ok: false, reason: "missing_independence_evidence" };
    const id = incidentId ?? `ep-${command.observationKey}`;
    if (!incidentId) {
      db.query("INSERT INTO incidents (id, scope_kind, scope_key, qstate, opened_at, closed_at, revision) VALUES (?, ?, ?, 'UNKNOWN', ?, NULL, 1)")
        .run(id, command.sharedKey ? "shared" : "bot", command.sharedKey ?? command.botKey, command.nowMs);
    }
    db.query("INSERT OR IGNORE INTO aliases (observation_key, incident_id) VALUES (?, ?)").run(command.observationKey, id);
    db.query("INSERT INTO bot_locks (bot_key, incident_id, held_generation) VALUES (?, ?, ?) ON CONFLICT(bot_key) DO NOTHING")
      .run(command.botKey, id, command.generation);
    const attempt = db.query("SELECT budget_used, outcome FROM attempts WHERE incident_id = ? AND kind = ?").get(id, command.kind);
    if (attempt?.budget_used >= 1) return { ok: true, reserved: false, reason: "budget_used", incidentId: id, outcome: attempt.outcome };
    db.query("INSERT INTO attempts (incident_id, kind, phase, budget_used, outcome, opened_at) VALUES (?, ?, 'PREPARED', 1, 'pending', ?)")
      .run(id, command.kind, command.nowMs);
    db.query("INSERT INTO target_history (bot_key, last_incident_id, last_at) VALUES (?, ?, ?) ON CONFLICT(bot_key) DO UPDATE SET last_incident_id = excluded.last_incident_id, last_at = excluded.last_at")
      .run(command.botKey, id, command.nowMs);
    return { ok: true, reserved: true, reason: "prepared", incidentId: id, phase: "PREPARED" };
  });
  try {
    return run.immediate();
  } catch (error) {
    return { ok: false, reason: /busy/i.test(String(error)) ? "busy" : "constraint_failed" };
  }
}

export function settle(db, incidentId, kind, outcome) {
  if (!OUTCOMES.has(outcome) || !PHASES.has("SETTLED")) return { ok: false, reason: "bad_enum" };
  const row = db.query("SELECT budget_used FROM attempts WHERE incident_id = ? AND kind = ?").get(incidentId, kind);
  if (!row) return { ok: false, reason: "missing_attempt" };
  db.query("UPDATE attempts SET phase = 'SETTLED', outcome = ? WHERE incident_id = ? AND kind = ?").run(outcome, incidentId, kind);
  return { ok: true, outcome };
}

export function readIncident(db, id) {
  return db.query("SELECT id, qstate, opened_at FROM incidents WHERE id = ?").get(id) ?? null;
}

export const STAGE_A_LIMITS = { budgetMs: DB_BUDGET_MS, attempts: 1, qstates: [...QSTATES] };
