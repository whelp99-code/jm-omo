import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptHealthRecord, ageClass, attribution, collect, forbiddenCallSites, healthCheckedAt, openReadonly } from "./bot-response-watchdog.mjs";

const NOW = "2026-10-28T06:00:00.000Z";
const FRESH = "2026-10-28T05:59:30.000Z";
const STALE = "2026-10-28T05:57:00.000Z";

function windowFor(observedAt, finishedAt = NOW) {
  const observedMs = Date.parse(observedAt);
  const finishedMs = Date.parse(finishedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(finishedMs)) {
    return { collectionStartedAt: FRESH, collectionFinishedAt: NOW };
  }
  const started = Math.min(observedMs, finishedMs);
  const finished = Math.max(observedMs, finishedMs, Date.parse(NOW));
  return {
    collectionStartedAt: new Date(started).toISOString(),
    collectionFinishedAt: new Date(finished).toISOString(),
  };
}

function bot(name, extra = {}) {
  const observedAt = extra.observedAt ?? FRESH;
  return {
    source: `${name}-fixture`,
    observedAt,
    generation: "g1",
    sessionId: `${name}-session`,
    processAlive: true,
    pidAlive: true,
    receiverPresent: true,
    working: false,
    sessionMatchesProcess: true,
    ...windowFor(observedAt),
    ...extra,
  };
}

function run(overrides = {}) {
  return collect({
    now: NOW,
    omonyang: bot("omonyang"),
    dinobot: bot("dinobot"),
    dori: bot("dori", { autostart: "unconfirmed" }),
    gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    ...overrides,
  });
}

describe("PR1 readonly observation", () => {
  test("1. four bots stay separate", () => {
    const report = run({ dinobot: bot("dinobot", { processAlive: false, pidAlive: false, receiverPresent: false }) });
    expect(report.bots.map((item) => item.bot)).toEqual(["omonyang", "dinobot", "dori", "gajaegun"]);
    expect(report.bots.find((item) => item.bot === "omonyang").state).toBe("idle_or_working");
    expect(report.bots.find((item) => item.bot === "dinobot").state).toBe("fault");
    expect(report.bots.every((item) => item.identity)).toBe(true);
    expect(report.bots.find((item) => item.bot === "dinobot").identity).not.toBe(report.bots.find((item) => item.bot === "omonyang").identity);
  });

  test("2. clock boundary is not promoted", () => {
    const boundary = new Date(Date.parse(NOW) - 120_000).toISOString();
    const before = new Date(Date.parse(NOW) - 119_999).toISOString();
    const after = new Date(Date.parse(NOW) - 120_001).toISOString();
    expect(run({ dori: bot("dori", { observedAt: before }) }).bots.find((item) => item.bot === "dori").state).toBe("idle_or_working");
    expect(run({ dori: bot("dori", { observedAt: boundary }) }).bots.find((item) => item.bot === "dori").state).toBe("idle_or_working");
    expect(run({ dori: bot("dori", { observedAt: after }) }).bots.find((item) => item.bot === "dori").state).toBe("unconfirmed");
    expect(run({ dori: bot("dori", { observedAt: "not-a-time" }) }).bots.find((item) => item.bot === "dori").reason).toBe("stale_or_bad_clock");
    expect(run({ dori: bot("dori", { observedAt: "2026-10-28T06:00:01.000Z" }) }).bots.find((item) => item.bot === "dori").state).toBe("unconfirmed");
  });

  test("3. absent process, absent receiver, and stale pid stay distinct", () => {
    const absent = run({ dinobot: bot("dinobot", { processAlive: false, pidAlive: false }) }).bots.find((item) => item.bot === "dinobot");
    const receiver = run({ dinobot: bot("dinobot", { receiverPresent: false }) }).bots.find((item) => item.bot === "dinobot");
    const failed = run({ dinobot: { readError: "query_failed", source: "unit" } }).bots.find((item) => item.bot === "dinobot");
    const stalePid = run({
      gajaegun: bot("gajaegun", { pid: 9, pidAlive: true, pidSessionId: "other-session", sessionId: "gajaegun-session", processAlive: false }),
    }).bots.find((item) => item.bot === "gajaegun");
    expect(absent.reason).toBe("process_absent");
    expect(receiver.reason).toBe("receiver_absent");
    expect(failed.reason).toBe("read_failed");
    expect(stalePid.state).not.toBe("response_confirmed");
    expect(stalePid.stalePidRejected).toBe(true);
  });

  test("4. busy states are not faults", () => {
    const cases = [
      ["working", { working: true }, "idle_or_working"],
      ["human", { awaitingHuman: true }, "awaiting_human"],
      ["silent", { intentionalSilence: true }, "intentional_silence"],
      ["planned", { plannedStop: true }, "planned_stop"],
      ["maint", { maintenance: true }, "maintenance"],
    ];
    for (const [label, extra, state] of cases) {
      expect(run({ dori: bot("dori", extra) }).bots.find((item) => item.bot === "dori").state, label).toBe(state);
    }
  });

  test("5. acceptance flags and foreign replies are not a new reply", () => {
    const report = run({
      gajaegun: bot("gajaegun", {
        pid: 1, pidAlive: true, pidSessionId: "gajaegun-session",
        autoAccepted: true, rpcAccepted: true, doneFlag: true, globalMaxReply: "other-session",
      }),
    });
    expect(report.bots.every((item) => item.replyLink === "unsupported")).toBe(true);
    expect(report.bots.every((item) => item.state !== "response_confirmed")).toBe(true);
  });

  test("6. current provider auth error is not hidden by an old success", () => {
    const current = run({
      omonyang: bot("omonyang", { provider: "anthropic-subscription", providerError: "invalid_grant", providerErrorProvider: "anthropic-subscription", providerErrorGeneration: "g1" }),
    }).bots.find((item) => item.bot === "omonyang");
    const old = run({
      omonyang: bot("omonyang", { provider: "chatgpt-subscription", providerError: "invalid_grant", providerErrorGeneration: "old" }),
    }).bots.find((item) => item.bot === "omonyang");
    expect(current.state).toBe("auth_required");
    expect(old.state).not.toBe("auth_required");
    expect(old.state).not.toBe("response_confirmed");
  });

  test("7. readonly open does not create a missing db and leaves fixture bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-pr1-"));
    const missing = join(dir, "missing.db");
    expect(openReadonly(missing).reason).toBe("missing_db");
    expect(() => statSync(missing)).toThrow();
    const dbPath = join(dir, "fixture.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE sessions (origin_key TEXT)");
    db.exec("INSERT INTO sessions VALUES ('one')");
    db.close();
    const before = statSync(dbPath);
    const opened = openReadonly(dbPath);
    expect(opened.ok).toBe(true);
    expect(opened.db.query("SELECT COUNT(*) AS n FROM sessions").get().n).toBe(1);
    expect(() => opened.db.exec("INSERT INTO sessions VALUES ('two')")).toThrow();
    opened.db.close();
    const after = statSync(dbPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("8. one adapter failure keeps the others and redacts secrets", () => {
    const report = run({
      dori: { readError: "permission_denied", source: "inspect", token: "xoxb-do-not-log", body: "hello secret" },
    });
    const text = JSON.stringify(report);
    expect(report.bots.find((item) => item.bot === "dori").state).toBe("unconfirmed");
    expect(report.bots.find((item) => item.bot === "gajaegun").state).toBe("idle_or_working");
    expect(text).not.toContain("xoxb-do-not-log");
    expect(text).not.toContain("refresh_token");
  });

  test("9. repeated identical observation does not invent incidents", () => {
    const first = run();
    const second = run();
    expect(JSON.stringify(first.bots)).toBe(JSON.stringify(second.bots));
    const silent = run({ dori: bot("dori", { watchOutput: "" }) });
    expect(silent.bots.find((item) => item.bot === "dori").state).not.toBe("fault");
  });

  test("10. recovery, model, slack, and timer calls are absent", () => {
    const text = readFileSync(new URL("./bot-response-watchdog.mjs", import.meta.url), "utf8");
    expect(forbiddenCallSites(text)).toEqual([]);
    expect(text.includes("[\"--user\", \"show\"")).toBe(true);
    const report = run();
    expect(report.externalWatch).toBe("unsupported");
    expect(report.bots.every((item) => item.recoveryInvoked === false && item.modelInvoked === false && item.slackWrite === false)).toBe(true);
    expect(report.bots.find((item) => item.bot === "dori").autostart).toBe("unconfirmed");
  });
  test("F1 db readable is not process alive", () => {
    const row = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: { dbReadable: true, sessionId: "present", processAlive: true, source: "db", observedAt: FRESH },
    }).bots.find((item) => item.bot === "gajaegun");
    expect(row.state).toBe("unconfirmed");
    expect(row.processEvidence).not.toBe("bound");
  });

  test("F3 invalid now is unconfirmed", () => {
    for (const now of [undefined, "not-a-time"]) {
      const report = collect({ now, omonyang: bot("omonyang"), dinobot: bot("dinobot"), dori: bot("dori"), gajaegun: bot("gajaegun") });
      expect(report.bots.every((item) => item.state === "unconfirmed" && item.reason === "invalid_now")).toBe(true);
    }
  });

  test("F4 collection window rejects an observation after finish", () => {
    const started = new Date(Date.parse(NOW) - 1000).toISOString();
    const inside = collect({
      now: NOW,
      omonyang: bot("omonyang", { observedAt: new Date(Date.parse(NOW) - 5).toISOString(), collectionStartedAt: started, collectionFinishedAt: NOW }),
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    }).bots.find((item) => item.bot === "omonyang");
    const afterFinish = collect({
      now: NOW,
      omonyang: bot("omonyang", { observedAt: new Date(Date.parse(NOW) + 5).toISOString(), collectionStartedAt: started, collectionFinishedAt: NOW }),
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: bot("gajaegun"),
    }).bots.find((item) => item.bot === "omonyang");
    expect(inside.state).toBe("idle_or_working");
    expect(afterFinish.state).toBe("unconfirmed");
    expect(afterFinish.reason).toBe("stale_or_bad_clock");
  });

  test("F5 auth requires current provider and generation", () => {
    const missing = collect({
      now: NOW,
      omonyang: bot("omonyang", { provider: null, generation: null, providerError: "invalid_grant", providerErrorGeneration: null }),
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: bot("gajaegun"),
    }).bots.find((item) => item.bot === "omonyang");
    expect(missing.state).not.toBe("auth_required");
  });

  test("F6 unbound pid is not alive", () => {
    const row = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: { observedAt: FRESH, sessionId: "gajaegun-session", pid: 9, pidAlive: false, processAlive: true, source: "pid" },
    }).bots.find((item) => item.bot === "gajaegun");
    expect(row.state).toBe("unconfirmed");
  });

  test("F7 snapshot bot cannot overwrite adapter", () => {
    const report = collect({
      now: NOW,
      omonyang: { ...bot("omonyang"), bot: "dinobot", processAlive: false },
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    });
    expect(report.bots.find((item) => item.bot === "dinobot").state).toBe("idle_or_working");
    expect(report.bots.find((item) => item.bot === "omonyang").state).toBe("fault");
  });

  test("F9 read error does not copy the raw message", () => {
    const report = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot"),
      dori: { readError: "permission denied token=xoxb-do-not-log", body: "secret conversation" },
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain("xoxb-do-not-log");
    expect(text).not.toContain("secret conversation");
    expect(report.bots.find((item) => item.bot === "dori").readError).toBe("unreadable");
  });
  test("generic foreign pid is not bound", () => {
    const foreign = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot"),
      dori: bot("dori", { pid: 9, pidAlive: true, pidSessionId: "other-session" }),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    }).bots.find((item) => item.bot === "dori");
    const matched = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot"),
      dori: bot("dori", { pid: 9, pidAlive: true, pidSessionId: "dori-session" }),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    }).bots.find((item) => item.bot === "dori");
    expect(foreign.state).toBe("unconfirmed");
    expect(matched.state).toBe("idle_or_working");
  });

  test("invalid clock values stay rejected", () => {
    expect(ageClass(FRESH, Date.parse(NOW), Number.NaN)).toBe("unconfirmed");
    expect(ageClass(FRESH, Date.parse(NOW), "2000")).toBe("unconfirmed");
    expect(ageClass(FRESH, Date.parse(NOW), -1)).toBe("unconfirmed");
    expect(ageClass(FRESH, Date.parse(NOW), Number.POSITIVE_INFINITY)).toBe("unconfirmed");
  });
  test("false attribution and missing pidAlive stay unconfirmed", () => {
    const deadForeign = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot"),
      dori: bot("dori", { pid: 9, pidAlive: false, sessionMatchesProcess: false }),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    }).bots.find((item) => item.bot === "dori");
    const missingAlive = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot", { pid: 4, pidAlive: undefined }),
      dori: bot("dori"),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    }).bots.find((item) => item.bot === "dinobot");
    const deadAttributed = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: false, pidSessionId: "gajaegun-session", sessionMatchesProcess: true }),
    }).bots.find((item) => item.bot === "gajaegun");
    const alive = collect({
      now: NOW,
      omonyang: bot("omonyang"),
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    }).bots.find((item) => item.bot === "gajaegun");
    expect(deadForeign.state).toBe("unconfirmed");
    expect(deadForeign.reason).not.toBe("process_absent");
    expect(missingAlive.state).toBe("unconfirmed");
    expect(missingAlive.reason).not.toBe("process_absent");
    expect(deadAttributed.state).toBe("fault");
    expect(deadAttributed.reason).toBe("process_absent");
    expect(alive.state).toBe("idle_or_working");
    expect(attribution({ sessionId: "s", generation: "g", sessionMatchesProcess: false, pid: 9, pidAlive: false }).reason).toBe("process_not_attributed");
    expect(attribution({ sessionId: "s", generation: "g", sessionMatchesProcess: false, pid: 9, pidAlive: false }).processAbsent).toBeUndefined();
  });

  test("future health time is not fresh and is not replaced by collection time", () => {
    const now = Date.parse(NOW);
    expect(healthCheckedAt(now / 1000 + 3600, now).ok).toBe(false);
    expect(healthCheckedAt(now / 1000 - 30, now).ok).toBe(true);
    expect(healthCheckedAt(Number.NaN, now).ok).toBe(false);
  });
  test("bad json shapes fail closed without hiding the original time", () => {
    const now = Date.parse(NOW);
    for (const bad of [null, "text", [], { runtime_pid: 1 }]) {
      expect(acceptHealthRecord(bad, now).ok).toBe(false);
    }
    const future = acceptHealthRecord({ runtime_pid: 1, session_id: "s", checked_at: now / 1000 + 3600 }, now);
    expect(future.ok).toBe(false);
    expect(future.reason).toBe("stale_or_future_health");
  });

  test("metadata allowlist drops nested synthetic markers", () => {
    const report = collect({
      now: NOW,
      omonyang: bot("omonyang", { source: { body: "SYNTH_BODY", code: "SYNTH_CODE" } }),
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain("SYNTH_BODY");
    expect(text).not.toContain("SYNTH_CODE");
    expect(report.bots.find((item) => item.bot === "omonyang").source).toBe(null);
  });

  test("bad health shape isolates one bot", () => {
    const report = collect({
      now: NOW,
      omonyang: null,
      dinobot: bot("dinobot"),
      dori: bot("dori"),
      gajaegun: bot("gajaegun", { pid: 1, pidAlive: true, pidSessionId: "gajaegun-session" }),
    });
    expect(report.bots.find((item) => item.bot === "omonyang").state).toBe("unconfirmed");
    expect(report.bots.filter((item) => item.state === "idle_or_working")).toHaveLength(3);
    expect(report.bots.find((item) => item.bot === "omonyang").readError).toBe("missing");
  });

  test("clock exceptions stay rejected", () => {
    expect(ageClass(FRESH, Date.parse(NOW), { collectionStartedAt: NOW, collectionFinishedAt: FRESH })).toBe("unconfirmed");
    expect(ageClass(FRESH, Date.parse(NOW), { collectionStartedAt: "bad", collectionFinishedAt: NOW })).toBe("unconfirmed");
    expect(ageClass("not-a-time", Date.parse(NOW), windowFor(FRESH))).toBe("unconfirmed");
    expect(ageClass(FRESH, Number.NaN, windowFor(FRESH))).toBe("unconfirmed");
  });

  test("corrupt sqlite open does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-corrupt-"));
    const path = join(dir, "broken.db");
    writeFileSync(path, "not a database");
    expect(openReadonly(path).ok).toBe(false);
  });
});
