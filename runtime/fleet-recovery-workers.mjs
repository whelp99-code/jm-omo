import { evaluateDurable, openRecoveryStore } from "./fleet-recovery.mjs";

const [dbPath, slot] = process.argv.slice(2);
const db = openRecoveryStore(dbPath);
const now = Date.parse("2026-10-29T01:00:00.000Z");
const observation = {
  role: "dori", owner: "dori-owner", session: "s1", generation: "start-1", cause: "receiver",
  observedAt: "2026-10-29T00:59:30.000Z",
  collectionStartedAt: "2026-10-29T00:59:00.000Z",
  collectionFinishedAt: "2026-10-29T01:00:00.000Z",
  receiverDown: true,
  officialReconnect: true,
};
let calls = 0;
const result = evaluateDurable(db, observation, now, { reconnect() { calls += 1; } });
db.close();
process.stdout.write(`${JSON.stringify({ slot, reserved: result.reserved, calls })}\n`);
