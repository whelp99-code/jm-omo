import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { evaluate, incidentKey, loadStore, productionCallCount, recovered, supportMatrix } from "./fleet-recovery.mjs";

const NOW = Date.parse("2026-10-29T01:00:00.000Z");
const WINDOW = {
  observedAt: "2026-10-29T00:59:30.000Z",
  collectionStartedAt: "2026-10-29T00:59:00.000Z",
  collectionFinishedAt: "2026-10-29T01:00:00.000Z",
};

function obs(extra = {}) {
  return {
    role: "dori", owner: "dori-owner", session: "s1", generation: "start-1", cause: "receiver",
    ...WINDOW, ...extra,
  };
}

function run(extra = {}, store = { incidents: {}, locks: {} }, effects = {}) {
  return evaluate(store, obs(extra), NOW, effects);
}

describe("fleet recovery fixture", () => {
  test("1 working states do not restart", () => {
    for (const extra of [{}, { working: true }, { toolRunning: true }]) {
      expect(run(extra).effects.restart).toBe(0);
    }
  });

  test("2 human wait planned stop and policy silence do not probe", () => {
    expect(run({ waitingHuman: true }).effects).toMatchObject({ restart: 0, probe: 0 });
    expect(run({ draft: true }).state).toBe("WAITING_HUMAN");
    expect(run({ plannedStop: true }).effects.restart).toBe(0);
    expect(run({ peerSilent: true }).effects.probe).toBe(0);
  });

  test("3 invalid observations stay unknown", () => {
    expect(evaluate({ incidents: {}, locks: {} }, null, NOW).state).toBe("UNKNOWN");
    expect(run({ observedAt: "2026-10-28T00:00:00.000Z" }).state).toBe("UNKNOWN");
    expect(run({ generation: "other" , pidReused: true }).effects.restart).toBe(0);
    expect(run({ ownerMismatch: true }).state).toBe("UNKNOWN");
  });

  test("4 attributed death delegates and does not restart", () => {
    const result = run({ processDead: true, attributed: true, supervisorRestart: true, cause: "process" });
    expect(result.reason).toBe("supervisor_owns_restart");
    expect(result.effects.restart).toBe(0);
  });

  test("5 official reconnect is once across repeated evaluations", () => {
    const store = { incidents: {}, locks: {} };
    let calls = 0;
    const effects = { reconnect() { calls += 1; } };
    for (let i = 0; i < 10; i += 1) run({ receiverDown: true, officialReconnect: true }, store, effects);
    expect(calls).toBe(1);
  });

  test("6 two workers lock one incident action", () => {
    const store = { incidents: {}, locks: {} };
    const first = run({ receiverDown: true, officialReconnect: true }, store);
    delete store.incidents[incidentKey(obs())];
    const second = evaluate(store, obs({ receiverDown: true, officialReconnect: true }), NOW);
    expect(first.effects.reconnect).toBe(1);
    expect(second.reason).toBe("incident_locked");
    expect(second.effects.reconnect).toBe(0);
  });

  test("7 unknown result consumes budget", () => {
    const store = { incidents: {}, locks: {} };
    run({ receiverDown: true, officialReconnect: true, resultUnknown: true }, store);
    const again = run({ receiverDown: true, officialReconnect: true }, store);
    expect(again.effects.reconnect).toBe(0);
    expect(again.reason).toBe("budget_used");
  });

  test("8 restarted watcher restores dedup", () => {
    const saved = incidentKey(obs());
    const text = JSON.stringify({ incidents: { [saved]: { key: saved, state: "RECOVERY_REQUESTED", budgetUsed: true, lastAt: NOW, notifications: 1 } }, locks: {} });
    const store = loadStore(text);
    expect(run({ receiverDown: true, officialReconnect: true }, store).effects.reconnect).toBe(0);
    expect(store.incidents[saved].budgetUsed).toBe(true);
  });

  test("9 shared and auth faults notify without per-bot restart", () => {
    const auth = run({ authExpired: true, role: "gajaegun" });
    const shared = run({ sharedDependency: true, role: "dinobot", cause: "slack" });
    expect(auth.effects.restart).toBe(0);
    expect(shared.effects.restart).toBe(0);
    expect(shared.incident.key).toBe("parent|slack");
  });

  test("10 and 11 reply proof is exact", () => {
    expect(recovered({ inputId: "a", sameInput: true, sameSession: true, sameGeneration: true, inference: true, replyId: "r", threadReread: true, expectedAccount: true })).toBe(true);
    expect(recovered({ ack: true, inputId: "a", sameInput: true, sameSession: true, sameGeneration: true, inference: true, replyId: "r", threadReread: true, expectedAccount: true })).toBe(false);
    expect(recovered({ pong: true })).toBe(false);
    expect(recovered({ globalMax: true })).toBe(false);
    expect(run({ replyUnlinked: true }).state).toBe("VERIFYING");
  });

  test("12 remote missing pid is not a local fault", () => {
    const result = run({ role: "cursor", localPidAbsent: true, peerSilent: true });
    expect(result.state).not.toBe("CONFIRMED_FAULT");
    expect(result.effects.daemon).toBe(0);
  });

  test("13 missing official path and expired probe do nothing", () => {
    const missing = run({ receiverDown: true, officialReconnect: false });
    expect(missing.effects.reconnect).toBe(0);
    expect(missing.reason).toBe("no_official_reconnect");
    expect(supportMatrix().find((item) => item.role === "nahee").support).toBe("unsupported");
  });

  test("14 uncertain work is not resent", () => {
    expect(run({ resultUnknown: true }).effects.resend).toBe(0);
  });

  test("15 bad store and one bad observation stay closed", () => {
    expect(() => loadStore("[]")).toThrow();
    const store = { incidents: {}, locks: {} };
    expect(evaluate(store, null, NOW).state).toBe("UNKNOWN");
    expect(run({}, store).state).toBe("HEALTHY");
  });

  test("16 missing heartbeat is unsupported and notification failure is not recovery", () => {
    const matrix = supportMatrix();
    expect(matrix.find((item) => item.role === "seoyun").reason).toBe("no_verified_remote_api");
    const result = run({ authExpired: true });
    expect(result.state).not.toBe("RECOVERED");
    expect(recovered(null)).toBe(false);
  });

  test("production module has no live effect calls", () => {
    const text = readFileSync(new URL("./fleet-recovery.mjs", import.meta.url), "utf8");
    expect(productionCallCount(text)).toBe(0);
  });
});
