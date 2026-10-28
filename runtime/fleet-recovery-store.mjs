import { Database } from "bun:sqlite";

const FORBIDDEN = ["/home/jm/.gajaegun/gajaeway/gateway.db", "/home/jm/.dinobot/"];

export function openRecoveryStore(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("missing fixture path");
  if (FORBIDDEN.some((prefix) => path.startsWith(prefix))) throw new Error("native db refused");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_budget (
    incident_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    state TEXT NOT NULL,
    last_at INTEGER NOT NULL
  )`);
  return db;
}

export function reserveAttempt(db, key, nowMs) {
  const run = db.transaction(() => {
    const row = db.query("SELECT attempts FROM recovery_budget WHERE incident_key = ?").get(key);
    if (row && row.attempts >= 1) return false;
    db.query(`INSERT INTO recovery_budget (incident_key, attempts, state, last_at)
      VALUES (?, 1, 'reserved', ?)
      ON CONFLICT(incident_key) DO UPDATE SET attempts = attempts + 1, last_at = excluded.last_at
      WHERE attempts < 1`).run(key, nowMs);
    const saved = db.query("SELECT attempts FROM recovery_budget WHERE incident_key = ?").get(key);
    return saved?.attempts === 1 && !row;
  });
  return run.immediate();
}

export function markAttempt(db, key, state) {
  db.query("UPDATE recovery_budget SET state = ? WHERE incident_key = ?").run(state, key);
}

export function readAttempt(db, key) {
  return db.query("SELECT attempts, state, last_at FROM recovery_budget WHERE incident_key = ?").get(key) ?? null;
}
