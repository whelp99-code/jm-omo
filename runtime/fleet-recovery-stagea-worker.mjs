import { openStageStore, transition } from "./fleet-recovery-stagea.mjs";

const [dbPath, slot, mode] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ slot, ready: true, pid: process.pid })}\n`);
await new Promise((resolve) => {
  const accept = (chunk) => {
    if (!String(chunk).includes("go")) return;
    process.stdin.off("data", accept);
    process.stdin.pause();
    resolve();
  };
  process.stdin.on("data", accept);
});
const opened = openStageStore(dbPath, 1_000);
if (!opened.ok) {
  process.stdout.write(`${JSON.stringify({ slot, pid: process.pid, ok: false, reason: opened.reason })}\n`);
  process.exit(0);
}
const shared = '["slack","tenant","dependency"]';
const command = {
  trustedClock: true, nowMs: 1_000, independentEpisode: true, kind: "notification", generation: "g",
  observationKey: mode === "cause" ? `["dori","o","s","g","${slot}"]` : `["${slot}","o","s","g","receiver"]`,
  botKey: `["${slot}","o","runtime"]`,
  sharedKey: mode === "shared" ? shared : null,
};
const result = transition(opened.db, command);
opened.db.close();
process.stdout.write(`${JSON.stringify({ slot, pid: process.pid, reserved: result.reserved, reason: result.reason, incidentId: result.incidentId })}\n`);
