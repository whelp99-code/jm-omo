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
    const first = transition(opened.db, base);
    const second = transition(opened.db, { ...base, observationKey: '["dori","o","s","g","other"]', independentEpisode: false });
    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(false);
    expect(second.reason).toBe("budget_used");
    opened.db.close();
  });

  test("shared dependency ignores role", () => {
    const opened = db();
    const first = transition(opened.db, { ...base, sharedKey: '["slack","tenant","dependency"]' });
    const second = transition(opened.db, { ...base, role: "dinobot", observationKey: '["dinobot","o","s","g","slack"]', botKey: '["dinobot","o","runtime-2"]', sharedKey: '["slack","tenant","dependency"]', independentEpisode: false });
    expect(first.incidentId).toBe(second.incidentId);
    expect(second.reserved).toBe(false);
    opened.db.close();
  });

  test("missing independence and untrusted clock fail closed", () => {
    const opened = db();
    expect(transition(opened.db, { ...base, independentEpisode: false }).reason).toBe("missing_independence_evidence");
    expect(transition(opened.db, { ...base, trustedClock: false }).reason).toBe("untrusted_clock");
    opened.db.close();
  });

  test("native db and bad outcome are refused", () => {
    expect(openStageStore("/home/jm/.gajaegun/gajaeway/gateway.db").reason).toBe("native_db_refused");
    const opened = db();
    const prepared = transition(opened.db, base);
    expect(settle(opened.db, prepared.incidentId, "notification", "made_up").reason).toBe("bad_enum");
    expect(settle(opened.db, prepared.incidentId, "notification", "unknown").outcome).toBe("unknown");
    opened.db.close();
  });
});
