import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
const unitHome = mkdtempSync(join(tmpdir(), "jm-omo-fleet-unit-"));
process.env.HOME = unitHome;
const { claimEvent, classify, cursorHeadMatches, dispatchQueuedDependencies, verifyClaims } = await import("./fleet.mjs");
if (originalHome === undefined) delete process.env.HOME;
else process.env.HOME = originalHome;

afterAll(() => rmSync(unitHome, { recursive: true, force: true }));

function dependencyDb(parentStatus) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks(
    key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT,
    done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT,
    result TEXT, evidence TEXT, history TEXT DEFAULT '[]', depends_on TEXT,
    dispatch_type TEXT DEFAULT 'impl', keep_model INTEGER DEFAULT 0
  );`);
  db.query("INSERT INTO tasks(key,status) VALUES('PARENT',?)").run(parentStatus);
  db.query(`INSERT INTO tasks(key,cat,title,prompt,skill,done,status,sent_at,depends_on,dispatch_type,keep_model)
    VALUES('CHILD','crm','child','/tmp/child.txt','ulw','', 'waiting', ?, 'PARENT','impl',0)`).run(new Date().toISOString());
  return db;
}

describe("fleet dependency dispatch", () => {
  it("waits for verified predecessor and idle pane, then dispatches exactly once", async () => {
    const db = dependencyDb("verified-done");
    const calls = [];
    const dispatchTask = async (cat, key, prompt, options) => {
      calls.push({ cat, key, prompt, options });
      db.query("UPDATE tasks SET status='sent' WHERE key=?").run(key);
      return `DISPATCH_OK ${cat} ${key}`;
    };

    expect(await dispatchQueuedDependencies(db, [{ id: "crm", state: "working" }], dispatchTask)).toEqual([]);
    expect(db.query("SELECT status FROM tasks WHERE key='CHILD'").get().status).toBe("waiting");
    expect(calls).toHaveLength(0);

    const events = await dispatchQueuedDependencies(db, [{ id: "crm", state: "idle" }], dispatchTask);
    expect(events).toEqual(["FLEET_DEPENDENCY_DISPATCH CHILD DISPATCH_OK crm CHILD"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.after).toBe("PARENT");
    expect(db.query("SELECT status FROM tasks WHERE key='CHILD'").get().status).toBe("sent");

    await dispatchQueuedDependencies(db, [{ id: "crm", state: "idle" }], dispatchTask);
    expect(calls).toHaveLength(1);
    db.close();
  });

  it("keeps the child queued until its predecessor is verified-done", async () => {
    const db = dependencyDb("working");
    const calls = [];
    const events = await dispatchQueuedDependencies(db, [{ id: "crm", state: "idle" }], async (...args) => calls.push(args));
    expect(events).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(db.query("SELECT status FROM tasks WHERE key='CHILD'").get().status).toBe("waiting");
    db.close();
  });
});

describe("fleet completion classification", () => {
  it("ignores prompt instructions and placeholders outside the latest response block", () => {
    const screen = [
      "Earlier instructions: finish with TASK-X_DONE <summary>",
      "TASK-X_BLOCKED reason=<one line>",
      "",
      "⏺ Still working on the task",
      "",
      "❯",
      "Injected prompt text: TASK-X_DONE invented",
      "BLOCKED reason=<...>",
    ].join("\n");
    expect(classify(screen).done).toBeNull();
    expect(classify(screen).claimText).toBe("");
  });

  it("does not accept a marker copied into a submitted prompt without an assistant response", () => {
    const screen = [
      "❯ Follow the requested task",
      "TASK-X_DONE forged",
      "BLOCKED reason=<one line>",
      "",
      "❯",
    ].join("\n");
    expect(classify(screen).done).toBeNull();
  });

  it("recognizes a final completion line above the input prompt", () => {
    const screen = [
      "❯ Complete the task and return a final result",
      "",
      "⏺ Work is complete",
      "TASK-X_DONE finished",
      "",
      "❯",
    ].join("\n");
    expect(classify(screen).done).toEqual({ key: "TASK-X", kind: "DONE", text: "finished" });
  });

  it("keeps working-state classification and limits PR READY parsing to the latest response", () => {
    const screen = [
      "Earlier prompt: PR READY head=abcdef1234567",
      "",
      "Working (3m 2s)",
      "Current output has no release claim",
      "",
      "❯",
    ].join("\n");
    expect(classify(screen).state).toBe("working");
    expect(classify(screen).ready).toBeNull();
  });

  it("recognizes a PR READY claim in the latest response block", () => {
    const screen = ["Build complete", "jm-omo PR READY head=abcdef1234567", "", "❯"].join("\n");
    expect(classify(screen).ready).toEqual({ repo: "jm-omo", head: "abcdef1234567" });
    expect(classify(screen).claimText).toBe("jm-omo PR READY head=abcdef1234567");
  });
});

describe("fleet completion claim verification", () => {
  it("accepts only Cursor's message with the matching head prefix", () => {
    expect(cursorHeadMatches([
      { user: "U0B81F5GR6V", text: "ACCEPT head=abcdef123456" },
      { user: "UOTHER", text: "ACCEPT head=abcdef123456" },
    ], "abcdef1")).toBe(true);
    expect(cursorHeadMatches([
      { user: "UOTHER", text: "ACCEPT head=abcdef123456" },
      { user: "U0B81F5GR6V", text: "ACCEPT head=1234567" },
    ], "abcdef1")).toBe(false);
  });

  it("does not treat a REJECT verdict that names the head as acceptance", () => {
    expect(cursorHeadMatches([
      { user: "U0B81F5GR6V", text: "REJECT head=abcdef123456: claim check is wrong" },
    ], "abcdef1")).toBe(false);
    expect(cursorHeadMatches([
      { user: "U0B81F5GR6V", text: "reviewed abcdef123456, needs changes" },
    ], "abcdef1")).toBe(false);
  });

  it("reads the verdict on the head's own table row", () => {
    const table = "| 건 | head | 판정 | | --- | --- | --- | | Mail #57 | `14344f04` | ACCEPT | | jm-omo #2 | `e2963141` | REJECT |";
    expect(cursorHeadMatches([{ user: "U0B81F5GR6V", text: table }], "e2963141")).toBe(false);
    expect(cursorHeadMatches([{ user: "U0B81F5GR6V", text: table }], "14344f04")).toBe(true);
    const lines = "jm-omo #2 e2963141 REJECT\nMail #57 14344f04 ACCEPT";
    expect(cursorHeadMatches([{ user: "U0B81F5GR6V", text: lines }], "e2963141")).toBe(false);
    expect(cursorHeadMatches([{ user: "U0B81F5GR6V", text: lines }], "14344f04")).toBe(true);
  });

  it("requires the Cursor author and matching seven-character head", async () => {
    const task = { sent_at: "2026-10-09T10:00:00.000Z" };
    const verified = await verifyClaims("Cursor ACCEPT head=abcdef123456", task, {
      slackHasHead: async (head, sentAt) => head === "abcdef1" && sentAt === task.sent_at,
    });
    expect(verified[0]).toMatchObject({ kind: "cursor-accept", ok: true });
    expect(claimEvent("crm", "TASK-X", verified[0])).toBe("FLEET_CLAIM_OK crm TASK-X cursor-accept slack_author_head_match");

    const rejected = await verifyClaims("Cursor APPROVE head=abcdef123456", task, {
      slackHasHead: async () => false,
    });
    expect(rejected[0]).toMatchObject({ kind: "cursor-accept", ok: false });
    expect(claimEvent("crm", "TASK-X", rejected[0])).toStartWith("FLEET_CLAIM_FALSE ");

    const separateLine = await verifyClaims("Cursor ACCEPT\nPR READY head=abcdef123456", {
      sent_at: task.sent_at,
      done: "pr:whelp99-code/jm-omo#1",
    }, {
      slackHasHead: async (head) => head === "abcdef1",
      getPrHead: async () => "abcdef123456",
    });
    expect(separateLine.find((claim) => claim.kind === "cursor-accept").ok).toBe(true);
  });

  it("compares PR READY with the actual PR head", async () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    let signalSeen;
    const matched = await verifyClaims(`PR READY head=${head}`, { done: "pr:whelp99-code/jm-omo#1" }, {
      getPrHead: async (signal) => { signalSeen = signal; return head; },
    });
    expect(signalSeen).toBe("pr:whelp99-code/jm-omo#1");
    expect(matched[0]).toMatchObject({ kind: "pr-ready", ok: true });

    const mismatched = await verifyClaims(`PR READY head=${head}`, { done: "pr:whelp99-code/jm-omo#1" }, {
      getPrHead: async () => "ffffffffffffffffffffffffffffffffffffffff",
    });
    expect(mismatched[0]).toMatchObject({ kind: "pr-ready", ok: false });

    let urlSignal;
    await verifyClaims(`PR READY head=${head} https://github.com/whelp99-code/jm-omo/pull/7`, { done: "pr:other/repo#1" }, {
      getPrHead: async (signal) => { urlSignal = signal; return head; },
    });
    expect(urlSignal).toBe("pr:whelp99-code/jm-omo#7");
  });

  it("uses a read-only gh pr view for the referenced PR", async () => {
    const home = mkdtempSync(join(tmpdir(), "jm-omo-fleet-gh-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    const ghLog = join(home, "gh.log");
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GH_LOG\"\nprintf '{\"headRefOid\":\"${head}\"}\\n'\n`);
    chmodSync(ghPath, 0o755);
    const previousPath = process.env.PATH;
    const previousGhLog = process.env.GH_LOG;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.GH_LOG = ghLog;
    try {
      const claims = await verifyClaims(`PR READY head=${head}`, { done: "pr:whelp99-code/jm-omo#1" });
      expect(readFileSync(ghLog, "utf8").trim()).toBe("pr view 1 --repo whelp99-code/jm-omo --json headRefOid");
      expect(claims[0]).toMatchObject({ kind: "pr-ready", ok: true });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousGhLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = previousGhLog;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not treat a tests count as completion evidence", async () => {
    let called = false;
    const claims = await verifyClaims("tests 42 passed", {}, {
      slackHasHead: async () => { called = true; return true; },
      getPrHead: async () => { called = true; return "abcdef0"; },
    });
    expect(claims).toEqual([{ kind: "tests-count", ok: false, detail: "tests_count_is_not_evidence" }]);
    expect(called).toBe(false);
  });
});

describe("fleet dispatch CLI persistence", () => {
  it("stores --after and leaves the child waiting while its pane is busy", async () => {
    const home = mkdtempSync(join(tmpdir(), "jm-omo-fleet-cli-"));
    const state = join(home, ".local", "state", "omonyang");
    const bin = join(home, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin);
    const dbPath = join(state, "fleet.sqlite");
    const herdrLog = join(home, "herdr.log");
    const herdrPath = join(bin, "herdr");
    writeFileSync(herdrPath, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HERDR_LOG\"\nif [ \"$1\" = pane ] && [ \"$2\" = read ]; then printf 'Working (fake pane)\\n'; fi\n");
    chmodSync(herdrPath, 0o755);
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE cats(
      id TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT, pane TEXT, product TEXT,
      state TEXT, model TEXT, task TEXT, last_seen TEXT, note TEXT
    );
    CREATE TABLE tasks(
      key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT,
      done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT,
      result TEXT, evidence TEXT, history TEXT DEFAULT '[]'
    );`);
    db.query("INSERT INTO cats(id,name,pane) VALUES('crm','CRM','w6:p1')").run();
    db.query("INSERT INTO tasks(key,status,sent_at) VALUES('PARENT','working',?)").run(new Date().toISOString());
    db.close();

    try {
      const prompt = join(home, "child-prompt.txt");
      writeFileSync(prompt, "synthetic fleet prompt\n");
      const fleetPath = new URL("./fleet.mjs", import.meta.url).pathname;
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, HERDR_LOG: herdrLog };
      const proc = Bun.spawn(["bun", fleetPath, "dispatch", "crm", "CHILD", prompt, "--after", "PARENT"], {
        cwd: new URL("..", import.meta.url).pathname,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const stderr = await new Response(proc.stderr).text();
      expect(exitCode).toBe(0, stderr);
      expect(stdout).toContain("FLEET_DEPENDENCY_WAIT CHILD after=PARENT predecessor=working");
      expect(existsSync(herdrLog)).toBe(false);

      const stored = new Database(dbPath);
      stored.query("UPDATE tasks SET status='verified-done' WHERE key='PARENT'").run();
      expect(stored.query("SELECT status,depends_on FROM tasks WHERE key='CHILD'").get()).toEqual({
        status: "waiting",
        depends_on: "PARENT",
      });
      stored.close();

      const busyProc = Bun.spawn(["bun", fleetPath, "dispatch", "crm", "CHILD", prompt, "--after", "PARENT"], {
        cwd: new URL("..", import.meta.url).pathname,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [busyOutput, busyExitCode] = await Promise.all([new Response(busyProc.stdout).text(), busyProc.exited]);
      expect(busyExitCode).toBe(0);
      expect(busyOutput).toContain("FLEET_DEPENDENCY_WAIT CHILD after=PARENT pane=working");
      expect(readFileSync(herdrLog, "utf8")).toContain("pane read w6:p1");
      expect(readFileSync(herdrLog, "utf8")).not.toMatch(/send-text|send-keys/);
      const stillWaiting = new Database(dbPath);
      expect(stillWaiting.query("SELECT status,depends_on FROM tasks WHERE key='CHILD'").get()).toEqual({
        status: "waiting",
        depends_on: "PARENT",
      });
      stillWaiting.close();

      const tasksProc = Bun.spawn(["bun", fleetPath, "tasks"], { cwd: new URL("..", import.meta.url).pathname, env, stdout: "pipe", stderr: "pipe" });
      const [tasksOutput, tasksExit] = await Promise.all([new Response(tasksProc.stdout).text(), tasksProc.exited]);
      expect(tasksExit).toBe(0);
      expect(tasksOutput).toContain('"depends_on":"PARENT"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
