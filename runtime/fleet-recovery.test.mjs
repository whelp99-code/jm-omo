import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { evaluate, evaluateDurable, incidentKey, loadStore, openRecoveryStore, productionCallCount, recovered, supportMatrix } from "./fleet-recovery.mjs";

const NOW = Date.parse("2026-10-29T01:00:00.000Z");
const WINDOW = {
  observedAt: "2026-10-29T00:59:30.000Z",
  collectionStartedAt: "2026-10-29T00:59:00.000Z",
  collectionFinishedAt: "2026-10-29T01:00:00.000Z",
};

function obs(extra = {}) {
  return { role: "dori", owner: "dori-owner", session: "s1", generation: "start-1", cause: "receiver", ...WINDOW, ...extra };
}

function store() {
  return { incidents: Object.create(null), locks: Object.create(null) };
}

async function run(extra = {}, current = store(), effects = {}) {
  return evaluate(current, obs(extra), NOW, effects);
}

const proof = {
  inputId: "a", actualInputId: "a", session: "s", actualSession: "s", generation: "g", actualGeneration: "g",
  provider: "p", actualProvider: "p", model: "m", actualModel: "m", expectedAccountId: "acc", actualAccountId: "acc",
  expectedThreadId: "th", actualThreadId: "th", expectedReplyId: "r", actualReplyId: "r", threadReread: true, inference: true,
};

describe("fleet recovery fixture", () => {
  test("protected and invalid observations do not act", async () => {
    expect((await run()).effects.restart).toBe(0);
    expect((await run({ working: true })).state).toBe("WORKING");
    expect((await run({ waitingHuman: true })).effects.probe).toBe(0);
    expect((await run({ plannedStop: true })).state).toBe("PLANNED_STOP");
    expect((await evaluate(store(), null, NOW)).state).toBe("UNKNOWN");
    expect((await run({ observedAt: "2026-10-28T00:00:00.000Z" })).state).toBe("UNKNOWN");
    expect((await run({ role: "unlisted" })).state).toBe("UNKNOWN");
  });

  test("supervisor death delegates and reconnect is once", async () => {
    const delegated = await run({ processDead: true, attributed: true, supervisorRestart: true, cause: "process" });
    expect(delegated.reason).toBe("supervisor_owns_restart");
    expect(delegated.effects.restart).toBe(0);
    const current = store();
    let calls = 0;
    for (let i = 0; i < 10; i += 1) await run({ receiverDown: true, officialReconnect: true }, current, { reconnect() { calls += 1; } });
    expect(calls).toBe(1);
  });

  test("two evaluations cannot spend the same incident twice", async () => {
    const current = store();
    const first = await run({ receiverDown: true, officialReconnect: true }, current, { reconnect() {} });
    delete current.incidents[incidentKey(obs())];
    const second = await evaluate(current, obs({ receiverDown: true, officialReconnect: true }), NOW, { reconnect() {} });
    expect(first.effects.reconnect).toBe(1);
    expect(second.reason).toBe("incident_locked");
    expect(second.effects.reconnect).toBe(0);
  });

  test("unknown result and reload keep the budget", async () => {
    const current = store();
    await run({ receiverDown: true, officialReconnect: true, resultUnknown: true }, current, { reconnect() {} });
    const again = await run({ receiverDown: true, officialReconnect: true }, current, { reconnect() {} });
    expect(again.effects.reconnect).toBe(0);
    expect(again.reason).toBe("budget_used");
    const saved = incidentKey(obs());
    const reloaded = loadStore(JSON.stringify({ incidents: { [saved]: { key: saved, state: "RECOVERY_REQUESTED", budgetUsed: true, lastAt: NOW, attempts: 1 } }, locks: {} }));
    expect((await run({ receiverDown: true, officialReconnect: true }, reloaded, { reconnect() {} })).effects.reconnect).toBe(0);
  });

  test("reply proof compares actual identity", () => {
    expect(recovered(proof)).toBe(true);
    expect(recovered({ ...proof, actualReplyId: "" })).toBe(false);
    expect(recovered({ ...proof, actualAccountId: "other" })).toBe(false);
    expect(recovered({ ...proof, ack: true })).toBe(false);
    expect(recovered(null)).toBe(false);
  });

  test("remote roles stay unsupported and bad records are refused", () => {
    expect(supportMatrix().find((item) => item.role === "nahee").support).toBe("unsupported");
    expect(() => loadStore("[]")).toThrow();
    expect(() => loadStore(JSON.stringify({ incidents: { bad: 7 }, locks: {} }))).toThrow();
    expect(() => loadStore(JSON.stringify({ incidents: { bad: { key: "bad", state: "MADE_UP", lastAt: NOW } }, locks: {} }))).toThrow();
  });

  test("missing adapter is not delivered", async () => {
    const absent = await evaluate(store(), obs({ receiverDown: true, officialReconnect: true }), NOW);
    expect(absent.state).toBe("ESCALATED");
    expect(absent.reason).toBe("adapter_absent");
    expect(absent.effects.reconnect).toBe(0);
    expect(absent.incident.delivery).toBe("not_dispatched");
  });

  test("same bot and shared dependency reserve one durable attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-counter-"));
    const database = openRecoveryStore(join(dir, "budget.sqlite"));
    let calls = 0;
    const first = await evaluateDurable(database, obs({ cause: "receiver-a", receiverDown: true, officialReconnect: true }), NOW, { reconnect() { calls += 1; } });
    const second = await evaluateDurable(database, obs({ cause: "receiver-b", receiverDown: true, officialReconnect: true }), NOW, { reconnect() { calls += 1; } });
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
    expect(calls).toBe(1);
    const sharedDb = openRecoveryStore(join(dir, "shared.sqlite"));
    let notices = 0;
    const dori = await evaluateDurable(sharedDb, obs({ sharedDependency: true, cause: "slack" }), NOW, { notify() { notices += 1; } });
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
    const memory = await evaluate(store(), obs({ receiverDown: true, officialReconnect: true }), NOW, {
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
    expect(memory.incident.effectError).toBe("fixture-async-reconnect-rejected");
    expect(memory.incident.uncertain).toBe(true);
    expect(durable.calls).toBe(1);
    expect(durable.reason).toBe("fixture-async-reconnect-rejected");
    expect(again.calls).toBe(0);
    expect(again.reason).toBe("attempt_reserved");
    database.close();
  });

  test("production module has no live effect calls", () => {
    expect(productionCallCount(readFileSync(new URL("./fleet-recovery.mjs", import.meta.url), "utf8"))).toBe(0);
  });
});
