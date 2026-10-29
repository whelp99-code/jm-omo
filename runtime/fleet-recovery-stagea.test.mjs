import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openStageStore, settle, transition } from "./fleet-recovery-stagea.mjs";

function db() {
  return openStageStore(join(mkdtempSync(join(tmpdir(), "stagea-")), "state.sqlite"), 1_000);
}

const base = {
  trustedClock: true, nowMs: 1_000, observationKey: '["dori","o","s","g","receiver"]',
  botKey: '["dori","o","runtime-1"]', generation: "g", kind: "notification", independentEpisode: true,
};

describe("stage A durable reducer", () => {
  test("same bot different cause shares one budget", () => {
    const opened = db();
    expect(opened.ok).toBe(true);
    const incident = '["dori","o","runtime-1"]';
    opened.db.query("INSERT INTO incidents VALUES (?,?,?,?,?,NULL,?)").run("I1", "bot", incident, "UNKNOWN", 1000, 1);
    opened.db.query("INSERT INTO aliases VALUES (?,?)").run(base.observationKey, "I1");
    opened.db.query("INSERT INTO bot_locks VALUES (?,?,?)").run(base.botKey, "I1", "g");
    const first = transition(opened.db, { ...base, independentEpisode: false });
    const second = transition(opened.db, { ...base, observationKey: '["dori","o","s","g2","other"]', generation: "g2", independentEpisode: false });
    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(false);
    expect(second.reason).toBe("budget_used");
    opened.db.close();
  });

  test("shared dependency ignores role", () => {
    const opened = db();
    const shared = '["slack","tenant","dependency"]';
    opened.db.query("INSERT INTO incidents VALUES (?,?,?,?,?,NULL,?)").run("P", "shared", shared, "UNKNOWN", 1000, 1);
    opened.db.query("INSERT INTO aliases VALUES (?,?)").run(base.observationKey, "P");
    opened.db.query("INSERT INTO bot_locks VALUES (?,?,?)").run(base.botKey, "P", "g");
    const first = transition(opened.db, { ...base, sharedKey: shared, independentEpisode: false });
    const second = transition(opened.db, { ...base, observationKey: '["dinobot","o","s","g","slack"]', botKey: '["dinobot","o","runtime-2"]', sharedKey: shared, independentEpisode: false });
    expect(first.incidentId).toBe(second.incidentId);
    expect(second.reserved).toBe(false);
    opened.db.close();
  });

  test("untrusted clock and raw independence flag fail closed", () => {
    const opened = db();
    expect(transition(opened.db, { ...base, independentEpisode: false }).reason).toBe("missing_independence_evidence");
    expect(transition(opened.db, { ...base, independentEpisode: "true" }).reason).toBe("missing_independence_evidence");
    expect(transition(opened.db, { ...base, trustedClock: false }).reason).toBe("untrusted_clock");
    opened.db.close();
  });

  test("native db and bad outcome are refused", () => {
    expect(openStageStore("/home/jm/.gajaegun/gajaeway/gateway.db").reason).toBe("native_db_refused");
    const opened = db();
    opened.db.query("INSERT INTO incidents VALUES (?,?,?,?,?,NULL,?)").run("I1", "bot", base.botKey, "UNKNOWN", 1000, 1);
    opened.db.query("INSERT INTO aliases VALUES (?,?)").run(base.observationKey, "I1");
    opened.db.query("INSERT INTO bot_locks VALUES (?,?,?)").run(base.botKey, "I1", "g");
    const prepared = transition(opened.db, { ...base, independentEpisode: false });
    expect(settle(opened.db, prepared.incidentId, "notification", "made_up").reason).toBe("bad_enum");
    expect(settle(opened.db, prepared.incidentId, "notification", "unknown").outcome).toBe("unknown");
    opened.db.close();
  });
  test("empty, duplicate, and raw episode authority fail closed", () => {
    const opened = db();
    opened.db.exec("PRAGMA foreign_keys=OFF");
    opened.db.query("INSERT INTO aliases VALUES (?,?)").run(base.observationKey, "");
    opened.db.exec("PRAGMA foreign_keys=ON");
    expect(transition(opened.db, base).reason).toBe("store_invalid");
    opened.db.query("DELETE FROM aliases");
    const fresh = openStageStore(join(mkdtempSync(join(tmpdir(), "stagea-")), "fresh.sqlite"), 1_000);
    const shared = '["slack","tenant","dependency"]';
    opened.db.query("INSERT INTO incidents VALUES (?,?,?,?,?,NULL,?)").run("P1", "shared", shared, "UNKNOWN", 1000, 1);
    opened.db.query("INSERT INTO incidents VALUES (?,?,?,?,?,NULL,?)").run("P2", "shared", shared, "UNKNOWN", 1000, 1);
    expect(transition(opened.db, { ...base, sharedKey: shared, kind: "recovery" }).reason).toBe("store_invalid");
    expect(transition(fresh.db, { ...base, independentEpisode: true }).reason).toBe("missing_independence_evidence");
    expect(opened.db.query("SELECT COUNT(*) AS n FROM attempts").get().n).toBe(0);
    opened.db.close();
    fresh.db.close();
  });
});
