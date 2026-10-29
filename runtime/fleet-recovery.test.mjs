import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { evaluate, evaluateDurable, incidentKey, loadStore, openRecoveryStore, productionCallCount, recovered, supportMatrix } from "./fleet-recovery.mjs";

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

async function run(extra = {}, store = { incidents: Object.create(null), locks: Object.create(null) }, effects = {}) {
  return await evaluate(store, obs(extra), NOW, effects);
}

describe("fleet recovery fixture", () => {
  test("1 working states do not restart", async () => {
    for (const extra of [{}, { working: true }, { toolRunning: true }]) {
      expect((await run(extra)).effects.restart).toBe(0);
    }
  });

  test("2 human wait planned stop and policy silence do not probe", async () => {
    expect((await run({ waitingHuman: true })).effects).toMatchObject({ restart: 0, probe: 0 });
    expect((await run({ draft: true })).state).toBe("WAITING_HUMAN");
    expect((await run({ plannedStop: true })).effects.restart).toBe(0);
    expect((await run({ peerSilent: true })).effects.probe).toBe(0);
  });

  test("3 invalid observations stay unknown", async () => {
    expect((await evaluate({ incidents: {}, locks: {} }, null, NOW)).state).toBe("UNKNOWN");
    expect((await run({ observedAt: "2026-10-28T00:00:00.000Z" })).state).toBe("UNKNOWN");
    expect((await run({ generation: "other" , pidReused: true })).effects.restart).toBe(0);
    expect((await run({ ownerMismatch: true })).state).toBe("UNKNOWN");
  });

  test("4 attributed death delegates and does not restart", async () => {
    const result = await run({ processDead: true, attributed: true, supervisorRestart: true, cause: "process" });
    expect(result.reason).toBe("supervisor_owns_restart");
    expect(result.effects.restart).toBe(0);
  });

  test("5 official reconnect is once across repeated evaluations", async () => {
    const store = { incidents: {}, locks: {} };
    let calls = 0;
    const effects = { reconnect() { calls += 1; } };
    for (let i = 0; i < 10; i += 1) await run({ receiverDown: true, officialReconnect: true }, store, effects);
    expect(calls).toBe(1);
  });

  test("6 two workers lock one incident action", async () => {
    const store = { incidents: {}, locks: {} };
    const first = await run({ receiverDown: true, officialReconnect: true }, store, { reconnect() {} });
    delete store.incidents[incidentKey(obs())];
    const second = await evaluate(store, obs({ receiverDown: true, officialReconnect: true }), NOW, { reconnect() {} });
    expect(first.effects.reconnect).toBe(1);
    expect(second.reason).toBe("incident_locked");
    expect(second.effects.reconnect).toBe(0);
  });

  test("7 unknown result consumes budget", async () => {
    const store = { incidents: {}, locks: {} };
    await run({ receiverDown: true, officialReconnect: true, resultUnknown: true }, store);
    const again = await run({ receiverDown: true, officialReconnect: true }, store);
    expect(again.effects.reconnect).toBe(0);
    expect(again.reason).toBe("budget_used");
  });

  test("8 restarted watcher restores dedup", async () => {
    const saved = incidentKey(obs());
    const record = { key: saved, state: "RECOVERY_REQUESTED", budgetUsed: true, lastAt: NOW, notifications: 1, attempts: 1 };
    const text = JSON.stringify({ incidents: { [saved]: record }, locks: {} });
    const store = loadStore(text);
    expect((await run({ receiverDown: true, officialReconnect: true }, store)).effects.reconnect).toBe(0);
    expect(store.incidents[saved].budgetUsed).toBe(true);
  });

  test("9 shared and auth faults notify without per-bot restart", async () => {
    const auth = await run({ authExpired: true, role: "gajaegun" });
    const shared = await run({ sharedDependency: true, role: "dinobot", cause: "slack" });
    expect(auth.effects.restart).toBe(0);
    expect(shared.effects.restart).toBe(0);
    expect(shared.incident.key).toBe(JSON.stringify(["shared", "shared", "shared", "shared", "slack"]));
  });

  test("10 and 11 reply proof is exact", async () => {
    const proof = {
      inputId: "a", actualInputId: "a", session: "s", actualSession: "s", generation: "g", actualGeneration: "g",
      provider: "p", actualProvider: "p", model: "m", actualModel: "m", expectedAccountId: "acc", actualAccountId: "acc",
      expectedThreadId: "th", actualThreadId: "th", expectedReplyId: "r", actualReplyId: "r", threadReread: true, inference: true,
    };
    expect(recovered(proof)).toBe(true);
    expect(recovered({ ...proof, actualReplyId: "" })).toBe(false);
    expect(recovered({ ...proof, actualAccountId: "other" })).toBe(false);
    expect(recovered({ ...proof, ack: true })).toBe(false);
    expect(recovered({ pong: true })).toBe(false);
    expect(recovered({ globalMax: true })).toBe(false);
    expect((await run({ replyUnlinked: true })).state).toBe("VERIFYING");
  });

  test("12 remote missing pid is not a local fault", async () => {
    const result = await run({ role: "cursor", localPidAbsent: true, peerSilent: true });
    expect(result.state).not.toBe("CONFIRMED_FAULT");
    expect(result.effects.daemon).toBe(0);
  });

  test("13 missing official path and expired probe do nothing", async () => {
    const missing = await run({ receiverDown: true, officialReconnect: false });
    expect(missing.effects.reconnect).toBe(0);
    expect(missing.reason).toBe("no_official_reconnect");
    expect(supportMatrix().find((item) => item.role === "nahee").support).toBe("unsupported");
  });

  test("14 uncertain work is not resent", async () => {
    expect((await run({ resultUnknown: true })).effects.resend).toBe(0);
  });

  test("15 bad store and one bad observation stay closed", async () => {
    expect(() => loadStore("[]")).toThrow();
    const store = { incidents: {}, locks: {} };
    expect((await evaluate(store, null, NOW)).state).toBe("UNKNOWN");
    expect((await run({}, store)).state).toBe("HEALTHY");
  });

  test("16 missing heartbeat is unsupported and notification failure is not recovery", async () => {
    const matrix = supportMatrix();
    expect(matrix.find((item) => item.role === "seoyun").reason).toBe("remote_api_unverified");
    const result = await run({ authExpired: true });
    expect(result.state).not.toBe("RECOVERED");
    expect(supportMatrix().find((item) => item.role === "seoyun").reason).toBe("remote_api_unverified");
  });
  test("diagnostics v2 counterexamples stay closed", async () => {
    const nan = await evaluate({ incidents: Object.create(null), locks: Object.create(null) }, obs({ receiverDown: true, officialReconnect: true }), Number.NaN);
    expect(nan.effects.reconnect).toBe(0);
    expect((await run({ collectionFinishedAt: "2026-10-29T02:00:00.000Z" })).state).toBe("UNKNOWN");
    expect((await run({ processDead: true, attributed: true })).state).toBe("ESCALATED");
    expect((await run({ stage: "awaiting_reply", waitStartedAt: "2026-10-29T00:50:00.000Z" })).state).toBe("SUSPECT");
    const crashing = { incidents: Object.create(null), locks: Object.create(null), commits: [], commit(text) { this.commits.push(text); } };
    const crashed = await run({ receiverDown: true, officialReconnect: true }, crashing, { reconnect() { throw new Error("down"); } });
    expect(crashed.reason).toBe("effect_failed");
    const saved = JSON.parse(crashing.commits[0]);
    const key = incidentKey(obs());
    saved.incidents[key] = { ...saved.incidents[key], key, state: "ESCALATED", lastAt: NOW, attempts: 1 };
    const reloaded = loadStore(JSON.stringify(saved));
    expect((await run({ receiverDown: true, officialReconnect: true }, reloaded)).effects.reconnect).toBe(0);
    const notices = { incidents: Object.create(null), locks: Object.create(null) };
    expect((await run({ authExpired: true }, notices, { notify() {} })).effects.notify).toBe(1);
    expect((await run({ authExpired: true }, notices, { notify() {} })).effects.notify).toBe(0);
    expect(() => loadStore(JSON.stringify({ incidents: [], locks: {} }))).toThrow();
    expect(incidentKey(obs({ owner: "a|b" }))).not.toBe(incidentKey(obs({ owner: "a", session: "b|s1" })));
    expect(recovered({ inputId: "a", replyInputId: "b", session: "s", replySession: "s", generation: "g", replyGeneration: "g", provider: "p", replyProvider: "p", model: null, replyModel: null, replyId: "r", threadReread: true, expectedAccount: true, inference: true })).toBe(false);
  });
  test("final repair reserves one notify attempt and rejects bad records", async () => {
    const failing = { incidents: Object.create(null), locks: Object.create(null) };
    let tries = 0;
    for (let i = 0; i < 3; i += 1) {
      await run({ authExpired: true }, failing, { notify() { tries += 1; throw new Error("down"); } });
    }
    expect(tries).toBe(1);
    expect((await run({ authExpired: true }, { incidents: Object.create(null), locks: Object.create(null) })).state).toBe("ESCALATED");
    expect((await run({ role: "unlisted" })).state).toBe("UNKNOWN");
    expect(() => loadStore(JSON.stringify({ incidents: { bad: 7 }, locks: {} }))).toThrow();
    expect(() => loadStore(JSON.stringify({ incidents: { bad: { key: "bad", state: "MADE_UP", lastAt: NOW } }, locks: {} }))).toThrow();
    expect(supportMatrix().find((item) => item.role === "nahee").support).toBe("unsupported");
    const dbPath = join(mkdtempSync(join(tmpdir(), "fleet-repair-")), "budget.sqlite");
    const db = openRecoveryStore(dbPath);
    const first = await evaluateDurable(db, obs({ receiverDown: true, officialReconnect: true }), NOW, { reconnect() {} });
    const second = await evaluateDurable(db, obs({ receiverDown: true, officialReconnect: true }), NOW, { reconnect() { throw new Error("again"); } });
    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(false);
    expect(second.reason).toBe("attempt_reserved");
    db.close();
  });
  test("omo counterexamples keep absent adapters and shared budgets at zero extra calls", async () => {
    const absent = await evaluate({ incidents: Object.create(null), locks: Object.create(null) }, obs({ receiverDown: true, officialReconnect: true }), NOW);
    expect(absent.state).toBe("ESCALATED");
    expect(absent.reason).toBe("adapter_absent");
    expect(absent.effects.reconnect).toBe(0);
    expect(absent.incident.delivery).toBe("not_dispatched");
    const dir = mkdtempSync(join(tmpdir(), "omo-counter-"));
    const database = openRecoveryStore(join(dir, "budget.sqlite"));
    let calls = 0;
    const first = await evaluateDurable(database, obs({ cause: "receiver-a", receiverDown: true, officialReconnect: true }), NOW, { reconnect() { calls += 1; } });
    const second = await evaluateDurable(database, obs({ cause: "receiver-b", receiverDown: true, officialReconnect: true }), NOW, { reconnect() { calls += 1; } });
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
    expect(second.reason).toBe("attempt_reserved");
    expect(calls).toBe(1);
    const sharedDb = openRecoveryStore(join(dir, "shared.sqlite"));
    let notices = 0;
    const dori = await evaluateDurable(sharedDb, obs({ role: "dori", sharedDependency: true, cause: "slack" }), NOW, { notify() { notices += 1; } });
    const gajae = await evaluateDurable(sharedDb, obs({ role: "gajaegun", sharedDependency: true, cause: "slack" }), NOW, { notify() { notices += 1; } });
    expect(dori.calls + gajae.calls).toBe(1);
    expect(notices).toBe(1);
    database.close();
    sharedDb.close();
  });

  test("rejected async adapter stays on the incident", async () => {
    const rejections = [];
    const onRejection = (reason) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    const memory = await evaluate({ incidents: Object.create(null), locks: Object.create(null) }, obs({ receiverDown: true, officialReconnect: true }), NOW, {
      reconnect: () => Promise.reject(new Error("fixture-async-reconnect-rejected")),
    });
    const database = openRecoveryStore(join(mkdtempSync(join(tmpdir(), "async-reject-")), "budget.sqlite"));
    const durable = await evaluateDurable(database, obs({ receiverDown: true, officialReconnect: true }), NOW, {
      reconnect: () => Promise.reject(new Error("fixture-async-reconnect-rejected")),
    });
    const again = await evaluateDurable(database, obs({ receiverDown: true, officialReconnect: true }), NOW, {
      reconnect: () => Promise.reject(new Error("fixture-async-reconnect-rejected")),
    });
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onRejection);
    expect(rejections).toEqual([]);
    expect(memory.state).toBe("ESCALATED");
    expect(memory.reason).toBe("fixture-async-reconnect-rejected");
    expect(memory.incident.effectError).toBe("fixture-async-reconnect-rejected");
    expect(memory.incident.uncertain).toBe(true);
    expect(memory.effects.reconnect).toBe(1);
    expect(durable.state).toBe("ESCALATED");
    expect(durable.calls).toBe(1);
    expect(durable.reason).toBe("fixture-async-reconnect-rejected");
    expect(again.calls).toBe(0);
    expect(again.reason).toBe("attempt_reserved");
    database.close();
  });

  test("durable worker closes the database after the attempt settles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-settle-"));
    const dbPath = join(dir, "budget.sqlite");
    const proc = Bun.spawnSync(["bun", new URL("./fleet-recovery-workers.mjs", import.meta.url).pathname, dbPath, "audit-caller"], { timeout: 10_000 });
    expect(proc.exitCode).toBe(0);
    expect(proc.stderr.toString()).not.toContain("closed database");
    expect(JSON.parse(proc.stdout.toString())).toEqual({ slot: "audit-caller", reserved: true, calls: 1 });
  });

  test("production module has no live effect calls", () => {
    const text = readFileSync(new URL("./fleet-recovery.mjs", import.meta.url), "utf8");
    expect(productionCallCount(text)).toBe(0);
  });
  test("durable unknown reconnect stays escalated", async () => {
    const db = openRecoveryStore(join(mkdtempSync(join(tmpdir(), "unknown-durable-")), "budget.sqlite"));
    const result = await evaluateDurable(db, obs({ receiverDown: true, officialReconnect: true, resultUnknown: true }), NOW, { reconnect() {} });
    expect(result.state).toBe("ESCALATED");
    expect(result.calls).toBe(1);
    db.close();
  });

  test("native recovery path aliases are refused before opening", () => {
    expect(() => openRecoveryStore("/home/jm/.gajaegun/gajaeway/./gateway.db")).toThrow("native db refused");
    expect(() => openRecoveryStore("/home/jm/.dinobot/alias.sqlite")).toThrow("native db refused");
  });
});
