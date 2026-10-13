import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch as watchFs, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELF_POLICY_ENABLED } from "../runtime/usage-policy.mjs";

const originalHome = process.env.HOME;
const unitHome = mkdtempSync(join(tmpdir(), "jm-omo-fleet-unit-"));
process.env.HOME = unitHome;
const { answerPaneQuestion, appendTaskHistory, bugbotLimitEvents, checkDeployHealth, checkSignal, claimEvent, claimPickerRecoveryImmediatelyBeforeEscape, classify, completionBelongsToDispatchAttempt, cursorHeadMatches, dispatch, dispatchQueuedDependencies, dispatchWaitingTasks, fetchSlackThreadReplies, hasListedTests, isReviewRequest, markTaskBlocked, markTaskClosed, markTaskPromptLost, matchPrLoopVerdict, migrateFleetColumns, pairReviewReplies, pollReviewStalls, processPrLoopEvents, questionPolicy, recoverDispatchReservation, recoverInterruptedDispatches, recordDispatchSendAttempt, recordTaskClaimEvidence, reconcileFailedDispatch, reservationLeaseExpiredAndOwned, retryNotDoneTasks, resolveFleetConfig, reviewRequestKeys, reviewRequestThreadRoots, reviewStallDrafts, reviewStallEvents, runDoriHeavyDeploy, shouldSuppressGajae, slackHistoryParams, switchModel, track, verify, verifyClaims } = await import("./fleet.mjs");
if (originalHome === undefined) delete process.env.HOME;
else process.env.HOME = originalHome;

afterAll(() => rmSync(unitHome, { recursive: true, force: true }));

describe("usage-watch policy", () => {
  it("keeps self-policy disabled for the JARVIS pane", () => {
    expect(SELF_POLICY_ENABLED).toBe(false);
  });
});

function unitDb() {
  return new Database(join(unitHome, ".local", "state", "omonyang", "fleet.sqlite"));
}

function prLoopDb(task = null) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks(
    key TEXT PRIMARY KEY, cat TEXT, done TEXT, status TEXT, completion_claimed INTEGER DEFAULT 0,
    claim_evidence TEXT DEFAULT '{}', history TEXT DEFAULT '[]', sent_at TEXT, result TEXT
  );
  CREATE TABLE cats(id TEXT PRIMARY KEY,pane TEXT);
  CREATE TABLE fleet_pr_loop(
    repo TEXT NOT NULL, pr_number TEXT NOT NULL, head TEXT NOT NULL, task_key TEXT NOT NULL,
    state TEXT NOT NULL, request_ts TEXT, verdict TEXT, verdict_ts TEXT, merge_sha TEXT, merge_pending_since TEXT,
    post_lease_token TEXT, post_lease_until TEXT, reject_lease_token TEXT, reject_lease_until TEXT, reject_sent_at TEXT,
    merge_lease_token TEXT, merge_lease_until TEXT,
    deploy_lease_token TEXT, deploy_lease_until TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(repo,pr_number,head)
  );`);
  if (task) {
    db.query(`INSERT INTO tasks(key,cat,done,status,completion_claimed,claim_evidence,history,sent_at,result)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(task.key, task.cat ?? "crm", task.done ?? "", task.status ?? "done-claimed",
        task.completion_claimed ?? 1, task.claim_evidence ?? "{}", task.history ?? "[]",
        task.sent_at ?? "2026-10-12T10:00:00.000Z", task.result ?? "");
    if (task.pane) db.query("INSERT INTO cats(id,pane) VALUES(?,?)").run(task.cat ?? "crm", task.pane);
  }
  return db;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settlesWithin(promise, timeoutMs = 500) {
  let timer;
  return Promise.race([
    promise.then((value) => ({ settled: true, value })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

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

async function runBlockedDispatch(paneScreen) {
  const home = mkdtempSync(join(tmpdir(), `jm-omo-fleet-queue-${paneScreen.toLowerCase().replaceAll(" ", "-")}-`));
  try {
    const state = join(home, ".local", "state", "omonyang");
    const bin = join(home, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin);
    const dbPath = join(state, "fleet.sqlite");
    const prompt = join(home, "prompt.txt");
    const herdrLog = join(home, "herdr.log");
    const herdrPath = join(bin, "herdr");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE cats(
      id TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT, pane TEXT, product TEXT,
      state TEXT, model TEXT, task TEXT, last_seen TEXT, note TEXT
    );
    CREATE TABLE tasks(
      key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT,
      done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT,
      result TEXT, evidence TEXT, history TEXT DEFAULT '[]', completion_claimed INTEGER DEFAULT 0
    );`);
    db.query("INSERT INTO cats(id,name,pane) VALUES('crm','CRM','w6:p1')").run();
    db.close();
    writeFileSync(prompt, "synthetic blocked-pane prompt\n");
    writeFileSync(herdrPath, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HERDR_LOG\"\nif [ \"$1\" = pane ] && [ \"$2\" = read ]; then printf '%s\\n' \"$PANE_SCREEN\"; fi\n");
    chmodSync(herdrPath, 0o755);
    const fleetPath = new URL("./fleet.mjs", import.meta.url).pathname;
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, HERDR_LOG: herdrLog, PANE_SCREEN: paneScreen, FLEET_CAT_CRM_PANE: "w6:p1" };
    const proc = Bun.spawn(["bun", fleetPath, "dispatch", "crm", "CHILD", prompt, "--keep-model"], {
      cwd: new URL("..", import.meta.url).pathname,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const stderr = await new Response(proc.stderr).text();
    const stored = new Database(dbPath);
    const row = stored.query("SELECT status,depends_on,prompt,dispatch_type,keep_model FROM tasks WHERE key='CHILD'").get();
    stored.close();
    const herdrCalls = readFileSync(herdrLog, "utf8").trim().split("\n");
    return { home, stdout, stderr, exitCode, row, herdrCalls };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function runRawUtf8Dispatch() {
  const home = mkdtempSync(join(tmpdir(), "jm-omo-fleet-utf8-"));
  let proc;
  try {
    const state = join(home, ".local", "state", "omonyang");
    const bin = join(home, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin);
    const dbPath = join(state, "fleet.sqlite");
    const prompt = join(home, "prompt.txt");
    const herdrLog = join(home, "herdr.log");
    const sentMark = join(home, "sent-mark");
    const sendBytesPath = join(home, "send-text.bin");
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
    db.close();
    writeFileSync(prompt, "작업 지시문 UTF-8 fixture\n");
    const herdrPath = join(bin, "herdr");
    writeFileSync(herdrPath, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$HERDR_LOG\"",
      "if [ \"$1\" = pane ] && [ \"$2\" = read ]; then",
      "  if [ -f \"$SENT_MARK\" ]; then printf 'Working (1s)\\n❯'; else printf 'Idle\\n❯'; fi",
      "elif [ \"$1\" = pane ] && [ \"$2\" = send-text ]; then",
      "  printf '%s\\000' \"$4\" >> \"$HERDR_SEND_BYTES\"",
      "  : > \"$SENT_MARK\"",
      "fi",
      "",
    ].join("\n"));
    chmodSync(herdrPath, 0o755);
    const fleetPath = new URL("./fleet.mjs", import.meta.url).pathname;
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      HERDR_LOG: herdrLog,
      HERDR_SEND_BYTES: sendBytesPath,
      SENT_MARK: sentMark,
      FLEET_CAT_CRM_PANE: "w6:p1",
    };
    proc = Bun.spawn(["bun", fleetPath, "dispatch", "crm", "UTF8-QA", prompt, "--keep-model"], {
      cwd: new URL("..", import.meta.url).pathname,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    proc = undefined;
    return {
      prompt,
      stdout,
      stderr,
      exitCode,
      sendBytes: existsSync(sendBytesPath) ? readFileSync(sendBytesPath) : null,
    };
  } finally {
    if (proc) {
      proc.kill();
      await proc.exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

async function runFleetCommand({ usageTick = "", prDone = "", checkRuns = [], paneScreen = "Idle\n❯", catTask = "", taskStatus = "working", taskHistory = [], dispatchAttempt = "", taskSentAt = "", reservation = false, reservationAgeMs = 0, paneReadFailure = false, catState = "working", fleetEnv = {}, waitForOutput = "", trackAfterHeartbeat = false, failFirstQuestionAnswer = false, command = ["watch", "1"] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "jm-omo-fleet-alerts-"));
  const state = join(home, ".local", "state", "omonyang");
  const bin = join(home, "bin");
  const usageDir = join(home, ".omo", "omonyang");
  mkdirSync(state, { recursive: true });
  mkdirSync(bin);
  mkdirSync(usageDir, { recursive: true });
  const dbPath = join(state, "fleet.sqlite");
  const herdrLog = join(home, "herdr.log");
  const ghLog = join(home, "gh.log");
  const firstAnswerFailedPath = join(home, "first-answer-failed");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE cats(
    id TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT, pane TEXT, product TEXT,
    state TEXT, model TEXT, task TEXT, last_seen TEXT, note TEXT
  );
  CREATE TABLE tasks(
    key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT,
    done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT,
    result TEXT, evidence TEXT, history TEXT DEFAULT '[]', completion_claimed INTEGER DEFAULT 0,
    send_attempted INTEGER DEFAULT 0, dispatch_attempt TEXT
  );
  CREATE TABLE beats(who TEXT PRIMARY KEY, at TEXT, detail TEXT);
  CREATE TABLE dispatch_reservations(pane TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,attempt TEXT NOT NULL,reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const taskKey = catTask || (prDone ? "PR-TASK" : "");
  if (taskKey && !trackAfterHeartbeat) db.query("INSERT INTO tasks(key,cat,title,done,status,sent_at,history) VALUES(?,'crm',?,?,?,?,?)")
    .run(taskKey, taskKey, prDone, taskStatus, new Date().toISOString(), JSON.stringify(taskHistory));
  if (taskKey && taskSentAt) db.query("UPDATE tasks SET sent_at=? WHERE key=?").run(taskSentAt, taskKey);
  if (taskKey && dispatchAttempt) db.query("UPDATE tasks SET dispatch_attempt=?,send_attempted=1,sent_at=? WHERE key=?")
    .run(dispatchAttempt, taskSentAt || new Date(Date.now() + 1000).toISOString(), taskKey);
  db.query("INSERT INTO cats(id,name,role,kind,pane,product,state,task) VALUES('crm','CRM','test','pane','w6:p1','fixture',?,?)").run(catState, trackAfterHeartbeat ? null : taskKey || null);
  if (reservation && taskKey) {
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES('w6:p1',?,?,?)")
      .run(taskKey, dispatchAttempt || "fixture-attempt", new Date(Date.now() - reservationAgeMs).toISOString());
  }
  db.close();
  writeFileSync(join(usageDir, "usage-watch.log"), usageTick ? `${usageTick}\n` : "");
  const herdrPath = join(bin, "herdr");
  const pgrepPath = join(bin, "pgrep");
  const journalPath = join(bin, "journalctl");
  const ghPath = join(bin, "gh");
  const gitPath = join(bin, "git");
  writeFileSync(herdrPath, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HERDR_LOG\"\nif [ \"$1\" = pane ] && [ \"$2\" = read ]; then [ \"$PANE_READ_FAILURE\" = 1 ] && exit 1; printf '%s\\n' \"$PANE_SCREEN\"; elif [ \"$1\" = pane ] && [ \"$2\" = send-text ] && [ \"$FAIL_FIRST_ANSWER\" = 1 ] && [ ! -f \"$FIRST_ANSWER_FAILED\" ]; then : > \"$FIRST_ANSWER_FAILED\"; exit 1; fi\n");
  writeFileSync(pgrepPath, "#!/bin/sh\nexit 0\n");
  writeFileSync(journalPath, "#!/bin/sh\nexit 0\n");
  writeFileSync(gitPath, "#!/bin/sh\nif [ \"$1\" = remote ] && [ \"$2\" = get-url ] && [ \"$3\" = origin ]; then printf 'https://github.com/whelp99-code/jm-omo.git\\n'; elif [ \"$1\" = branch ] && [ \"$2\" = --show-current ]; then printf 'fixture-branch\\n'; else exit 2; fi\n");
  writeFileSync(ghPath, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GH_LOG\"\ncase \"$1:$2:$3\" in\n  pr:view:2) printf '%s\\n' \"$GH_PR2_JSON\" ;;\n  pr:view:*) printf '%s\\n' \"$GH_PR_JSON\" ;;\n  pr:list:*) printf '%s\\n' \"$GH_PR_LIST_JSON\" ;;\n  api:*) printf '%s\\n' \"$GH_CHECK_RUNS_JSON\" ;;\n  *) exit 2 ;;\nesac\n");
  for (const path of [herdrPath, pgrepPath, journalPath, ghPath, gitPath]) chmodSync(path, 0o755);

  const env = {
    ...process.env,
    FLEET_CAT_CRM_PANE: "w6:p1",
    ...fleetEnv,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    HERDR_LOG: herdrLog,
    GH_LOG: ghLog,
    PANE_SCREEN: paneScreen,
    PANE_READ_FAILURE: paneReadFailure ? "1" : "0",
    FAIL_FIRST_ANSWER: failFirstQuestionAnswer ? "1" : "0",
    FIRST_ANSWER_FAILED: firstAnswerFailedPath,
    GH_PR_JSON: JSON.stringify({ number: 77, title: "Fixture review", state: "OPEN", isDraft: true, url: "https://github.com/whelp99-code/jm-omo/pull/77", headRefOid: "abcdef0123456789abcdef0123456789abcdef01", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [] }),
    GH_PR2_JSON: JSON.stringify({ number: 2, title: "Prior fleet work", state: "OPEN", isDraft: true, url: "https://github.com/whelp99-code/jm-omo/pull/2", headRefOid: "e2963141674beffb244e237b7a6e3cc29fb08f56", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [] }),
    GH_PR_LIST_JSON: "[]",
    GH_CHECK_RUNS_JSON: JSON.stringify({ check_runs: checkRuns }),
  };
  let watcher;
  let heartbeatTimeout;
  let outputTimeout;
  let proc;
  try {
    let heartbeat;
    if (command[0] === "watch") {
      heartbeat = new Promise((resolve, reject) => {
        heartbeatTimeout = setTimeout(() => reject(new Error("watch heartbeat timeout")), 5000);
        watcher = watchFs(state, (_event, filename) => {
          if (filename?.toString() === "captain-heartbeat.json") resolve();
        });
      });
    }
    const fleetPath = new URL("./fleet.mjs", import.meta.url).pathname;
    proc = Bun.spawn(["bun", fleetPath, ...command], { cwd: new URL("..", import.meta.url).pathname, env, stdout: "pipe", stderr: "pipe" });
    let outputPromise;
    if (waitForOutput) {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      outputPromise = (async () => {
        let output = "";
        while (!output.includes(waitForOutput)) {
          const { value, done } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
        }
        reader.releaseLock();
        return output;
      })();
      outputTimeout = setTimeout(() => proc?.kill(), 5000);
    } else {
      outputPromise = new Response(proc.stdout).text();
    }
    const stderrPromise = new Response(proc.stderr).text();
    if (heartbeat) {
      await heartbeat;
      clearTimeout(heartbeatTimeout);
      if (trackAfterHeartbeat) {
        const assigning = new Database(dbPath);
        assigning.query("INSERT INTO tasks(key,cat,title,status,sent_at,history) VALUES(?,'crm',?,'tracked-unconfirmed',?,'[]')")
          .run(taskKey, taskKey, new Date().toISOString());
        assigning.query("UPDATE cats SET task=? WHERE id='crm'").run(taskKey);
        assigning.close();
      }
      if (waitForOutput) await outputPromise;
      proc.kill();
    }
    const [output, stderr, exitCode] = await Promise.all([outputPromise, stderrPromise, proc.exited]);
    proc = undefined;
    const herdrCalls = existsSync(herdrLog) ? readFileSync(herdrLog, "utf8").trim().split("\n") : [];
    const stored = new Database(dbPath);
    const storedTask = taskKey ? stored.query("SELECT status,sent_at,history,dispatch_attempt,send_attempted FROM tasks WHERE key=?").get(taskKey) : null;
    const storedTaskStatus = storedTask?.status ?? null;
    const storedTaskHistory = JSON.parse(storedTask?.history || "[]");
    const storedCatPane = stored.query("SELECT pane FROM cats WHERE id='crm'").get()?.pane ?? null;
    const reservationLeft = taskKey ? Boolean(stored.query("SELECT key FROM dispatch_reservations WHERE key=?").get(taskKey)) : false;
    stored.close();
    return {
      output,
      stderr,
      exitCode,
      taskStatus: storedTaskStatus,
      taskSentAt: storedTask?.sent_at ?? null,
      taskDispatchAttempt: storedTask?.dispatch_attempt ?? null,
      taskSendAttempted: storedTask?.send_attempted ?? 0,
      taskHistory: storedTaskHistory,
      catPane: storedCatPane,
      reservationLeft,
      ghCalls: existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n") : [],
      herdrCalls,
      herdrWrites: herdrCalls.filter((line) => /^pane send-(?:text|keys) /.test(line)),
    };
  } finally {
    clearTimeout(heartbeatTimeout);
    clearTimeout(outputTimeout);
    watcher?.close();
    if (proc) {
      proc.kill();
      await proc.exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

async function runWatchCycle(options = {}) {
  return runFleetCommand({ ...options, command: ["watch", "1"] });
}

async function runFleetBoard(options = {}) {
  return runFleetCommand({ ...options, command: ["board"] });
}

describe("fleet configuration", () => {
  it("loads pane defaults into init and applies the documented environment overrides", async () => {
    const defaults = JSON.parse(readFileSync(new URL("./fleet.config.json", import.meta.url), "utf8"));
    const config = resolveFleetConfig(defaults, {
      FLEET_CAT_CRM_PANE: "w9:p4",
      FLEET_SLACK_REVIEW_CHANNEL: "C_TEST",
      FLEET_CURSOR_USER_ID: "U_TEST",
      FLEET_REVIEW_REPLY_APP_ID: "A_TEST",
      FLEET_AGENT_MESSENGER_CREDENTIAL_PATH: "/tmp/credential-manager.js",
    });
    expect(config.cats.find((cat) => cat.id === "crm").pane).toBe("w9:p4");
    expect(config.slack).toEqual({
      reviewChannel: "C_TEST",
      cursorUserId: "U_TEST",
      reviewReplyAppId: "A_TEST",
    });
    expect(defaults.prLoop).toMatchObject({
      enabled: false,
      autoMerge: false,
      reviewChannel: "C0C5Z4SJ309",
      reviewThreadTs: "1791757469.519659",
      deploy: {},
    });
    expect(resolveFleetConfig(defaults, {
      FLEET_PR_LOOP_ENABLED: "true",
      FLEET_PR_LOOP_AUTO_MERGE: "true",
    }).prLoop).toMatchObject({ enabled: true, autoMerge: true });
    expect(config.agentMessengerCredentialPath).toBe("/tmp/credential-manager.js");
    const panes = Object.fromEntries(defaults.cats.map((cat) => [cat.id, cat.pane]));
    expect(panes).toMatchObject({
      omonyang: "w3:p2",
      gajae: "w2:p1",
      jarvis: "w5:p1",
      sb: "w5:p2",
      price: "w5:p3",
      crm: "w5:p4",
      mail: "w5:p5",
      omodev: "-",
      jarvis2: "-",
    });
    expect(defaults.agentMessengerCredentialPath.startsWith("/")).toBe(true);

    const initialized = await runFleetCommand({
      command: ["init"],
      fleetEnv: { FLEET_CAT_CRM_PANE: "w9:p4" },
    });
    expect(initialized.exitCode).toBe(0);
    expect(initialized.catPane).toBe("w9:p4");
  });

  it("uses the configured captain pane for dispatch writes despite a stale database pane", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "captain-pane-prompt.txt");
    writeFileSync(prompt, "captain pane config fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('omonyang','Captain','w5:p1')").run();
    db.close();
    let sent = false;
    const calls = [];
    const result = await dispatch("omonyang", "CAPTAIN-PANE-CONFIG", prompt, {
      keepModel: true,
      sleep: async () => {},
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[2] === "send-keys" && argv[4] === "Enter") sent = true;
        return {
          exitCode: 0,
          stdout: argv[2] === "read" ? sent ? "Working (1s)\n❯" : "Idle\n❯" : "",
        };
      },
    });
    expect(result).toContain("DISPATCH_OK omonyang CAPTAIN-PANE-CONFIG");
    expect(calls.filter((argv) => argv[2] === "read" || argv[2] === "send-text" || argv[2] === "send-keys")
      .every((argv) => argv[3] === "w3:p2")).toBe(true);
    expect(calls.some((argv) => argv[3] === "w5:p1")).toBe(false);
  });
});

describe("fleet PR automation", () => {
  const signal = "pr:owner/repo#52";
  const head = "0123456789abcdef0123456789abcdef01234567";
  const threadTs = "1791757469.519659";
  const prLoopConfig = { enabled: true, autoMerge: false, reviewChannel: "C0C5Z4SJ309", reviewThreadTs: threadTs, deploy: {} };

  it("does no PR-loop I/O with the default-off switch", async () => {
    const db = prLoopDb({ key: "PRLOOP-DISABLED", done: signal });
    let calls = 0;
    expect(await processPrLoopEvents(db, { ...prLoopConfig, enabled: false }, {
      runCommand: async () => { calls++; throw new Error("must remain disabled"); },
      postMessage: async () => { calls++; return { ok: true, ts: "1" }; },
      fetchReplies: async () => { calls++; return []; },
    })).toEqual([]);
    expect(calls).toBe(0);
    expect(db.query("SELECT COUNT(*) AS count FROM fleet_pr_loop").get().count).toBe(0);
    db.close();
  });

  it("marks a tested draft ready and posts one thread request per repo PR head", async () => {
    const db = prLoopDb({ key: "PRLOOP-REQUEST", done: signal });
    let isDraft = true;
    let replyPoll = 0;
    const ghCalls = [];
    const posts = [];
    const runCommand = async (argv) => {
      ghCalls.push(argv);
      if (argv[1] === "pr" && argv[2] === "view") return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN", isDraft, headRefOid: head, url: "https://github.com/owner/repo/pull/52",
          body: "## Tests\n- bun test fleet/\n- 210 pass, 0 fail\n",
        }),
      };
      if (argv[1] === "pr" && argv[2] === "ready") {
        isDraft = false;
        return { exitCode: 0, stdout: "" };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    };
    const io = {
      runCommand,
      fetchReplies: async () => {
        replyPoll++;
        return replyPoll === 1 ? [{
          ts: "1791757469.521000", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
          text: `ACCEPT owner/repo#52 head=${head}`,
        }] : [];
      },
      postMessage: async (channel, thread, text) => {
        posts.push({ channel, thread, text });
        return { ok: true, ts: "1791757469.520000" };
      },
    };
    const first = await processPrLoopEvents(db, prLoopConfig, io);
    const second = await processPrLoopEvents(db, prLoopConfig, io);
    expect(first).toEqual([`FLEET_PR_REVIEW_REQUESTED PRLOOP-REQUEST ${signal} head=${head} request_ts=1791757469.520000`]);
    expect(second).toEqual([`FLEET_PR_ACCEPTED PRLOOP-REQUEST ${signal} head=${head} auto_merge=disabled`]);
    expect(ghCalls.filter((argv) => argv[1] === "pr" && argv[2] === "ready")).toHaveLength(1);
    expect(ghCalls.some((argv) => argv[1] === "pr" && argv[2] === "merge")).toBe(false);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C0C5Z4SJ309", thread: threadTs });
    expect(posts[0].text.startsWith("서윤아, Cursor 검수 요청 ")).toBe(true);
    expect(posts[0].text).toContain("https://github.com/owner/repo/pull/52");
    expect(posts[0].text).toContain(head);
    expect(posts[0].text).toContain("owner/repo#52");
    expect(posts[0].text.endsWith("[<@U0B81F5GR6V> 서윤]")).toBe(true);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    const acceptedEvidence = JSON.parse(db.query("SELECT claim_evidence FROM tasks WHERE key='PRLOOP-REQUEST'").get().claim_evidence);
    expect(acceptedEvidence[signal]["cursor-accept"])
      .toMatchObject({ ok: true, head, acceptedPrefix: head, actualHead: head });
    db.close();
  });

  it("does not mark a draft ready or request review without listed tests", async () => {
    const db = prLoopDb({ key: "PRLOOP-NO-TESTS", done: signal });
    const calls = [];
    const events = await processPrLoopEvents(db, prLoopConfig, {
      runCommand: async (argv) => {
        calls.push(argv);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ state: "OPEN", isDraft: true, headRefOid: head, url: "https://github.com/owner/repo/pull/52", body: "Work is done." }),
        };
      },
      postMessage: async () => { throw new Error("must not post"); },
      fetchReplies: async () => [],
    });
    expect(events).toEqual([]);
    expect(calls.some((argv) => argv[1] === "pr" && argv[2] === "ready")).toBe(false);
    expect(db.query("SELECT COUNT(*) AS count FROM fleet_pr_loop").get().count).toBe(0);
    expect(hasListedTests("## Tests\n- bun test fleet/\n")).toBe(false);
    expect(hasListedTests("## Tests\n- bun test fleet/\n- 210 pass, 0 fail\n")).toBe(true);
    expect(hasListedTests("## Tests\nNot run\n")).toBe(false);
    expect(hasListedTests("## Test Plan\n- Not run (environment unavailable)\n")).toBe(false);
    db.close();
  });

  it("keeps an administrator draft hold while awaiting Cursor review", async () => {
    const db = prLoopDb({ key: "PRLOOP-ADMIN-DRAFT-HOLD", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-ADMIN-DRAFT-HOLD','awaiting-review','100','1')`).run(head);
    let readyCalls = 0;
    const events = await processPrLoopEvents(db, prLoopConfig, {
      fetchReplies: async () => [{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
        text: `ACCEPT owner/repo#52 head=${head}`,
      }],
      runCommand: async (argv) => {
        if (argv[2] === "ready") readyCalls++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN", isDraft: true, headRefOid: head, body: "Tests: 210 pass, 0 fail",
          }),
        };
      },
    });
    expect(readyCalls).toBe(0);
    expect(events).toEqual([]);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("awaiting-review");
    db.close();
  });

  it.each([
    "pending",
    "skipped",
    "todo",
    "no tests",
    "not executed",
    "4 passed",
    "0 passed, 0 failed",
    "4 passed, 1 failed",
  ])("does not treat inline Tests: %s as an executed test result", (status) => {
    expect(hasListedTests(`Tests: ${status}`)).toBe(false);
  });

  it.each(["4 passed, 0 failed", "210 pass, 0 fail", "3 tests passed, 0 tests failed"])(
    "accepts inline executed test counts: %s",
    (summary) => expect(hasListedTests(`Testing: ${summary}`)).toBe(true),
  );

  it("rejects a PR head that differs from its full PR READY claim", async () => {
    const otherHead = "ffffffffffffffffffffffffffffffffffffffff";
    const db = prLoopDb({
      key: "PRLOOP-STALE-CLAIM",
      done: signal,
      claim_evidence: JSON.stringify({
        [signal]: { "pr-ready": { ok: true, head: otherHead, actualHead: otherHead, acceptedPrefix: otherHead } },
      }),
    });
    let posted = false;
    const events = await processPrLoopEvents(db, prLoopConfig, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head, url: "https://github.com/owner/repo/pull/52", body: "Tests: bun test fleet/" }),
      }),
      postMessage: async () => { posted = true; return { ok: true, ts: "1" }; },
    });
    expect(events).toEqual([]);
    expect(posted).toBe(false);
    expect(db.query("SELECT COUNT(*) AS count FROM fleet_pr_loop").get().count).toBe(0);
    db.close();
  });

  it("reconciles an exact-head merge after a matching ACCEPT arrives", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const db = prLoopDb({ key: "PRLOOP-HUMAN-MERGE", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-HUMAN-MERGE','awaiting-review','100','1')`).run(head);
    const events = await processPrLoopEvents(db, prLoopConfig, {
      fetchReplies: async () => [{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
        text: `ACCEPT owner/repo#52 head=${head}`,
      }],
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          state: "MERGED", isDraft: false, headRefOid: head,
          mergeCommit: { oid: mergeSha },
        }),
      }),
    });
    expect(events).toContain(`FLEET_PR_ACCEPTED PRLOOP-HUMAN-MERGE ${signal} head=${head} auto_merge=disabled`);
    expect(events).toContain(`FLEET_PR_MERGED PRLOOP-HUMAN-MERGE ${signal} head=${head} merge_sha=${mergeSha}`);
    expect(events).toContain(`FLEET_MERGED_NO_DEPLOY owner=omonyang PRLOOP-HUMAN-MERGE ${signal} head=${head}`);
    expect(db.query("SELECT state,merge_sha FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_sha: mergeSha });
    db.close();
  });

  it("keeps an awaiting-review row when a PR lookup temporarily fails", async () => {
    const db = prLoopDb({ key: "PRLOOP-REVIEW-RETRY", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-REVIEW-RETRY','awaiting-review','100','1')`).run(head);
    let viewCount = 0;
    await processPrLoopEvents(db, prLoopConfig, {
      fetchReplies: async () => [],
      runCommand: async () => {
        viewCount++;
        if (viewCount === 2) return { exitCode: 1, stdout: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head }),
        };
      },
    });
    expect(viewCount).toBe(2);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("awaiting-review");
    db.close();
  });

  it("resolves a closed PR without classifying it as a changed head", async () => {
    const db = prLoopDb({ key: "PRLOOP-CLOSED", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-CLOSED','awaiting-review','100','1')`).run(head);
    await processPrLoopEvents(db, prLoopConfig, {
      fetchReplies: async () => [],
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "CLOSED", isDraft: false, headRefOid: head }),
      }),
    });
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("closed");
    db.close();
  });

  it("accepts only a thread verdict bound to Cursor app user repo and full head", () => {
    const messages = [
      { ts: "101", thread_ts: threadTs, user: "UOTHER", app_id: "A08SKDT6QUW", text: `ACCEPT owner/repo#52 head=${head}` },
      { ts: "102", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "AOTHER", text: `ACCEPT owner/repo#52 head=${head}` },
      { ts: "103", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `ACCEPT other-owner/repo#52 head=${head}` },
      { ts: "104", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: "ACCEPT owner/repo#52 head=01234567" },
      { ts: "105", thread_ts: "different-thread", user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `ACCEPT owner/repo#52 head=${head}` },
    ];
    expect(matchPrLoopVerdict(messages, { repo: "owner/repo", prNumber: "52", head, threadTs, afterTs: "100" })).toBeNull();
    messages.push({ ts: "106", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `ACCEPT owner/repo#52 head=${head}` });
    expect(matchPrLoopVerdict(messages, { repo: "owner/repo", prNumber: "52", head, threadTs, afterTs: "100" }))
      .toEqual({ kind: "accept", text: `ACCEPT owner/repo#52 head=${head}`, ts: "106" });
  });

  it("merges an accepted PR with an exact-head guard and records the merge SHA", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const db = prLoopDb({ key: "PRLOOP-MERGE", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MERGE','awaiting-review','100','1')`).run(head);
    let merged = false;
    const commands = [];
    const events = await processPrLoopEvents(db, { ...prLoopConfig, autoMerge: true }, {
      fetchReplies: async () => [{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
        text: `ACCEPT owner/repo#52 head=${head}`,
      }],
      runCommand: async (argv) => {
        commands.push(argv);
        if (argv[1] === "pr" && argv[2] === "merge") {
          merged = true;
          return { exitCode: 0, stdout: "" };
        }
        if (argv[1] === "pr" && argv[2] === "view") return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head,
            url: "https://github.com/owner/repo/pull/52", body: "Tests: bun test fleet/",
            mergeCommit: merged ? { oid: mergeSha } : null,
          }),
        };
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });
    expect(commands).toContainEqual(["gh", "pr", "merge", "52", "-R", "owner/repo", "--merge", "--match-head-commit", head]);
    expect(events).toContain(`FLEET_PR_MERGED PRLOOP-MERGE ${signal} head=${head} merge_sha=${mergeSha}`);
    expect(events).toContain(`FLEET_MERGED_NO_DEPLOY owner=omonyang PRLOOP-MERGE ${signal} head=${head}`);
    expect(db.query("SELECT state,merge_sha FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_sha: mergeSha });
    db.close();
  });

  it("sends one REJECT follow-up to the task pane and returns it to working", async () => {
    const db = prLoopDb({ key: "PRLOOP-REJECT", cat: "omonyang", done: signal, pane: "w5:p1" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-REJECT','awaiting-review','100','1')`).run(head);
    const sent = [];
    const io = {
      fetchReplies: async () => [{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
        text: `REJECT owner/repo#52 head=${head} please fix the API`,
      }],
      runCommand: async (argv) => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head, url: "https://github.com/owner/repo/pull/52", body: "Tests: bun test fleet/" }),
      }),
      sendFollowup: async (pane, text) => { sent.push({ pane, text }); return true; },
    };
    await processPrLoopEvents(db, prLoopConfig, io);
    await processPrLoopEvents(db, prLoopConfig, io);
    expect(sent).toHaveLength(1);
    expect(sent[0].pane).toBe("w3:p2");
    expect(sent[0].text).toContain(`owner/repo#52 head=${head}`);
    expect(db.query("SELECT status FROM tasks WHERE key='PRLOOP-REJECT'").get().status).toBe("working");
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("rejected");
    const history = JSON.parse(db.query("SELECT history FROM tasks WHERE key='PRLOOP-REJECT'").get().history);
    expect(history.filter((event) => event.ev === "cursor-reject-followup")).toHaveLength(1);
    db.close();
  });

  it("runs configured deploys through Dori heavy and records health outcomes", async () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const db = prLoopDb({ key: "PRLOOP-DEPLOY", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-DEPLOY','merged',?,'1')`).run(head, mergeSha);
    const deployment = { argv: ["./deploy.sh", "--safe"], healthUrl: "https://service.example/health" };
    const finished = deferred();
    let deployCall;
    const lookupCalls = [];
    const events = await processPrLoopEvents(db, {
      ...prLoopConfig,
      deploy: { "owner/repo": deployment },
      deployTimeoutMs: 45_000,
    }, {
      runCommand: async (argv) => {
        lookupCalls.push(argv);
        if (argv[1] === "repo" && argv[2] === "view") {
          return { exitCode: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }) };
        }
        if (argv[1] === "api") {
          return { exitCode: 0, stdout: JSON.stringify({ commit: { sha: mergeSha } }) };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
      runDeploy: async (...args) => { deployCall = args; return { exitCode: 0 }; },
      checkHealth: async (url, timeoutMs, expectedSha) => ({
        status: url === deployment.healthUrl && timeoutMs === 45_000 ? 200 : 500,
        mergeSha: expectedSha,
      }),
      onDeploySettled: finished.resolve,
    });
    expect(events).toEqual([`FLEET_DEPLOY_STARTED PRLOOP-DEPLOY ${signal} merge_sha=${mergeSha}`]);
    expect((await settlesWithin(finished.promise)).settled).toBe(true);
    expect(deployCall).toEqual(["owner/repo", deployment, mergeSha, 45_000]);
    expect(lookupCalls.filter((argv) => argv[1] === "repo" && argv[2] === "view")).toHaveLength(2);
    expect(lookupCalls.filter((argv) => argv[1] === "api").every((argv) =>
      argv[2] === "repos/owner/repo/branches/main")).toBe(true);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deployed");

    let doriArgv;
    expect(await runDoriHeavyDeploy("owner/repo", deployment, mergeSha, 45_000, async (argv) => {
      doriArgv = argv;
      return { exitCode: 0, stdout: "" };
    }, "/test/dori")).toMatchObject({ exitCode: 0 });
    expect(doriArgv).toEqual([
      "bun", "/test/dori", "heavy", "fleet-pr-loop-owner-repo", "--", "timeout", "--signal=TERM",
      "--kill-after=5s", "45s", "env", `FLEET_EXPECTED_MERGE_SHA=${mergeSha}`, "./deploy.sh", "--safe",
    ]);
    db.close();
  });

  it("records failed health checks and merged-no-deploy without a deploy entry", async () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const deployment = { argv: ["./deploy.sh"], healthUrl: "https://service.example/health" };
    const failedDb = prLoopDb({ key: "PRLOOP-DEPLOY-FAIL", done: signal, status: "verified-done" });
    failedDb.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-DEPLOY-FAIL','merged',?,'1')`).run(head, mergeSha);
    const failedFinished = deferred();
    const failed = await processPrLoopEvents(failedDb, {
      ...prLoopConfig,
      deploy: { "owner/repo": { argv: ["./deploy.sh"], healthUrl: "https://service.example/health" } },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => mergeSha,
      runDeploy: async () => ({ exitCode: 0 }),
      checkHealth: async () => ({ status: 503, mergeSha }),
      onDeploySettled: failedFinished.resolve,
    });
    expect(failed[0]).toContain("FLEET_DEPLOY_STARTED PRLOOP-DEPLOY-FAIL");
    expect((await settlesWithin(failedFinished.promise)).value).toContain("FLEET_DEPLOY_FAILED PRLOOP-DEPLOY-FAIL");
    expect(failedDb.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deploy-failed");
    failedDb.close();

    const timeoutDb = prLoopDb({ key: "PRLOOP-DEPLOY-TIMEOUT", done: signal, status: "verified-done" });
    timeoutDb.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-DEPLOY-TIMEOUT','merged',?,'1')`).run(head, mergeSha);
    let healthCalled = false;
    const timedOutFinished = deferred();
    const timedOut = await processPrLoopEvents(timeoutDb, {
      ...prLoopConfig,
      deploy: { "owner/repo": deployment },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => mergeSha,
      runDeploy: async () => ({ exitCode: 124 }),
      checkHealth: async () => { healthCalled = true; return { status: 200, mergeSha }; },
      onDeploySettled: timedOutFinished.resolve,
    });
    expect(timedOut[0]).toContain("FLEET_DEPLOY_STARTED PRLOOP-DEPLOY-TIMEOUT");
    const timedOutEvent = (await settlesWithin(timedOutFinished.promise)).value;
    expect(timedOutEvent).toContain("FLEET_DEPLOY_FAILED PRLOOP-DEPLOY-TIMEOUT");
    expect(timedOutEvent).toContain("deploy_exit_124");
    expect(healthCalled).toBe(false);
    expect(timeoutDb.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deploy-failed");
    timeoutDb.close();

    const noDeployDb = prLoopDb({ key: "PRLOOP-NO-DEPLOY", done: signal, status: "verified-done" });
    noDeployDb.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-NO-DEPLOY','merged',?,'1')`).run(head, mergeSha);
    const noDeploy = await processPrLoopEvents(noDeployDb, prLoopConfig, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
    });
    expect(noDeploy).toEqual([`FLEET_MERGED_NO_DEPLOY owner=omonyang PRLOOP-NO-DEPLOY ${signal} head=${head}`]);
    noDeployDb.close();
  });
});

describe("fleet PR automation", () => {
  const signal = "pr:owner/repo#52";
  const head = "0123456789abcdef0123456789abcdef01234567";
  const threadTs = "1791757469.519659";
  const prLoopConfig = { enabled: true, autoMerge: false, reviewChannel: "C0C5Z4SJ309", reviewThreadTs: threadTs, deploy: {} };

  it("does no PR-loop I/O while disabled by default", async () => {
    const db = prLoopDb({ key: "PRLOOP-DISABLED", done: signal });
    let calls = 0;
    expect(await processPrLoopEvents(db, { ...prLoopConfig, enabled: false }, {
      runCommand: async () => { calls++; throw new Error("must stay disabled"); },
      postMessage: async () => { calls++; return { ok: true, ts: "1" }; },
      fetchReplies: async () => { calls++; return []; },
    })).toEqual([]);
    expect(calls).toBe(0);
    expect(db.query("SELECT COUNT(*) AS count FROM fleet_pr_loop").get().count).toBe(0);
    db.close();
  });

  it("marks a tested draft ready and posts one deduplicated review request", async () => {
    const db = prLoopDb({ key: "PRLOOP-REQUEST", done: signal });
    let isDraft = true;
    const ghCalls = [];
    const posts = [];
    const runCommand = async (argv) => {
      ghCalls.push(argv);
      if (argv[1] === "pr" && argv[2] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN", isDraft, headRefOid: head, url: "https://github.com/owner/repo/pull/52",
            body: "## Tests\n- bun test fleet/\n- 210 pass, 0 fail\n",
          }),
        };
      }
      if (argv[1] === "pr" && argv[2] === "ready") {
        isDraft = false;
        return { exitCode: 0, stdout: "" };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    };
    const io = {
      runCommand,
      fetchReplies: async () => [],
      postMessage: async (channel, thread, text) => {
        posts.push({ channel, thread, text });
        return { ok: true, ts: "1791757469.520000" };
      },
    };
    const first = await processPrLoopEvents(db, prLoopConfig, io);
    const second = await processPrLoopEvents(db, prLoopConfig, io);
    expect(first).toEqual([`FLEET_PR_REVIEW_REQUESTED PRLOOP-REQUEST ${signal} head=${head} request_ts=1791757469.520000`]);
    expect(second).toEqual([]);
    expect(ghCalls.filter((argv) => argv[1] === "pr" && argv[2] === "ready")).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C0C5Z4SJ309", thread: threadTs });
    expect(posts[0].text.startsWith("서윤아, Cursor 검수 요청 ")).toBe(true);
    expect(posts[0].text).toContain("https://github.com/owner/repo/pull/52");
    expect(posts[0].text).toContain(head);
    expect(posts[0].text).toContain("owner/repo#52");
    expect(posts[0].text.endsWith("[<@U0B81F5GR6V> 서윤]")).toBe(true);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("awaiting-review");
    db.close();
  });

  it("leaves a draft untouched without listed tests and rejects a changed PR head", async () => {
    const draftDb = prLoopDb({ key: "PRLOOP-NO-TESTS", done: signal });
    const draftCalls = [];
    const draftEvents = await processPrLoopEvents(draftDb, prLoopConfig, {
      runCommand: async (argv) => {
        draftCalls.push(argv);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN", isDraft: true, headRefOid: head,
            url: "https://github.com/owner/repo/pull/52", body: "Work is done.",
          }),
        };
      },
      postMessage: async () => { throw new Error("must not post"); },
      fetchReplies: async () => [],
    });
    expect(draftEvents).toEqual([]);
    expect(draftCalls.some((argv) => argv[1] === "pr" && argv[2] === "ready")).toBe(false);
    expect(draftDb.query("SELECT COUNT(*) AS count FROM fleet_pr_loop").get().count).toBe(0);
    draftDb.close();

    const changedHead = "ffffffffffffffffffffffffffffffffffffffff";
    const staleDb = prLoopDb({
      key: "PRLOOP-STALE-CLAIM",
      done: signal,
      claim_evidence: JSON.stringify({
        [signal]: { "pr-ready": { ok: true, head: changedHead, actualHead: changedHead, acceptedPrefix: changedHead } },
      }),
    });
    let posted = false;
    const stale = await processPrLoopEvents(staleDb, prLoopConfig, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head, url: "https://github.com/owner/repo/pull/52", body: "Tests: bun test fleet/" }),
      }),
      postMessage: async () => { posted = true; return { ok: true, ts: "1" }; },
    });
    expect(stale).toEqual([]);
    expect(posted).toBe(false);
    expect(staleDb.query("SELECT COUNT(*) AS count FROM fleet_pr_loop").get().count).toBe(0);
    staleDb.close();
  });

  it("starts from a full PR READY claim when no Done PR signal is configured", async () => {
    const db = prLoopDb({
      key: "PRLOOP-READY-ONLY",
      done: "",
      claim_evidence: JSON.stringify({
        [signal]: { "pr-ready": { ok: true, head, actualHead: head, acceptedPrefix: head } },
      }),
    });
    const posted = [];
    const events = await processPrLoopEvents(db, prLoopConfig, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head, url: "https://github.com/owner/repo/pull/52", body: "" }),
      }),
      postMessage: async (_channel, _thread, text) => {
        posted.push(text);
        return { ok: true, ts: "200" };
      },
      fetchReplies: async () => [],
    });
    expect(events).toHaveLength(1);
    expect(posted[0]).toContain(head);
    db.close();

    const shortDb = prLoopDb({
      key: "PRLOOP-READY-SHORT",
      done: "",
      claim_evidence: JSON.stringify({
        [signal]: { "pr-ready": { ok: true, head, actualHead: head, acceptedPrefix: head.slice(0, 8) } },
      }),
    });
    let shortPosted = false;
    expect(await processPrLoopEvents(shortDb, prLoopConfig, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head, url: "https://github.com/owner/repo/pull/52", body: "" }),
      }),
      postMessage: async () => { shortPosted = true; return { ok: true, ts: "201" }; },
    })).toEqual([]);
    expect(shortPosted).toBe(false);
    shortDb.close();
  });

  it("accepts only a thread verdict from the Cursor user and app bound to repo and full head", () => {
    const messages = [
      { ts: "101", thread_ts: threadTs, user: "UOTHER", app_id: "A08SKDT6QUW", text: `ACCEPT owner/repo#52 head=${head}` },
      { ts: "102", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "AOTHER", text: `ACCEPT owner/repo#52 head=${head}` },
      { ts: "103", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `ACCEPT other-owner/repo#52 head=${head}` },
      { ts: "104", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: "ACCEPT owner/repo#52 head=01234567" },
      { ts: "105", thread_ts: "other-thread", user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `ACCEPT owner/repo#52 head=${head}` },
    ];
    expect(matchPrLoopVerdict(messages, { repo: "owner/repo", prNumber: "52", head, threadTs, afterTs: "100" })).toBeNull();
    messages.push({ ts: "106", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `ACCEPT owner/repo#52 head=${head}` });
    expect(matchPrLoopVerdict(messages, { repo: "owner/repo", prNumber: "52", head, threadTs, afterTs: "100" }))
      .toEqual({ kind: "accept", text: `ACCEPT owner/repo#52 head=${head}`, ts: "106" });
  });

  it("merges an accepted PR using an exact head and records its merge SHA", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const db = prLoopDb({ key: "PRLOOP-MERGE", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MERGE','awaiting-review','100','1')`).run(head);
    let merged = false;
    const commands = [];
    const events = await processPrLoopEvents(db, { ...prLoopConfig, autoMerge: true }, {
      fetchReplies: async () => [{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
        text: `ACCEPT owner/repo#52 head=${head}`,
      }],
      runCommand: async (argv) => {
        commands.push(argv);
        if (argv[1] === "pr" && argv[2] === "merge") {
          merged = true;
          return { exitCode: 0, stdout: "" };
        }
        if (argv[1] === "pr" && argv[2] === "view") return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head,
            url: "https://github.com/owner/repo/pull/52", body: "Tests: bun test fleet/",
            mergeCommit: merged ? { oid: mergeSha } : null,
          }),
        };
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });
    expect(commands).toContainEqual(["gh", "pr", "merge", "52", "-R", "owner/repo", "--merge", "--match-head-commit", head]);
    expect(events).toContain(`FLEET_PR_MERGED PRLOOP-MERGE ${signal} head=${head} merge_sha=${mergeSha}`);
    expect(events).toContain(`FLEET_MERGED_NO_DEPLOY owner=omonyang PRLOOP-MERGE ${signal} head=${head}`);
    expect(db.query("SELECT state,merge_sha FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_sha: mergeSha });
    db.close();
  });

  it("sends one rejected verdict to the task pane and returns the task to working", async () => {
    const db = prLoopDb({ key: "PRLOOP-REJECT", cat: "crm", done: signal, pane: "w5:p4" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-REJECT','awaiting-review','100','1')`).run(head);
    const commands = [];
    const io = {
      fetchReplies: async () => [{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
        text: `REJECT owner/repo#52 head=${head} fix the API case`,
      }],
      runCommand: async (argv) => {
        commands.push(argv);
        if (argv[0] === "gh") return {
          exitCode: 0,
          stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head, url: "https://github.com/owner/repo/pull/52", body: "Tests: bun test fleet/" }),
        };
        return { exitCode: 0, stdout: "" };
      },
    };
    await processPrLoopEvents(db, prLoopConfig, io);
    await processPrLoopEvents(db, prLoopConfig, io);
    const sends = commands.filter((argv) => argv[0] === "herdr");
    expect(sends).toEqual([
      ["herdr", "pane", "send-text", "w5:p4", expect.stringContaining(`owner/repo#52 head=${head}`)],
      ["herdr", "pane", "send-keys", "w5:p4", "Enter"],
    ]);
    expect(db.query("SELECT status FROM tasks WHERE key='PRLOOP-REJECT'").get().status).toBe("working");
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("rejected");
    const history = JSON.parse(db.query("SELECT history FROM tasks WHERE key='PRLOOP-REJECT'").get().history);
    expect(history.filter((event) => event.ev === "cursor-reject-followup")).toHaveLength(1);
    db.close();
  });

  it("runs deploys through Dori heavy, checks health, and reports failures", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const deployment = { argv: ["./deploy.sh", "--safe"], healthUrl: "https://service.example/health" };
    const db = prLoopDb({ key: "PRLOOP-DEPLOY", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-DEPLOY','merged',?,'1')`).run(head, mergeSha);
    const finished = deferred();
    let deployCall;
    const events = await processPrLoopEvents(db, {
      ...prLoopConfig, deployTimeoutMs: 45_000, deploy: { "owner/repo": deployment },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => mergeSha,
      runDeploy: async (...args) => { deployCall = args; return { exitCode: 0 }; },
      checkHealth: async (url, timeoutMs, expectedSha) => ({
        status: url === deployment.healthUrl && timeoutMs === 45_000 ? 200 : 500,
        mergeSha: expectedSha,
      }),
      onDeploySettled: finished.resolve,
    });
    expect(events).toEqual([`FLEET_DEPLOY_STARTED PRLOOP-DEPLOY ${signal} merge_sha=${mergeSha}`]);
    expect((await settlesWithin(finished.promise)).settled).toBe(true);
    expect(deployCall).toEqual(["owner/repo", deployment, mergeSha, 45_000]);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deployed");
    db.close();

    const failedDb = prLoopDb({ key: "PRLOOP-DEPLOY-FAIL", done: signal, status: "verified-done" });
    failedDb.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-DEPLOY-FAIL','merged',?,'1')`).run(head, mergeSha);
    const failedFinished = deferred();
    const failed = await processPrLoopEvents(failedDb, {
      ...prLoopConfig, deploy: { "owner/repo": deployment },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => mergeSha,
      runDeploy: async () => ({ exitCode: 0 }),
      checkHealth: async () => ({ status: 503, mergeSha }),
      onDeploySettled: failedFinished.resolve,
    });
    expect(failed[0]).toContain("FLEET_DEPLOY_STARTED PRLOOP-DEPLOY-FAIL");
    expect((await settlesWithin(failedFinished.promise)).value).toContain("FLEET_DEPLOY_FAILED PRLOOP-DEPLOY-FAIL");
    expect(failedDb.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deploy-failed");
    failedDb.close();

    let doriArgv;
    expect(await runDoriHeavyDeploy("owner/repo", deployment, mergeSha, 45_000, async (argv) => {
      doriArgv = argv;
      return { exitCode: 0, stdout: "" };
    }, "/test/dori")).toMatchObject({ exitCode: 0 });
    expect(doriArgv).toEqual([
      "bun", "/test/dori", "heavy", "fleet-pr-loop-owner-repo", "--", "timeout", "--signal=TERM",
      "--kill-after=5s", "45s", "env", `FLEET_EXPECTED_MERGE_SHA=${mergeSha}`, "./deploy.sh", "--safe",
    ]);
  });
});

describe("fleet PR-loop durable recovery and verdict safety", () => {
  const signal = "pr:owner/repo#52";
  const head = "0123456789abcdef0123456789abcdef01234567";
  const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
  const threadTs = "1791757469.519659";
  const config = { enabled: true, autoMerge: false, reviewChannel: "C0C5Z4SJ309", reviewThreadTs: threadTs, deploy: {} };
  const cursorAcceptReplies = async () => [{
    ts: "102", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
    text: `ACCEPT owner/repo#52 head=${head}`,
  }];
  const prInfo = (overrides = {}) => ({
    exitCode: 0,
    stdout: JSON.stringify({
      state: "OPEN", isDraft: false, headRefOid: head,
      url: "https://github.com/owner/repo/pull/52", body: "Tests: bun test fleet/",
      ...overrides,
    }),
  });

  it("adds the verdict column when migrating an existing PR-loop database", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`CREATE TABLE tasks(
      key TEXT PRIMARY KEY, status TEXT, history TEXT DEFAULT '[]',
      completion_claimed INTEGER DEFAULT 0, send_attempted INTEGER DEFAULT 0,
      claim_evidence TEXT DEFAULT '{}'
    );
    CREATE TABLE dispatch_reservations(
      pane TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, attempt TEXT NOT NULL,
      reserved_at TEXT NOT NULL DEFAULT '', recovery_token TEXT, recovery_started_at TEXT
    );
    CREATE TABLE fleet_pr_loop(
      repo TEXT NOT NULL, pr_number TEXT NOT NULL, head TEXT NOT NULL, task_key TEXT NOT NULL,
      state TEXT NOT NULL, request_ts TEXT, verdict_ts TEXT, merge_sha TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(repo,pr_number,head)
    );`);
    migrateFleetColumns(legacy);
    const columns = new Set(legacy.query("PRAGMA table_info(fleet_pr_loop)").all().map((column) => column.name));
    expect(["verdict", "merge_pending_since", "post_lease_token", "post_lease_until", "reject_lease_token", "reject_lease_until", "reject_sent_at", "merge_lease_token", "merge_lease_until", "deploy_lease_token", "deploy_lease_until"]
      .every((column) => columns.has(column))).toBe(true);
    legacy.query("INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,updated_at) VALUES('owner/repo','52',?,'MIGRATED','accepted','ACCEPT','1')")
      .run(head);
    expect(legacy.query("SELECT verdict FROM fleet_pr_loop WHERE head=?").get(head).verdict).toBe("ACCEPT");
    legacy.close();

    const fresh = unitDb();
    expect(new Set(fresh.query("PRAGMA table_info(fleet_pr_loop)").all().map((column) => column.name)).has("verdict")).toBe(true);
    fresh.close();
  });

  it.each(["posting", "post-failed"])("resumes a persisted %s review request", async (state) => {
    const db = prLoopDb({ key: `PRLOOP-${state.toUpperCase()}`, done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,updated_at)
      VALUES('owner/repo','52',?,?,?,'1')`).run(head, `PRLOOP-${state.toUpperCase()}`, state);
    const posted = [];
    const events = await processPrLoopEvents(db, config, {
      runCommand: async () => prInfo(),
      fetchReplies: async () => [],
      postMessage: async (_channel, _thread, text) => {
        posted.push(text);
        return { ok: true, ts: "2026.100" };
      },
    });
    expect(posted).toHaveLength(1);
    expect(events).toContain(`FLEET_PR_REVIEW_REQUESTED PRLOOP-${state.toUpperCase()} ${signal} head=${head} request_ts=2026.100`);
    expect(db.query("SELECT state,request_ts FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "awaiting-review", request_ts: "2026.100" });
    db.close();
  });

  it("reconciles a posting row when Slack already contains its request", async () => {
    const db = prLoopDb({ key: "PRLOOP-POST-ACK-LOST", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-POST-ACK-LOST','posting','1')`).run(head);
    let postCalls = 0;
    const events = await processPrLoopEvents(db, config, {
      runCommand: async () => prInfo(),
      fetchReplies: async () => [
        {
          ts: "2026.100", thread_ts: threadTs, user: "UBOT", app_id: "ABOT",
          text: `서윤아, Cursor 검수 요청 owner/repo#52\nhttps://github.com/owner/repo/pull/52\nhead=${head}\n[<@U0B81F5GR6V> 서윤]`,
        },
        {
          ts: "2026.101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
          text: `ACCEPT owner/repo#52 head=${head}`,
        },
      ],
      postMessage: async () => { postCalls++; throw new Error("duplicate request"); },
    });
    expect(postCalls).toBe(0);
    expect(events).toContain(`FLEET_PR_REVIEW_RECOVERED PRLOOP-POST-ACK-LOST ${signal} head=${head} request_ts=2026.100`);
    expect(events).toContain(`FLEET_PR_ACCEPTED PRLOOP-POST-ACK-LOST ${signal} head=${head} auto_merge=disabled`);
    expect(db.query("SELECT state,request_ts FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "accepted", request_ts: "2026.100" });
    const evidence = JSON.parse(db.query("SELECT claim_evidence FROM tasks WHERE key='PRLOOP-POST-ACK-LOST'").get().claim_evidence);
    expect(evidence[signal]["cursor-accept"]).toMatchObject({ ok: true, head, actualHead: head });
    db.close();
  });

  it.each(["rejecting", "reject-failed"])("replays a persisted %s verdict and clears the completion claim", async (state) => {
    const key = `PRLOOP-${state.toUpperCase()}`;
    const verdict = `REJECT owner/repo#52 head=${head} fix the requested change`;
    const db = prLoopDb({ key, done: signal, status: "done-claimed", completion_claimed: 1 });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,?,?,?,'101','1')`).run(head, key, state, verdict);
    const calls = [];
    const events = await processPrLoopEvents(db, config, {
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[0] === "herdr") return { exitCode: 0, stdout: "" };
        throw new Error(`unexpected command ${argv.join(" ")}`);
      },
      fetchReplies: async () => [],
    });
    expect(calls.map((argv) => argv.slice(0, 3))).toEqual([
      ["herdr", "pane", "send-text"],
      ["herdr", "pane", "send-keys"],
    ]);
    expect(events).toContain(`FLEET_PR_REJECT_FOLLOWUP ${key} ${signal} head=${head}`);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("rejected");
    expect(db.query("SELECT status,completion_claimed FROM tasks WHERE key=?").get(key))
      .toEqual({ status: "working", completion_claimed: 0 });
    db.close();
  });

  it("claims a recovered REJECT once across overlapping watch instances", async () => {
    const original = process.env.HOME;
    let secondWorker;
    try {
      process.env.HOME = unitHome;
      secondWorker = await import(`./fleet.mjs?reject-worker=${crypto.randomUUID()}`);
    } finally {
      if (original === undefined) delete process.env.HOME;
      else process.env.HOME = original;
    }
    const key = "PRLOOP-REJECT-LEASE";
    const verdict = `REJECT owner/repo#52 head=${head} fix this`;
    const db = prLoopDb({ key, done: signal, status: "done-claimed", completion_claimed: 1 });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-REJECT-LEASE','reject-failed',?,'101','1')`).run(head, verdict);
    const sendStarted = deferred();
    const releaseSend = deferred();
    let firstSends = 0;
    let secondSends = 0;
    const firstCycle = processPrLoopEvents(db, config, {
      runCommand: async () => { throw new Error("stored rejection should not need PR lookup"); },
      sendFollowup: async () => { firstSends++; sendStarted.resolve(); return releaseSend.promise; },
    });
    try {
      expect((await settlesWithin(sendStarted.promise)).settled).toBe(true);
      await secondWorker.processPrLoopEvents(db, config, {
        runCommand: async () => { throw new Error("stored rejection should not need PR lookup"); },
        sendFollowup: async () => { secondSends++; return true; },
      });
      expect(firstSends).toBe(1);
      expect(secondSends).toBe(0);
      const claimed = db.query("SELECT state,reject_lease_token,reject_sent_at FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head);
      expect(claimed.state).toBe("rejecting");
      expect(claimed.reject_lease_token).toBeString();
      expect(claimed.reject_sent_at).toBeNull();
    } finally {
      releaseSend.resolve(true);
    }
    expect((await settlesWithin(firstCycle)).settled).toBe(true);
    const sent = db.query("SELECT state,reject_lease_token,reject_sent_at FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head);
    expect(sent.state).toBe("rejected");
    expect(sent.reject_lease_token).toBeNull();
    expect(sent.reject_sent_at).toBeString();
    db.close();
  });

  it("retries a merging row after restart instead of abandoning it", async () => {
    const db = prLoopDb({ key: "PRLOOP-MERGING-RECOVERY", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MERGING-RECOVERY','merging','ACCEPT','101','1')`).run(head);
    let merged = false;
    const commands = [];
    const events = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: cursorAcceptReplies,
      runCommand: async (argv) => {
        commands.push(argv);
        if (argv[1] === "pr" && argv[2] === "merge") {
          merged = true;
          return { exitCode: 0, stdout: "" };
        }
        if (argv[1] === "pr" && argv[2] === "view") return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head,
            mergeCommit: merged ? { oid: mergeSha } : null,
          }),
        };
        throw new Error(`unexpected command ${argv.join(" ")}`);
      },
    });
    expect(commands.some((argv) => argv[1] === "pr" && argv[2] === "merge")).toBe(true);
    expect(events).toContain(`FLEET_PR_MERGED PRLOOP-MERGING-RECOVERY ${signal} head=${head} merge_sha=${mergeSha}`);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("merged-no-deploy");
    db.close();
  });

  it("preserves accepted state after a transient merge-phase PR lookup failure", async () => {
    const db = prLoopDb({ key: "PRLOOP-MERGE-RETRY", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MERGE-RETRY','accepted','ACCEPT','101','1')`).run(head);
    let viewCount = 0;
    let merged = false;
    const runCommand = async (argv) => {
      if (argv[1] === "pr" && argv[2] === "view") {
        viewCount++;
        if (viewCount === 3) return { exitCode: 1, stdout: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head,
            mergeCommit: merged ? { oid: mergeSha } : null,
          }),
        };
      }
      if (argv[1] === "pr" && argv[2] === "merge") {
        merged = true;
        return { exitCode: 0, stdout: "" };
      }
      throw new Error(`unexpected command ${argv.join(" ")}`);
    };
    await processPrLoopEvents(db, { ...config, autoMerge: true }, { runCommand, fetchReplies: cursorAcceptReplies });
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    await processPrLoopEvents(db, { ...config, autoMerge: true }, { runCommand, fetchReplies: cursorAcceptReplies });
    expect(merged).toBe(true);
    expect(db.query("SELECT state,merge_sha FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_sha: mergeSha });
    db.close();
  });

  it("keeps the PR-loop cycle alive when the accepted-head lookup fails", async () => {
    const db = prLoopDb({ key: "PRLOOP-ACCEPTED-LOOKUP-FAIL", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-ACCEPTED-LOOKUP-FAIL','accepted','ACCEPT','101','1')`).run(head);
    let viewCount = 0;
    const events = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: async () => [],
      runCommand: async (argv) => {
        if (argv[1] !== "pr" || argv[2] !== "view") throw new Error(`unexpected command ${argv.join(" ")}`);
        viewCount++;
        if (viewCount === 2) return { exitCode: 1, stdout: "" };
        return { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head }) };
      },
    });
    expect(viewCount).toBe(2);
    expect(events).toEqual([]);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    db.close();
  });

  it("rechecks an exit-zero auto-merge pending on a later cycle", async () => {
    const db = prLoopDb({ key: "PRLOOP-CHECKS-PENDING", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-CHECKS-PENDING','accepted','ACCEPT','101','1')`).run(head);
    let mergeCalls = 0;
    let viewsAfterMerge = 0;
    let merged = false;
    const runCommand = async (argv) => {
      if (argv[1] === "pr" && argv[2] === "merge") {
        mergeCalls++;
        return { exitCode: 0, stdout: "" };
      }
      if (argv[1] === "pr" && argv[2] === "view") {
        if (mergeCalls) viewsAfterMerge++;
        if (viewsAfterMerge > 1) merged = true;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head,
            mergeCommit: merged ? { oid: mergeSha } : null,
          }),
        };
      }
      throw new Error(`unexpected command ${argv.join(" ")}`);
    };
    const first = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      runCommand, fetchReplies: cursorAcceptReplies,
    });
    expect(first.some((event) => event.startsWith("FLEET_PR_MERGE_PENDING PRLOOP-CHECKS-PENDING"))).toBe(true);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("merge-pending");
    const second = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      runCommand, fetchReplies: cursorAcceptReplies,
    });
    expect(mergeCalls).toBe(1);
    expect(second).toContain(`FLEET_PR_MERGED PRLOOP-CHECKS-PENDING ${signal} head=${head} merge_sha=${mergeSha}`);
    expect(db.query("SELECT state,merge_sha FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_sha: mergeSha });
    db.close();
  });

  it("does not throw when auto-merge PR info is temporarily unavailable", async () => {
    const db = prLoopDb({ key: "PRLOOP-AUTO-MERGE-LOOKUP-FAIL", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-AUTO-MERGE-LOOKUP-FAIL','accepted','ACCEPT','101','1')`).run(head);
    let viewCalls = 0;
    const events = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: async () => [],
      runCommand: async (argv) => {
        if (argv[1] !== "pr" || argv[2] !== "view") throw new Error(`unexpected command ${argv.join(" ")}`);
        if (++viewCalls === 2) return { exitCode: 1, stdout: "" };
        return { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head }) };
      },
    });
    expect(events).toEqual([]);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    db.close();
  });

  it("persists ACCEPT evidence that lets verify() reach verified-done", async () => {
    const key = `PRLOOP-VERIFY-ACCEPT-${crypto.randomUUID()}`;
    const db = unitDb();
    db.query(`INSERT INTO tasks(key,cat,title,done,status,sent_at,history,completion_claimed,claim_evidence)
      VALUES(?,'crm',?,?,'done-claimed','2026-10-12T10:00:00.000Z','[]',1,?)`)
      .run(key, key, signal, JSON.stringify({
        [signal]: { "pr-ready": { ok: true, head, actualHead: head, acceptedPrefix: head } },
      }));
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('owner/repo','52',?,?,'awaiting-review','100','1')`).run(head, key);
    await processPrLoopEvents(db, config, {
      fetchReplies: async () => [{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
        text: `ACCEPT owner/repo#52 head=${head}`,
      }],
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
    });
    const claimEvidence = JSON.parse(db.query("SELECT claim_evidence FROM tasks WHERE key=?").get(key).claim_evidence);
    expect(claimEvidence[signal]["cursor-accept"])
      .toMatchObject({ ok: true, head, acceptedPrefix: head, actualHead: head });
    const result = await verify(key, async () => ({
      ok: true, detail: "merged", headRefOid: head, mergeCommit: { oid: mergeSha },
    }));
    expect(result).toContain("VERIFIED_DONE");
    expect(db.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("verified-done");
    db.close();
  });

  it("resumes a deployment row left in deploying after process restart", async () => {
    const db = prLoopDb({ key: "PRLOOP-DEPLOY-RECOVERY", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-DEPLOY-RECOVERY','deploying',?,'1')`).run(head, mergeSha);
    const finished = deferred();
    let deployedSha;
    const events = await processPrLoopEvents(db, {
      ...config,
      deploy: { "owner/repo": { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" } },
    }, {
      getMainSha: async () => mergeSha,
      runDeploy: async (_repo, _deploy, sha) => { deployedSha = sha; return { exitCode: 0 }; },
      checkHealth: async (_url, _timeout, sha) => ({ status: 200, mergeSha: sha }),
      onDeploySettled: finished.resolve,
    });
    expect(events).toContain(`FLEET_DEPLOY_STARTED PRLOOP-DEPLOY-RECOVERY ${signal} merge_sha=${mergeSha}`);
    expect((await settlesWithin(finished.promise)).settled).toBe(true);
    expect(deployedSha).toBe(mergeSha);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deployed");
    db.close();
  });

  it("moves an expired deploying row to needs-attention when config is removed", async () => {
    const key = "PRLOOP-DEPLOY-CONFIG-REMOVED";
    const db = prLoopDb({ key, done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,deploy_lease_token,deploy_lease_until,updated_at)
      VALUES('owner/repo','52',?,?,'deploying',?,'expired-lease','2020-01-01T00:00:00.000Z','1')`)
      .run(head, key, mergeSha);
    const events = await processPrLoopEvents(db, config, { runCommand: async () => { throw new Error("must not deploy"); } });
    expect(events).toContain(`FLEET_DEPLOY_NEEDS_ATTENTION ${key} ${signal} head=${head} reason=deploy_config_removed`);
    expect(db.query("SELECT state,deploy_lease_token,deploy_lease_until FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "deploy-needs-attention", deploy_lease_token: null, deploy_lease_until: null });
    db.close();
  });

  it("uses only the latest verdict and accepts APPROVE/REVISE aliases", () => {
    const messages = [
      { ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `ACCEPT owner/repo#52 head=${head}` },
      { ts: "102", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `REJECT owner/repo#52 head=${head} older verdict` },
      { ts: "103", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `APPROVE owner/repo#52 head=${head}` },
      { ts: "104", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text: `REVISE owner/repo#52 head=${head} latest verdict` },
    ];
    expect(matchPrLoopVerdict(messages, { repo: "owner/repo", prNumber: "52", head, threadTs, afterTs: "100" }))
      .toEqual({ kind: "reject", text: `REVISE owner/repo#52 head=${head} latest verdict`, ts: "104" });
    expect(matchPrLoopVerdict(messages.slice(0, 3), { repo: "owner/repo", prNumber: "52", head, threadTs, afterTs: "100" }))
      .toEqual({ kind: "accept", text: `APPROVE owner/repo#52 head=${head}`, ts: "103" });
  });

  it("requires the exact owner/repository PR reference in verdicts", () => {
    for (const text of [
      `ACCEPT repo#52 head=${head}`,
      `ACCEPT other-owner/repo#52 head=${head}`,
    ]) {
      expect(matchPrLoopVerdict([{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW", text,
      }], { repo: "owner/repo", prNumber: "52", head, threadTs, afterTs: "100" })).toBeNull();
    }
  });

  it("does not auto-ready an accepted PR that was changed back to draft", async () => {
    const db = prLoopDb({ key: "PRLOOP-ACCEPTED-DRAFT", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-ACCEPTED-DRAFT','accepted','ACCEPT','101','1')`).run(head);
    const commands = [];
    await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: cursorAcceptReplies,
      runCommand: async (argv) => {
        commands.push(argv);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ state: "OPEN", isDraft: true, headRefOid: head, body: "Tests: bun test fleet/" }),
        };
      },
    });
    expect(commands.some((argv) => argv[1] === "pr" && (argv[2] === "ready" || argv[2] === "merge"))).toBe(false);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    db.close();
  });

  it("matches merge methods by repository and uses the configured strategy", async () => {
    const db = prLoopDb({ key: "PRLOOP-SQUASH", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-SQUASH','accepted','ACCEPT','101','1')`).run(head);
    let merged = false;
    const commands = [];
    await processPrLoopEvents(db, {
      ...config,
      autoMerge: true,
      mergeMethods: { "OWNER/REPO": "squash" },
    }, {
      fetchReplies: cursorAcceptReplies,
      runCommand: async (argv) => {
        commands.push(argv);
        if (argv[1] === "pr" && argv[2] === "merge") {
          merged = true;
          return { exitCode: 0, stdout: "" };
        }
        if (argv[1] === "pr" && argv[2] === "view") return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head,
            mergeCommit: merged ? { oid: mergeSha } : null,
          }),
        };
        throw new Error(`unexpected command ${argv.join(" ")}`);
      },
    });
    expect(commands).toContainEqual(["gh", "pr", "merge", "52", "-R", "owner/repo", "--squash", "--match-head-commit", head]);
    db.close();
  });

  it("normalizes deploy config repository keys case-insensitively", async () => {
    const db = prLoopDb({ key: "PRLOOP-REPO-CASE", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-REPO-CASE','merged',?,'1')`).run(head, mergeSha);
    const finished = deferred();
    let deployCall;
    await processPrLoopEvents(db, {
      ...config,
      deploy: { "OWNER/REPO": { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" } },
    }, {
      getMainSha: async () => mergeSha,
      runDeploy: async (...args) => { deployCall = args; return { exitCode: 0 }; },
      checkHealth: async (_url, _timeout, sha) => ({ status: 200, mergeSha: sha }),
      onDeploySettled: finished.resolve,
    });
    expect((await settlesWithin(finished.promise)).settled).toBe(true);
    expect(deployCall?.[0]).toBe("owner/repo");
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deployed");
    db.close();
  });

  it("polls a pending auto-merge without invoking merge again", async () => {
    const db = prLoopDb({ key: "PRLOOP-MERGE-PENDING", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MERGE-PENDING','accepted','ACCEPT','101','1')`).run(head);
    let mergeCalls = 0;
    let githubState = "OPEN";
    const runCommand = async (argv) => {
      if (argv[1] === "pr" && argv[2] === "merge") {
        mergeCalls++;
        return { exitCode: 0, stdout: "" };
      }
      if (argv[1] === "pr" && argv[2] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: githubState, isDraft: false, headRefOid: head,
            mergeCommit: githubState === "MERGED" ? { oid: mergeSha } : null,
          }),
        };
      }
      throw new Error(`unexpected command ${argv.join(" ")}`);
    };
    const first = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      runCommand, fetchReplies: cursorAcceptReplies,
    });
    expect(first.some((event) => event.startsWith("FLEET_PR_MERGE_PENDING PRLOOP-MERGE-PENDING"))).toBe(true);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("merge-pending");

    const second = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      runCommand, fetchReplies: cursorAcceptReplies,
    });
    expect(second).toEqual([]);
    expect(mergeCalls).toBe(1);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("merge-pending");

    githubState = "MERGED";
    const third = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      runCommand, fetchReplies: cursorAcceptReplies,
    });
    expect(third).toContain(`FLEET_PR_MERGED PRLOOP-MERGE-PENDING ${signal} head=${head} merge_sha=${mergeSha}`);
    expect(mergeCalls).toBe(1);
    expect(db.query("SELECT state,merge_sha FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_sha: mergeSha });
    db.close();
  });

  it("resumes a nonzero gh pr merge result by polling instead of merging twice", async () => {
    const db = prLoopDb({ key: "PRLOOP-MERGE-COMMAND-ERROR", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MERGE-COMMAND-ERROR','accepted','100','ACCEPT','101','1')`).run(head);
    let mergeCalls = 0;
    let githubState = "OPEN";
    const runCommand = async (argv) => {
      if (argv[1] === "pr" && argv[2] === "merge") {
        mergeCalls++;
        return { exitCode: 1, stdout: "auto-merge already enabled" };
      }
      if (argv[1] === "pr" && argv[2] === "view") return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: githubState, isDraft: false, headRefOid: head,
          mergeCommit: githubState === "MERGED" ? { oid: mergeSha } : null,
        }),
      };
      throw new Error(`unexpected command ${argv.join(" ")}`);
    };
    const fetchReplies = async () => [{
      ts: "102", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
      text: `ACCEPT owner/repo#52 head=${head}`,
    }];
    const first = await processPrLoopEvents(db, { ...config, autoMerge: true }, { runCommand, fetchReplies });
    expect(first).toContain(`FLEET_PR_MERGE_PENDING PRLOOP-MERGE-COMMAND-ERROR ${signal} head=${head} reason=merge_command_exit_1`);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("merge-pending");
    expect(await processPrLoopEvents(db, { ...config, autoMerge: true }, { runCommand, fetchReplies }))
      .toEqual([]);
    expect(mergeCalls).toBe(1);
    githubState = "MERGED";
    const merged = await processPrLoopEvents(db, { ...config, autoMerge: true }, { runCommand, fetchReplies });
    expect(merged).toContain(`FLEET_PR_MERGED PRLOOP-MERGE-COMMAND-ERROR ${signal} head=${head} merge_sha=${mergeSha}`);
    expect(mergeCalls).toBe(1);
    expect(db.query("SELECT state,merge_sha FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_sha: mergeSha });
    db.close();
  });

  it("times out pending merges into a state that keeps polling", async () => {
    const db = prLoopDb({ key: "PRLOOP-MERGE-TIMEOUT", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,merge_pending_since,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MERGE-TIMEOUT','merge-pending','ACCEPT','101','2026-10-12T00:00:00.000Z','1')`)
      .run(head);
    let githubState = "OPEN";
    let mergeCalls = 0;
    const runCommand = async (argv) => {
      if (argv[1] === "pr" && argv[2] === "merge") {
        mergeCalls++;
        return { exitCode: 0, stdout: "" };
      }
      if (argv[1] === "pr" && argv[2] === "view") return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: githubState, isDraft: false, headRefOid: head,
          mergeCommit: githubState === "MERGED" ? { oid: mergeSha } : null,
        }),
      };
      throw new Error(`unexpected command ${argv.join(" ")}`);
    };
    const timeoutConfig = { ...config, mergePendingTimeoutMs: 1_000 };
    const timedOut = await processPrLoopEvents(db, timeoutConfig, { runCommand, fetchReplies: async () => [] });
    expect(timedOut).toContain(`FLEET_PR_MERGE_TIMEOUT PRLOOP-MERGE-TIMEOUT ${signal} head=${head} timeout_ms=1000`);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("merge-timeout");
    expect(await processPrLoopEvents(db, timeoutConfig, { runCommand, fetchReplies: async () => [] }))
      .toEqual([]);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("merge-timeout");
    githubState = "MERGED";
    const merged = await processPrLoopEvents(db, timeoutConfig, { runCommand, fetchReplies: async () => [] });
    expect(merged).toContain(`FLEET_PR_MERGED PRLOOP-MERGE-TIMEOUT ${signal} head=${head} merge_sha=${mergeSha}`);
    expect(mergeCalls).toBe(0);
    expect(db.query("SELECT state,merge_sha FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_sha: mergeSha });
    db.close();
  });

  it("keeps the watch result recoverable when an auto-merge PR lookup fails", async () => {
    const db = prLoopDb({ key: "PRLOOP-LOOKUP-FAIL", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-LOOKUP-FAIL','accepted','ACCEPT','101','1')`).run(head);
    const events = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: async () => [],
      runCommand: async () => ({ exitCode: 1, stdout: "" }),
    });
    expect(events).toEqual([]);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    db.close();
  });

  it("does not merge a stored ACCEPT when this cycle cannot read Slack verdicts", async () => {
    const db = prLoopDb({ key: "PRLOOP-STALE-ACCEPT-LOOKUP", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-STALE-ACCEPT-LOOKUP','accepted','100','ACCEPT','101','1')`).run(head);
    let mergeCalls = 0;
    const events = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: async () => { throw new Error("Slack replies unavailable"); },
      runCommand: async (argv) => {
        if (argv[1] === "pr" && argv[2] === "merge") mergeCalls++;
        return { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head }) };
      },
    });
    expect(mergeCalls).toBe(0);
    expect(events).toEqual([]);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    db.close();
  });

  it("does not merge a stored ACCEPT when the current Slack verdict lookup fails", async () => {
    const db = prLoopDb({ key: "PRLOOP-CURRENT-VERDICT", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-CURRENT-VERDICT','accepted','100','ACCEPT','101','1')`).run(head);
    let mergeCalls = 0;
    const events = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: async () => { throw new Error("Slack verdict lookup unavailable"); },
      runCommand: async (argv) => {
        if (argv[1] === "pr" && argv[2] === "merge") mergeCalls++;
        return { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head }) };
      },
    });
    expect(events).toEqual([]);
    expect(mergeCalls).toBe(0);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    db.close();
  });

  it("does not merge sibling PRs after another PR for the same task is rejected", async () => {
    const secondSignal = "pr:other/repo#53";
    const secondHead = "ffffffffffffffffffffffffffffffffffffffff";
    const key = "PRLOOP-SIBLING-REJECT";
    const db = prLoopDb({ key, done: `${signal};${secondSignal}` });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,?,'accepted','ACCEPT','100','1')`).run(head, key);
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,request_ts,updated_at)
      VALUES('other/repo','53',?,?,'awaiting-review','99','1')`).run(secondHead, key);
    let mergeCalls = 0;
    const sent = [];
    const events = await processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: async () => [{
        ts: "101", thread_ts: threadTs, user: "U0B81F5GR6V", app_id: "A08SKDT6QUW",
        text: `REJECT other/repo#53 head=${secondHead} needs changes`,
      }],
      runCommand: async (argv) => {
        if (argv[1] === "pr" && argv[2] === "merge") mergeCalls++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN", isDraft: false, headRefOid: argv.includes("53") ? secondHead : head,
            body: "Tests: bun test fleet/",
          }),
        };
      },
      sendFollowup: async (_pane, text) => { sent.push(text); return true; },
    });
    expect(mergeCalls).toBe(0);
    expect(sent).toHaveLength(1);
    expect(events).toContain(`FLEET_PR_REJECT_FOLLOWUP ${key} ${secondSignal} head=${secondHead}`);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("accepted");
    db.close();
  });

  it("uses database leases to prevent overlapping watch instances from repeating a deployment", async () => {
    const original = process.env.HOME;
    let secondWorker;
    try {
      process.env.HOME = unitHome;
      secondWorker = await import(`./fleet.mjs?worker=${crypto.randomUUID()}`);
    } finally {
      if (original === undefined) delete process.env.HOME;
      else process.env.HOME = original;
    }
    const db = prLoopDb({ key: "PRLOOP-DEPLOY-LEASE", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-DEPLOY-LEASE','merged',?,'1')`).run(head, mergeSha);
    const started = deferred();
    const release = deferred();
    const finished = deferred();
    let firstRuns = 0;
    let secondRuns = 0;
    const deployConfig = {
      ...config,
      deploy: { "owner/repo": { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" } },
    };
    const firstCycle = processPrLoopEvents(db, deployConfig, {
      getMainSha: async () => mergeSha,
      runDeploy: async () => { firstRuns++; started.resolve(); return release.promise; },
      checkHealth: async () => ({ status: 200, mergeSha }),
      onDeploySettled: finished.resolve,
    });
    try {
      expect((await settlesWithin(started.promise)).settled).toBe(true);
      expect((await settlesWithin(firstCycle)).settled).toBe(true);
      const secondCycle = await secondWorker.processPrLoopEvents(db, deployConfig, {
        getMainSha: async () => mergeSha,
        runDeploy: async () => { secondRuns++; return { exitCode: 0 }; },
        checkHealth: async () => ({ status: 200, mergeSha }),
      });
      expect(secondCycle).toEqual([]);
      expect(firstRuns).toBe(1);
      expect(secondRuns).toBe(0);
      expect(db.query("SELECT state,deploy_lease_until FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
        .toBe("deploying");
    } finally {
      release.resolve({ exitCode: 0 });
    }
    expect((await settlesWithin(finished.promise)).settled).toBe(true);
    expect(db.query("SELECT state,deploy_lease_token,deploy_lease_until FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "deployed", deploy_lease_token: null, deploy_lease_until: null });
    db.close();
  });

  it("claims a recovered review post once across overlapping watch instances", async () => {
    const original = process.env.HOME;
    let secondWorker;
    try {
      process.env.HOME = unitHome;
      secondWorker = await import(`./fleet.mjs?post-worker=${crypto.randomUUID()}`);
    } finally {
      if (original === undefined) delete process.env.HOME;
      else process.env.HOME = original;
    }
    const db = prLoopDb({ key: "PRLOOP-POST-LEASE", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-POST-LEASE','posting','1')`).run(head);
    const started = deferred();
    const release = deferred();
    let firstPosts = 0;
    let secondPosts = 0;
    const firstCycle = processPrLoopEvents(db, config, {
      runCommand: async () => prInfo(),
      fetchReplies: async () => [],
      postMessage: async () => {
        firstPosts++;
        started.resolve();
        return release.promise;
      },
    });
    try {
      expect((await settlesWithin(started.promise)).settled).toBe(true);
      const secondCycle = await secondWorker.processPrLoopEvents(db, config, {
        runCommand: async () => prInfo(),
        fetchReplies: async () => [],
        postMessage: async () => {
          secondPosts++;
          return { ok: true, ts: "2026.202" };
        },
      });
      expect(secondCycle).toEqual([]);
      expect(firstPosts).toBe(1);
      expect(secondPosts).toBe(0);
      expect(db.query("SELECT state,post_lease_token FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
        .toBe("posting");
    } finally {
      release.resolve({ ok: true, ts: "2026.201" });
    }
    expect((await settlesWithin(firstCycle)).settled).toBe(true);
    expect(db.query("SELECT state,request_ts,post_lease_token,post_lease_until FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "awaiting-review", request_ts: "2026.201", post_lease_token: null, post_lease_until: null });
    db.close();
  });

  it("uses a database lease to prevent overlapping watch instances from merging twice", async () => {
    const original = process.env.HOME;
    let secondWorker;
    try {
      process.env.HOME = unitHome;
      secondWorker = await import(`./fleet.mjs?merge-worker=${crypto.randomUUID()}`);
    } finally {
      if (original === undefined) delete process.env.HOME;
      else process.env.HOME = original;
    }
    const db = prLoopDb({ key: "PRLOOP-MERGE-LEASE", done: signal });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,verdict,verdict_ts,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MERGE-LEASE','accepted','ACCEPT','101','1')`).run(head);
    const mergeLookup = deferred();
    const releaseLookup = deferred();
    let viewCalls = 0;
    let merged = false;
    let mergeCalls = 0;
    const firstCycle = processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: cursorAcceptReplies,
      runCommand: async (argv) => {
        if (argv[1] === "pr" && argv[2] === "view") {
          viewCalls++;
          if (viewCalls === 3) {
            mergeLookup.resolve();
            await releaseLookup.promise;
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head,
              mergeCommit: merged ? { oid: mergeSha } : null,
            }),
          };
        }
        if (argv[1] === "pr" && argv[2] === "merge") {
          mergeCalls++;
          merged = true;
          return { exitCode: 0, stdout: "" };
        }
        throw new Error(`unexpected command ${argv.join(" ")}`);
      },
    });
    expect((await settlesWithin(mergeLookup.promise)).settled).toBe(true);
    let secondMergeCalls = 0;
    const secondCycle = await secondWorker.processPrLoopEvents(db, { ...config, autoMerge: true }, {
      fetchReplies: cursorAcceptReplies,
      runCommand: async (argv) => {
        if (argv[1] === "pr" && argv[2] === "merge") secondMergeCalls++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: head }),
        };
      },
    });
    expect(secondCycle).toEqual([]);
    expect(secondMergeCalls).toBe(0);
    expect(db.query("SELECT state,merge_lease_until FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("merging");
    releaseLookup.resolve();
    expect((await settlesWithin(firstCycle)).settled).toBe(true);
    expect(mergeCalls).toBe(1);
    expect(db.query("SELECT state,merge_lease_token,merge_lease_until FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head))
      .toEqual({ state: "merged-no-deploy", merge_lease_token: null, merge_lease_until: null });
    db.close();
  });

  it("does not count a Test Plan entry that says not run", () => {
    expect(hasListedTests("## Test Plan\n- Not run (environment unavailable)\n")).toBe(false);
    expect(hasListedTests("## Tests\n- bun test fleet/\n")).toBe(false);
    expect(hasListedTests("## Tests\n- 210 passed, 0 failed\n")).toBe(true);
  });
});

describe("fleet model-switch waits", () => {
  it("advances only after the picker, catalog, and selected model appear", async () => {
    let stage = 0;
    const calls = [];
    const screen = () => [
      "Idle\n⚡ claude-haiku:off\n❯",
      "Idle\n⚡ claude-haiku:off\n❯ /model",
      "Select model\n→ claude-sonnet [anthropic]\n❯",
      "Select model\n→ claude-sonnet [anthropic]\n❯",
      "Idle\n⚡ claude-sonnet:high\n❯",
    ][stage];
    const runCommand = async (argv) => {
      calls.push(argv);
      if (argv[2] === "read") return { exitCode: 0, stdout: screen() };
      if (argv[2] === "send-text" && argv[4] === "/model") stage = 1;
      else if (argv[2] === "send-keys" && argv[4] === "Enter" && stage === 1) stage = 2;
      else if (argv[2] === "send-text" && argv[4] === "claude-sonnet") stage = 3;
      else if (argv[2] === "send-keys" && argv[4] === "Enter" && stage === 3) stage = 4;
      return { exitCode: 0, stdout: "" };
    };
    const result = await switchModel("w-model:p1", {
      provider: "anthropic",
      model: "claude-sonnet",
      thinking: "high",
    }, runCommand, 1000);
    expect(result).toBe("MODEL_SWITCHED claude-haiku:off -> anthropic/claude-sonnet");
    expect(calls.filter((argv) => argv[2] === "send-text").map((argv) => argv[4])).toEqual(["/model", "claude-sonnet"]);
    expect(calls.filter((argv) => argv[2] === "send-keys").map((argv) => argv[4])).toEqual(["Enter", "Enter"]);
  });

  it("returns a distinct timeout when the picker screen never appears", async () => {
    const result = await switchModel("w-timeout:p1", {
      provider: "anthropic",
      model: "claude-sonnet",
      thinking: "high",
    }, async (argv) => ({
      exitCode: 0,
      stdout: argv[2] === "read" ? "Idle\n⚡ claude-haiku:off\n❯" : "",
    }), 0);
    expect(result).toBe("MODEL_SWITCH_TIMEOUT w-timeout:p1 phase=picker-open");
  });

  async function runFailure(failureAt, failClear = false) {
    let stage = "initial";
    let input = "";
    const calls = [];
    const model = "gpt-6-astra";
    const screen = () => {
      if (stage === "catalog" || stage === "filtered") return `Select model\n→ ${model} [chatgpt-subscription]\n❯ ${input}`;
      if (stage === "model-row-unavailable") return `Select model\n→ claude-haiku [anthropic]\n❯ ${input}`;
      if (stage === "model-change-unavailable") return "Idle\n⚡ claude-haiku:off\n❯";
      if (stage === "thinking-command-unavailable") return `Idle\n⚡ ${model}:high\n❯`;
      if (stage === "thinking-transition") return `Idle\n⚡ ${model}:high\n❯ ${input}`;
      if (stage === "input-clear") return `Idle\n⚡ ${model}:xhigh\n❯ ${input}`;
      if (stage === "thinking-command" || stage === "selected") return `Idle\n⚡ ${model}:high\n❯ ${input}`;
      if (stage === "picker-command") return `Idle\n⚡ claude-haiku:off\n❯ ${input}`;
      return `Idle\n⚡ claude-haiku:off\n❯ ${input}`;
    };
    const runCommand = async (argv) => {
      calls.push(argv);
      if (argv[2] === "read") return { exitCode: 0, stdout: screen() };
      if (argv[2] === "send-text") {
        if (argv[4] === "/model") {
          if (failureAt !== "picker-open") {
            input = "/model";
            stage = "picker-command";
          }
        } else if (argv[4] === model) {
          input = model;
          stage = failureAt === "model-row" ? "model-row-unavailable" : "filtered";
        } else if (argv[4] === "/thinking xhigh") {
          input = "/thinking xhigh";
          stage = failureAt === "thinking-command" ? "thinking-command-unavailable" : "thinking-command";
          if (failureAt === "thinking-command") return { exitCode: 1, stdout: "" };
        }
        return { exitCode: 0, stdout: "" };
      }
      if (argv[2] === "send-keys" && argv[4] === "Escape") {
        stage = "selected";
        return { exitCode: 0, stdout: "" };
      }
      if (argv[2] === "send-keys" && argv[4] === "ctrl+u") {
        if (!failClear) input = "";
        return { exitCode: failClear ? 1 : 0, stdout: "" };
      }
      if (argv[2] === "send-keys" && argv[4] === "Enter") {
        if (stage === "picker-command") {
          if (failureAt === "picker-submit") return { exitCode: 1, stdout: "" };
          input = "";
          stage = failureAt === "catalog" ? "picker-command" : "catalog";
        } else if (stage === "filtered") {
          if (failureAt === "model-select") return { exitCode: 1, stdout: "" };
          input = "";
          stage = failureAt === "model-change" ? "model-change-unavailable" : "selected";
        } else if (stage === "thinking-command") {
          if (failureAt === "thinking-submit") return { exitCode: 1, stdout: "" };
          stage = failureAt === "thinking-change" ? "thinking-transition" : "input-clear";
        }
        return { exitCode: 0, stdout: "" };
      }
      throw new Error(`unexpected command ${argv.join(" ")}`);
    };
    const result = await switchModel("w-model-failure:p1", {
      provider: "chatgpt-subscription",
      model,
      thinking: "xhigh",
    }, runCommand, 0);
    return { result, calls, screen: screen() };
  }

  for (const failureAt of [
    "picker-open", "picker-submit", "catalog", "model-row", "model-select",
    "model-change", "thinking-command", "thinking-submit", "thinking-change", "input-clear",
  ]) {
    it(`cleans the picker input after the ${failureAt} failure`, async () => {
      const { result, calls, screen } = await runFailure(failureAt);
      expect(result).not.toContain("MODEL_SWITCH_DIRTY");
      const escape = calls.findIndex((argv) => argv[2] === "send-keys" && argv[4] === "Escape");
      const clear = calls.findIndex((argv) => argv[2] === "send-keys" && argv[4] === "ctrl+u");
      expect(escape).toBeGreaterThanOrEqual(0);
      expect(clear).toBeGreaterThan(escape);
      expect(calls.slice(clear + 1).some((argv) => argv[2] === "read")).toBe(true);
      expect(screen).toMatch(/❯\s*$/);
    });
  }

  it("reports dirty input when ctrl+u or empty-input verification fails", async () => {
    const { result, calls } = await runFailure("thinking-change", true);
    expect(result).toContain("MODEL_SWITCH_DIRTY");
    expect(calls.some((argv) => argv[2] === "send-keys" && argv[4] === "Escape")).toBe(true);
    expect(calls.some((argv) => argv[2] === "send-keys" && argv[4] === "ctrl+u")).toBe(true);
  });

  it("retains the reservation and marks dispatch-error when model-switch cleanup is unverified", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "dirty-switch-prompt.txt");
    writeFileSync(prompt, "must not append to dirty pane input\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('dirty-switch-cat','Dirty Switch','w-dirty-switch:p1')").run();
    db.close();

    const result = await dispatch("dirty-switch-cat", "DIRTY-SWITCH", prompt, {
      type: "secure",
      runCommand: async (argv) => ({ exitCode: 0, stdout: argv[2] === "read" ? "Idle\n⚡ claude-haiku:off\n❯" : "" }),
      switchPaneModel: async () => "MODEL_SWITCH_DIRTY w-dirty-switch:p1 cleanup-unverified",
    });
    expect(result).toContain("DISPATCH_ERROR dirty-switch-cat DIRTY-SWITCH");
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key='DIRTY-SWITCH'").get().status).toBe("dispatch-error");
    expect(stored.query("SELECT key FROM dispatch_reservations WHERE pane='w-dirty-switch:p1'").get().key).toBe("DIRTY-SWITCH");
    stored.close();
  });

  for (const status of ["dispatch-error", "waiting"]) {
    it(`keeps a retained reservation recoverable when retrying a ${status} task`, async () => {
      const db = unitDb();
      const key = `TASK-REQUEUE-DIRTY-${status.toUpperCase()}`;
      const cat = `requeue-dirty-${status}`;
      const pane = `w-requeue-${status}:p1`;
      const prompt = join(unitHome, `${key}.txt`);
      const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      writeFileSync(prompt, "do not queue while dirty pane reservation remains\n");
      db.query("INSERT INTO cats(id,name,pane,task) VALUES(?,?,?,?)").run(cat, cat, pane, key);
      db.query("INSERT INTO tasks(key,cat,status) VALUES(?,?,?)").run(key, cat, status);
      db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
        .run(pane, key, `requeue-attempt-${status}`, reservedAt);
      db.close();

      const retryCommands = [];
      expect(await dispatch(cat, key, prompt, {
        keepModel: true,
        runCommand: async argv => { retryCommands.push(argv); return { exitCode: 0, stdout: "Select model\n→ model [provider]\n❯" }; },
      })).toBe(`DISPATCH_HOLD ${cat} reservation-retained; not queued`);
      expect(retryCommands).toEqual([]);
      const retained = unitDb();
      expect(retained.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("dispatch-error");
      expect(retained.query("SELECT pane FROM dispatch_reservations WHERE key=?").get(key).pane).toBe(pane);
      retained.close();

      let reads = 0;
      const recovered = unitDb();
      const events = await recoverInterruptedDispatches(recovered, [{ id: cat, state: "model-picker" }],
        Date.parse(reservedAt) + 11 * 60_000, async argv => {
          if (argv[2] === "read") return { exitCode: 0, stdout: ++reads === 1 ? "Select model\n→ model [provider]\n❯" : "Idle\n❯" };
          return { exitCode: 0, stdout: "" };
        });
      expect(events).toEqual([`FLEET_DISPATCH_INTERRUPTED ${key} pane=${pane} reservation_released`]);
      expect(recovered.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("dispatch-interrupted");
      expect(recovered.query("SELECT key FROM dispatch_reservations WHERE key=?").get(key)).toBeNull();
      recovered.close();
    });
  }

  it("waits for an empty prompt after xhigh confirmation before sending the task", async () => {
    const db = unitDb();
    const pane = "w-mail-hardening:p1";
    const prompt = join(unitHome, "mail-jarvis-reader-prompt.txt");
    writeFileSync(prompt, "mail JARVIS reader fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('mail-hardening-cat','Mail Hardening',?)").run(pane);
    db.close();

    let phase = "initial";
    let thinkingReads = 0;
    const timeline = [];
    const concatenatedInput = "/thinking xhighTASK-MAIL-JARVIS-READER-20261012 [attempt=fixture]:";
    const runCommand = async (argv) => {
      if (argv[2] === "read") {
        let stdout;
        if (phase === "initial") stdout = "Idle\n⚡ claude-haiku:off\n❯";
        else if (phase === "model-command") stdout = "Idle\n⚡ claude-haiku:off\n❯ /model";
        else if (phase === "catalog" || phase === "filtered") stdout = "Select model\n→ gpt-6-astra [chatgpt-subscription]\n❯";
        else if (phase === "selected") stdout = "Idle\n⚡ gpt-6-astra:high\n❯";
        else if (phase === "thinking-command") stdout = "Idle\n⚡ gpt-6-astra:high\n❯ /thinking xhigh";
        else if (phase === "thinking-transition") {
          thinkingReads++;
          stdout = thinkingReads <= 2
            ? `Error: Unknown thinking level "xhighTASK-MAIL-JARVIS-READER-20261012 [attempt=fixture]:"\nIdle\n⚡ gpt-6-astra:xhigh\n❯ ${concatenatedInput}`
            : "Idle\n⚡ gpt-6-astra:xhigh\n❯";
        } else stdout = "Working (1s)\n❯";
        timeline.push({ kind: "read", stdout });
        return { exitCode: 0, stdout };
      }
      if (argv[2] === "send-text") {
        timeline.push({ kind: "send-text", text: argv[4] });
        if (argv[4] === "/model") phase = "model-command";
        else if (argv[4] === "gpt-6-astra") phase = "filtered";
        else if (argv[4] === "/thinking xhigh") phase = "thinking-command";
        else if (argv[4].startsWith("TASK-MAIL-JARVIS-READER-20261012 [attempt=")) phase = "task-sent";
        return { exitCode: 0, stdout: "" };
      }
      if (argv[2] === "send-keys" && argv[4] === "Enter") {
        if (phase === "model-command") phase = "catalog";
        else if (phase === "filtered") phase = "selected";
        else if (phase === "thinking-command") phase = "thinking-transition";
        else if (phase === "task-sent") phase = "working";
        timeline.push({ kind: "enter", phase });
        return { exitCode: 0, stdout: "" };
      }
      throw new Error(`unexpected herdr command: ${argv.join(" ")}`);
    };
    const result = await dispatch("mail-hardening-cat", "TASK-MAIL-JARVIS-READER-20261012", prompt, {
      type: "secure",
      runCommand,
      sleep: async () => {},
      switchPaneModel: (targetPane, want) => switchModel(targetPane, want, runCommand, 1000),
    });
    const concatRead = timeline.findIndex((event) => event.kind === "read" && event.stdout.includes(concatenatedInput));
    const emptyRead = timeline.findIndex((event, index) => index > concatRead
      && event.kind === "read" && /❯\s*$/.test(event.stdout));
    const taskSend = timeline.findIndex((event) => event.kind === "send-text"
      && event.text.startsWith("TASK-MAIL-JARVIS-READER-20261012 [attempt="));
    expect(result).toContain("DISPATCH_OK mail-hardening-cat TASK-MAIL-JARVIS-READER-20261012");
    expect(concatRead).toBeGreaterThanOrEqual(0);
    expect(emptyRead).toBeGreaterThan(concatRead);
    expect(taskSend).toBeGreaterThan(emptyRead);
  });
});

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

    const events = await dispatchWaitingTasks(db, [{ id: "crm", state: "idle" }], dispatchTask);
    expect(events).toEqual(["FLEET_DEPENDENCY_DISPATCH CHILD DISPATCH_OK crm CHILD"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.after).toBe("PARENT");
    expect(db.query("SELECT status FROM tasks WHERE key='CHILD'").get().status).toBe("sent");

    await dispatchWaitingTasks(db, [{ id: "crm", state: "idle" }], dispatchTask);
    expect(calls).toHaveLength(1);
    db.close();
  });

  it("keeps the child queued until its predecessor is verified-done", async () => {
    const db = dependencyDb("working");
    const calls = [];
    const events = await dispatchWaitingTasks(db, [{ id: "crm", state: "idle" }], async (...args) => calls.push(args));
    expect(events).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(db.query("SELECT status FROM tasks WHERE key='CHILD'").get().status).toBe("waiting");
    db.close();
  });

  it("resumes a pane-wait task once after the pane becomes idle", async () => {
    const db = dependencyDb("working");
    db.query("UPDATE tasks SET depends_on=NULL WHERE key='CHILD'").run();
    const calls = [];
    const dispatchTask = async (cat, key, prompt, options) => {
      calls.push({ cat, key, prompt, options });
      db.query("UPDATE tasks SET status='sent' WHERE key=?").run(key);
      return `DISPATCH_OK ${cat} ${key}`;
    };

    expect(await dispatchWaitingTasks(db, [{ id: "crm", state: "compacting" }], dispatchTask)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(db.query("SELECT status FROM tasks WHERE key='CHILD'").get().status).toBe("waiting");

    expect(await dispatchWaitingTasks(db, [{ id: "crm", state: "idle" }], dispatchTask))
      .toEqual(["FLEET_DISPATCH_RESUMED CHILD DISPATCH_OK crm CHILD"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.after).toBeNull();
    expect(db.query("SELECT status FROM tasks WHERE key='CHILD'").get().status).toBe("sent");

    await dispatchWaitingTasks(db, [{ id: "crm", state: "idle" }], dispatchTask);
    expect(calls).toHaveLength(1);
    db.close();
  });

  it("marks a bad queued task and continues dispatching later tasks", async () => {
    const db = dependencyDb("verified-done");
    db.query("DELETE FROM tasks WHERE key='CHILD'").run();
    db.query(`INSERT INTO tasks(key,cat,title,prompt,skill,done,status,sent_at,depends_on,dispatch_type,keep_model)
      VALUES('BAD','crm','bad','/missing/prompt','ulw','','waiting','1',NULL,'impl',0)`).run();
    db.query(`INSERT INTO tasks(key,cat,title,prompt,skill,done,status,sent_at,depends_on,dispatch_type,keep_model)
      VALUES('GOOD','crm','good','/tmp/good-prompt','ulw','','waiting','2',NULL,'impl',0)`).run();

    const events = await dispatchWaitingTasks(db, [{ id: "crm", state: "idle" }], async (cat, key) => {
      if (key === "BAD") throw new Error("PROMPT_FILE_MISSING");
      db.query("UPDATE tasks SET status='sent' WHERE key=?").run(key);
      return `DISPATCH_OK ${cat} ${key}`;
    });
    expect(events).toEqual([
      "FLEET_DISPATCH_ERROR BAD dispatch failed: PROMPT_FILE_MISSING",
      "FLEET_DISPATCH_RESUMED GOOD DISPATCH_OK crm GOOD",
    ]);
    expect(db.query("SELECT status,result FROM tasks WHERE key='BAD'").get())
      .toEqual({ status: "dispatch-error", result: "dispatch failed: PROMPT_FILE_MISSING" });
    expect(db.query("SELECT status FROM tasks WHERE key='GOOD'").get().status).toBe("sent");
    db.close();
  });

});

describe("fleet PR-loop deployment safety", () => {
  const signal = "pr:owner/repo#52";
  const head = "0123456789abcdef0123456789abcdef01234567";
  const prLoopConfig = { enabled: true, autoMerge: false, reviewChannel: "C0C5Z4SJ309", reviewThreadTs: "1791757469.519659", deploy: {} };

  it.each([
    [`{"merge_sha":"abcdef0123456789abcdef0123456789abcdef01"}`, "abcdef0123456789abcdef0123456789abcdef01"],
    [`{"commit":{"sha":"abcdef0123456789abcdef0123456789abcdef01"}}`, "abcdef0123456789abcdef0123456789abcdef01"],
    ["abcdef0123456789abcdef0123456789abcdef01", "abcdef0123456789abcdef0123456789abcdef01"],
  ])("reads the deployed SHA from health/version response %s", async (body, expected) => {
    const result = await checkDeployHealth("https://service.example/version", 1000, expected, async () =>
      new Response(body, { status: 200 }));
    expect(result).toEqual({ status: 200, mergeSha: expected });
  });

  it("passes the accepted merge SHA to deployment and requires health to report it", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const db = prLoopDb({ key: "PRLOOP-SHA-DEPLOY", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-SHA-DEPLOY','merged',?,'1')`).run(head, mergeSha);
    const deployment = { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" };
    const finished = deferred();
    let deployArgs;
    const events = await processPrLoopEvents(db, {
      ...prLoopConfig,
      deploy: { "owner/repo": deployment },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => mergeSha,
      runDeploy: async (...args) => { deployArgs = args; return { exitCode: 0 }; },
      checkHealth: async (url, timeoutMs, expectedSha) => ({
        status: url === deployment.healthUrl && timeoutMs === 300_000 ? 200 : 500,
        mergeSha: expectedSha,
      }),
      onDeploySettled: finished.resolve,
    });
    expect(events).toContain(`FLEET_DEPLOY_STARTED PRLOOP-SHA-DEPLOY ${signal} merge_sha=${mergeSha}`);
    const completion = await settlesWithin(finished.promise);
    expect(completion.settled).toBe(true);
    expect(deployArgs).toEqual(["owner/repo", deployment, mergeSha, 300_000]);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deployed");
    db.close();
  });

  it("refuses deployment when the default branch no longer points at the merge SHA", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const newerMainSha = "fedcba9876543210fedcba9876543210fedcba98";
    const db = prLoopDb({ key: "PRLOOP-MOVED-MAIN", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MOVED-MAIN','merged',?,'1')`).run(head, mergeSha);
    let deployed = false;
    const finished = deferred();
    const events = await processPrLoopEvents(db, {
      ...prLoopConfig,
      deploy: { "owner/repo": { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" } },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => newerMainSha,
      runDeploy: async () => { deployed = true; return { exitCode: 0 }; },
      onDeploySettled: finished.resolve,
    });
    expect(events).toContain(`FLEET_DEPLOY_STARTED PRLOOP-MOVED-MAIN ${signal} merge_sha=${mergeSha}`);
    const completion = await settlesWithin(finished.promise);
    expect(completion.settled).toBe(true);
    expect(deployed).toBe(false);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deploy-failed");
    db.close();
  });

  it("keeps a mismatched deployment version from becoming deployed", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
    const db = prLoopDb({ key: "PRLOOP-WRONG-VERSION", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-WRONG-VERSION','merged',?,'1')`).run(head, mergeSha);
    const finished = deferred();
    const events = await processPrLoopEvents(db, {
      ...prLoopConfig,
      deploy: { "owner/repo": { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" } },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => mergeSha,
      runDeploy: async () => ({ exitCode: 0 }),
      checkHealth: async () => ({ status: 200, mergeSha: otherSha }),
      onDeploySettled: finished.resolve,
    });
    expect(events).toContain(`FLEET_DEPLOY_STARTED PRLOOP-WRONG-VERSION ${signal} merge_sha=${mergeSha}`);
    const completion = await settlesWithin(finished.promise);
    expect(completion.settled).toBe(true);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deploy-failed");
    db.close();
  });

  it("does not accept HTTP 200 without a reported merge SHA", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const db = prLoopDb({ key: "PRLOOP-MISSING-VERSION", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MISSING-VERSION','merged',?,'1')`).run(head, mergeSha);
    const finished = deferred();
    await processPrLoopEvents(db, {
      ...prLoopConfig,
      deploy: { "owner/repo": { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" } },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => mergeSha,
      runDeploy: async () => ({ exitCode: 0 }),
      checkHealth: async () => ({ status: 200 }),
      onDeploySettled: finished.resolve,
    });
    const completion = await settlesWithin(finished.promise);
    expect(completion.value).toContain("health_merge_sha_mismatch");
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deploy-failed");
    db.close();
  });

  it("refuses to report deployed when main moves during deployment", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const newerMainSha = "fedcba9876543210fedcba9876543210fedcba98";
    const db = prLoopDb({ key: "PRLOOP-MAIN-MOVED-DURING", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-MAIN-MOVED-DURING','merged',?,'1')`).run(head, mergeSha);
    let mainChecks = 0;
    let deployed = false;
    const finished = deferred();
    await processPrLoopEvents(db, {
      ...prLoopConfig,
      deploy: { "owner/repo": { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" } },
    }, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => ++mainChecks === 1 ? mergeSha : newerMainSha,
      runDeploy: async (_repo, _deployment, expectedSha) => {
        deployed = expectedSha === mergeSha;
        return { exitCode: 0 };
      },
      checkHealth: async () => ({ status: 200, mergeSha }),
      onDeploySettled: finished.resolve,
    });
    const completion = await settlesWithin(finished.promise);
    expect(completion.value).toContain("default_branch_sha_moved");
    expect(deployed).toBe(true);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deploy-failed");
    db.close();
  });

  it("does not wait for deployment before returning the PR-loop watch events", async () => {
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const db = prLoopDb({ key: "PRLOOP-ASYNC-DEPLOY", done: signal, status: "verified-done" });
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','52',?,'PRLOOP-ASYNC-DEPLOY','merged',?,'1')`).run(head, mergeSha);
    db.query(`INSERT INTO fleet_pr_loop(repo,pr_number,head,task_key,state,merge_sha,updated_at)
      VALUES('owner/repo','53',?,'PRLOOP-ASYNC-DEPLOY','merged',?,'1')`).run(head, mergeSha);
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const firstFinished = deferred();
    const secondFinished = deferred();
    let deployCalls = 0;
    const config = {
      ...prLoopConfig,
      deploy: { "owner/repo": { argv: ["./deploy.sh"], healthUrl: "https://service.example/version" } },
    };
    const io = {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: head, mergeCommit: { oid: mergeSha } }),
      }),
      getMainSha: async () => mergeSha,
      runDeploy: async () => {
        deployCalls++;
        if (deployCalls === 1) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        secondStarted.resolve();
        return releaseSecond.promise;
      },
      checkHealth: async () => ({ status: 200, mergeSha }),
      onDeploySettled: (event) => {
        if (event.includes("#52")) firstFinished.resolve(event);
        else secondFinished.resolve(event);
      },
    };
    const cycle = processPrLoopEvents(db, config, io);
    try {
      const started = await settlesWithin(firstStarted.promise);
      expect(started.settled).toBe(true);
      const returned = await settlesWithin(cycle);
      expect(returned.settled).toBe(true);
      expect(returned.value).toContain(`FLEET_DEPLOY_STARTED PRLOOP-ASYNC-DEPLOY ${signal} merge_sha=${mergeSha}`);
      expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
        .toBe("deploying");
      expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='53' AND head=?").get(head).state)
        .toBe("merged");
      expect(deployCalls).toBe(1);
      releaseFirst.resolve({ exitCode: 0 });
      expect((await settlesWithin(firstFinished.promise)).settled).toBe(true);
      const nextCycle = await processPrLoopEvents(db, config, io);
      expect(nextCycle).toContain(`FLEET_DEPLOY_STARTED PRLOOP-ASYNC-DEPLOY pr:owner/repo#53 merge_sha=${mergeSha}`);
      expect((await settlesWithin(secondStarted.promise)).settled).toBe(true);
      expect(deployCalls).toBe(2);
    } finally {
      releaseFirst.resolve({ exitCode: 0 });
      releaseSecond.resolve({ exitCode: 0 });
    }
    const completion = await settlesWithin(secondFinished.promise);
    expect(completion.settled).toBe(true);
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='52' AND head=?").get(head).state)
      .toBe("deployed");
    expect(db.query("SELECT state FROM fleet_pr_loop WHERE repo='owner/repo' AND pr_number='53' AND head=?").get(head).state)
      .toBe("deployed");
    db.close();
  });
});

describe("fleet dispatch reservations", () => {
  it("clears an idle pane and releases its reservation after a failed send command", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "failed-send-prompt.txt");
    writeFileSync(prompt, "send failure fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('failed-send-cat','Failed Send','w-failed-send:p1')").run();
    db.close();

    const commands = [];
    let failCommand = "send-text";
    const runCommand = async (argv) => {
      commands.push(argv);
      if (argv[2] === failCommand) return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: argv[2] === "read" ? "Idle\n❯" : "" };
    };
    const result = await dispatch("failed-send-cat", "FAILED-SEND", prompt, {
      keepModel: true,
      runCommand,
      sleep: async () => {},
    });
    expect(result).toContain("DISPATCH_UNCONFIRMED failed-send-cat FAILED-SEND");
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key='FAILED-SEND'").get().status).toBe("send-failed-unconfirmed");
    expect(stored.query("SELECT key FROM dispatch_reservations WHERE pane='w-failed-send:p1'").get()).toBeNull();
    expect(commands.some((argv) => argv[2] === "send-keys" && argv[3] === "w-failed-send:p1" && argv[4] === "ctrl+u")).toBe(true);
    stored.close();

    failCommand = "send-keys";
    let reads = 0;
    const next = await dispatch("failed-send-cat", "AFTER-FAILED-SEND", prompt, {
      keepModel: true,
      runCommand: async (argv) => ({
        exitCode: 0,
        stdout: argv[2] === "read" ? (++reads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "",
      }),
      sleep: async () => {},
    });
    expect(next).toContain("DISPATCH_OK failed-send-cat AFTER-FAILED-SEND");
  });

  it("clears pending input and releases its lease after Enter send failure", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "failed-enter-prompt.txt");
    writeFileSync(prompt, "failed Enter fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('failed-enter-cat','Failed Enter','w-failed-enter:p1')").run();
    db.close();
    let paneReads = 0;
    const sleeps = [];
    const runCommand = async (argv) => {
      if (argv[2] === "read") paneReads++;
      return {
        exitCode: argv[2] === "send-keys" && argv[4] === "Enter" ? 1 : 0,
        stdout: argv[2] === "read" ? "Idle\n❯" : "",
      };
    };
    const result = await dispatch("failed-enter-cat", "FAILED-ENTER", prompt, {
      keepModel: true,
      runCommand,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result).toContain("DISPATCH_UNCONFIRMED failed-enter-cat FAILED-ENTER");
    expect(paneReads).toBe(16);
    expect(sleeps.filter((ms) => ms === 5000)).toHaveLength(11);
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key='FAILED-ENTER'").get().status).toBe("send-failed-unconfirmed");
    expect(stored.query("SELECT key FROM dispatch_reservations WHERE pane='w-failed-enter:p1'").get()).toBeNull();
    stored.close();
  });

  it("preserves sent_at after successful Enter and late Working observation", async () => {
    const db = unitDb();
    const key = "TASK-SUCCESSFUL-ENTER-LATE-WORKING";
    const prompt = join(unitHome, `${key}.txt`);
    writeFileSync(prompt, "synthetic late Working fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('late-working-cat','Late Working','late-working:p1')").run();
    db.close();
    let entered = false;
    let polls = 0;
    expect(await dispatch("late-working-cat", key, prompt, {
      keepModel: true,
      runCommand: async argv => {
        if (argv[2] === "read") return { exitCode: 0, stdout: entered && ++polls === 3 ? "Working (1s)\n❯" : "Idle\n❯" };
        if (argv[2] === "send-keys" && argv[4] === "Enter") entered = true;
        return { exitCode: 0, stdout: "" };
      },
      sleep: async () => {},
    })).toContain(`DISPATCH_OK late-working-cat ${key} started`);
    const stored = unitDb();
    const task = stored.query("SELECT sent_at,started_at,status,history FROM tasks WHERE key=?").get(key);
    const send = JSON.parse(task.history).findLast(event => event.ev === "send-attempted");
    expect(polls).toBe(3);
    expect(task.status).toBe("working");
    expect(task.sent_at).toBe(send.at);
    expect(task.started_at).not.toBeNull();
    stored.close();
  });

  it("preserves the current attempt send time when Enter fails but the pane starts", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "started-after-enter-error-prompt.txt");
    const pane = "w-started-after-enter-error:p1";
    const key = "TASK-STARTED-AFTER-ENTER-ERROR";
    writeFileSync(prompt, "started after Enter failure fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('started-after-enter-error-cat','Started After Enter Error',?)").run(pane);
    db.close();

    let started = false;
    let attempt = "";
    const runCommand = async (argv) => {
      if (argv[2] === "read") {
        return {
          exitCode: 0,
          stdout: started
            ? `Working (1s)\n⏺ Work completed\n${key}_DONE attempt=${attempt} finished\n\n❯`
            : "Idle\n❯",
        };
      }
      if (argv[2] === "send-text") attempt = argv[4].match(/\[attempt=([a-f0-9-]{36})\b/)?.[1] ?? "";
      if (argv[2] === "send-keys" && argv[4] === "Enter") {
        started = true;
        return { exitCode: 1, stdout: "" };
      }
      return { exitCode: 0, stdout: "" };
    };
    expect(await dispatch("started-after-enter-error-cat", key, prompt, {
      keepModel: true,
      runCommand,
      sleep: async () => {},
    })).toContain(`DISPATCH_OK started-after-enter-error-cat ${key} started after Enter error`);

    const stored = unitDb();
    const task = stored.query("SELECT * FROM tasks WHERE key=?").get(key);
    const send = JSON.parse(task.history).findLast((event) => event.ev === "send-attempted");
    expect(task.dispatch_attempt).toBe(attempt);
    expect(Date.parse(task.sent_at)).toBeGreaterThanOrEqual(Date.parse(send.at));
    expect(completionBelongsToDispatchAttempt(task, classify(`Working (1s)\n⏺ Work completed\n${key}_DONE attempt=${attempt} finished\n\n❯`).done)).toBe(true);
    stored.close();
  });

  it("retains failed-send reservations when idle confirmation or cleanup fails", async () => {
    const db = unitDb();
    const pane = "w-uncertain-cleanup:p1";
    const reservation = { pane, key: "UNCERTAIN-CLEANUP", attempt: "attempt-cleanup" };
    db.query("INSERT INTO cats(id,name,pane) VALUES('uncertain-cleanup-cat','Uncertain Cleanup',?)").run(pane);
    db.query("INSERT INTO tasks(key,cat,status,history,send_attempted) VALUES(?,'uncertain-cleanup-cat','dispatching',?,1)")
      .run(reservation.key, JSON.stringify([{ ev: "send-attempted", attempt: reservation.attempt }]));
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES(?,?,?)").run(pane, reservation.key, reservation.attempt);
    const readFailed = await reconcileFailedDispatch(db, reservation, async () => ({ exitCode: 1, stdout: "" }), async () => ({ exitCode: 0, stdout: "" }));
    expect(readFailed).toBe(false);
    expect(db.query("SELECT key FROM dispatch_reservations WHERE pane=?").get(pane).key).toBe(reservation.key);

    const cleanupFailed = await reconcileFailedDispatch(db, reservation, async () => ({ exitCode: 0, stdout: "Idle\n❯" }), async () => ({ exitCode: 1, stdout: "" }));
    expect(cleanupFailed).toBe(false);
    expect(db.query("SELECT key FROM dispatch_reservations WHERE pane=?").get(pane).key).toBe(reservation.key);
    db.close();
  });

  it("allows only one of two recovery watchers to clear pending pane input", async () => {
    const db = unitDb();
    const pane = "w-exclusive-clear:p1";
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('exclusive-clear-cat','Exclusive Clear',?)").run(pane);
    db.query(`INSERT INTO tasks(key,cat,status,history,send_attempted)
      VALUES('EXCLUSIVE-CLEAR','exclusive-clear-cat','send-failed-unconfirmed',?,1)`)
      .run(JSON.stringify([{ ev: "send-attempted", attempt: "exclusive-attempt" }]));
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run(pane, "EXCLUSIVE-CLEAR", "exclusive-attempt", reservedAt);
    const mutations = [];
    const runCommand = async (argv) => {
      if (argv[2] === "send-keys") mutations.push(argv);
      return { exitCode: 0, stdout: argv[2] === "read" ? "Idle\n❯" : "" };
    };
    const nowMs = Date.parse(reservedAt) + 11 * 60_000;
    const runWatcher = () => recoverInterruptedDispatches(db, [{ id: "exclusive-clear-cat", state: "idle" }], nowMs, runCommand);
    const results = await Promise.all([
      runWatcher(),
      runWatcher(),
    ]);
    expect(results.flat()).toEqual(["FLEET_SEND_FAILED_UNCONFIRMED EXCLUSIVE-CLEAR pane=w-exclusive-clear:p1 reservation_released"]);
    expect(mutations).toEqual([["herdr", "pane", "send-keys", pane, "ctrl+u"]]);
    expect(db.query("SELECT key FROM dispatch_reservations WHERE pane=?").get(pane)).toBeNull();
    db.close();
  });

  it("retries the same key after dispatch-held and dispatch-failed-before-send", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "same-key-unsent-prompt.txt");
    writeFileSync(prompt, "same key unsent fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('same-key-unsent-cat','Same Key Unsent','w-same-key-unsent:p1')").run();
    db.close();
    let reads = 0;
    const readIdleUntilWorking = async (argv) => ({
      exitCode: 0,
      stdout: argv[2] === "read" ? (++reads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "",
    });

    const held = await dispatch("same-key-unsent-cat", "UNSENT-RETRY", prompt, {
      runCommand: async (argv) => ({ exitCode: 0, stdout: argv[2] === "read" ? "Idle\n❯" : "" }),
      switchPaneModel: async () => "MODEL_SWITCH_FAILED fixture",
    });
    expect(held).toContain("MODEL_SWITCH_FAILED");
    const retriedHeld = await dispatch("same-key-unsent-cat", "UNSENT-RETRY", prompt, {
      keepModel: true, runCommand: readIdleUntilWorking, sleep: async () => {},
    });
    expect(retriedHeld).toContain("DISPATCH_OK");

    const failPrompt = join(unitHome, "same-key-failed-prompt.txt");
    writeFileSync(failPrompt, "same key exception fixture\n");
    const catDb = unitDb();
    catDb.query("INSERT INTO cats(id,name,pane) VALUES('same-key-exception-cat','Same Key Exception','w-same-key-exception:p1')").run();
    catDb.close();
    let secondReads = 0;
    const failed = await dispatch("same-key-exception-cat", "UNSENT-EXCEPTION", failPrompt, {
      runCommand: async (argv) => ({ exitCode: 0, stdout: argv[2] === "read" ? "Idle\n❯" : "" }),
      switchPaneModel: async () => { throw new Error("model picker interrupted"); },
    });
    expect(failed).toContain("DISPATCH_FAILED");
    const retriedFailed = await dispatch("same-key-exception-cat", "UNSENT-EXCEPTION", failPrompt, {
      keepModel: true,
      runCommand: async (argv) => ({ exitCode: 0, stdout: argv[2] === "read" ? (++secondReads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "" }),
      sleep: async () => {},
    });
    expect(retriedFailed).toContain("DISPATCH_OK");
  });

  it("retries the same task key after definitive pre-send failures", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "same-key-retry-prompt.txt");
    writeFileSync(prompt, "same key retry fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('same-key-cat','Same Key','w-same-key:p1')").run();
    db.close();
    const runCommand = async (argv) => ({ exitCode: 0, stdout: argv[2] === "read" ? "Idle\n❯" : "" });

    const failedBeforeSend = await dispatch("same-key-cat", "RETRY-SAME-KEY", prompt, {
      runCommand,
      switchPaneModel: async () => { throw new Error("MODEL_SWITCH_INTERRUPTED"); },
    });
    expect(failedBeforeSend).toContain("DISPATCH_FAILED same-key-cat RETRY-SAME-KEY");
    const heldDb = unitDb();
    expect(heldDb.query("SELECT status FROM tasks WHERE key='RETRY-SAME-KEY'").get().status).toBe("dispatch-failed-before-send");
    heldDb.close();
    const held = await dispatch("same-key-cat", "RETRY-SAME-KEY", prompt, {
      runCommand,
      switchPaneModel: async () => "MODEL_SWITCH_FAILED fixture",
    });
    expect(held).toContain("MODEL_SWITCH_FAILED");
    const heldAgain = unitDb();
    expect(heldAgain.query("SELECT status FROM tasks WHERE key='RETRY-SAME-KEY'").get().status).toBe("dispatch-held");
    heldAgain.close();
    let reads = 0;
    const retried = await dispatch("same-key-cat", "RETRY-SAME-KEY", prompt, {
      keepModel: true,
      runCommand: async (argv) => ({ exitCode: 0, stdout: argv[2] === "read" ? (++reads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "" }),
      sleep: async () => {},
    });
    expect(retried).toContain("DISPATCH_OK same-key-cat RETRY-SAME-KEY");
  });

  it("does not reclaim a refreshed send attempt or send after a reclaimed reservation", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "reservation-interleave-prompt.txt");
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const refreshedAt = new Date().toISOString();
    writeFileSync(prompt, "reservation interleave fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('interleave-cat','Interleave','w-interleave:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('INTERLEAVE-TASK','interleave-cat','dispatching','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-interleave:p1", "INTERLEAVE-TASK", "attempt-interleave", reservedAt);
    const snapshot = db.query("SELECT pane,key,attempt,reserved_at FROM dispatch_reservations WHERE key='INTERLEAVE-TASK'").get();

    db.query("UPDATE dispatch_reservations SET reserved_at=? WHERE key=?").run(refreshedAt, "INTERLEAVE-TASK");
    expect(recordDispatchSendAttempt(db, snapshot.pane, snapshot.key, snapshot.attempt)).toBe(true);
    expect(recoverDispatchReservation(db, snapshot, "idle", Date.parse(reservedAt) + 10 * 60_000)).toBeNull();
    expect(db.query("SELECT key,reserved_at FROM dispatch_reservations WHERE key='INTERLEAVE-TASK'").get())
      .toEqual({ key: "INTERLEAVE-TASK", reserved_at: refreshedAt });
    db.query("INSERT INTO cats(id,name,pane) VALUES('reclaim-cat','Reclaim','w-reclaim:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('RECLAIMED-TASK','reclaim-cat','dispatching','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-reclaim:p1", "RECLAIMED-TASK", "attempt-reclaimed", reservedAt);
    const reclaimedSnapshot = db.query("SELECT pane,key,attempt,reserved_at FROM dispatch_reservations WHERE key='RECLAIMED-TASK'").get();
    expect(recoverDispatchReservation(db, reclaimedSnapshot, "idle", Date.parse(reservedAt) + 10 * 60_000))
      .toBe("FLEET_DISPATCH_INTERRUPTED RECLAIMED-TASK pane=w-reclaim:p1 reservation_released");

    let switchStarted;
    let releaseSwitch;
    const started = new Promise((resolve) => { switchStarted = resolve; });
    const switchGate = new Promise((resolve) => { releaseSwitch = resolve; });
    const sendCalls = [];
    const runCommand = async (argv) => {
      sendCalls.push(argv);
      return { exitCode: 0, stdout: argv[2] === "read" ? "Idle\n❯" : "" };
    };
    db.query("UPDATE tasks SET status='dispatch-interrupted',history='[]' WHERE key=?").run("RECLAIMED-TASK");
    db.close();

    const dispatching = dispatch("reclaim-cat", "RECLAIMED-TASK", prompt, {
      runCommand,
      sleep: async () => {},
      switchPaneModel: async () => { switchStarted(); await switchGate; return "MODEL_SWITCHED fixture"; },
    });
    const switchOutcome = await Promise.race([
      started.then(() => "switch-started"),
      dispatching.then((result) => `returned:${result}`, (error) => `threw:${error?.message ?? error}`),
    ]);
    expect(switchOutcome).toBe("switch-started");
    const staleDb = unitDb();
    staleDb.query("UPDATE dispatch_reservations SET reserved_at=? WHERE key=?")
      .run(reservedAt, "RECLAIMED-TASK");
    expect(await recoverInterruptedDispatches(staleDb, [{ id: "reclaim-cat", state: "idle" }], Date.parse(reservedAt) + 11 * 60_000,
      async () => ({ exitCode: 0, stdout: "Idle\n❯" })))
      .toEqual(["FLEET_DISPATCH_INTERRUPTED RECLAIMED-TASK pane=w-reclaim:p1 reservation_released"]);
    staleDb.close();
    releaseSwitch();
    expect(await dispatching).toBe("DISPATCH_HOLD reclaim-cat reservation-expired; not sent");
    expect(sendCalls.some((argv) => argv[2] === "send-text")).toBe(false);
  });

  it("does not reclaim an expired reservation when the pane is unreadable", async () => {
    const db = unitDb();
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('unreadable-reservation-cat','Unreadable Reservation','w-unreadable-reservation:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('UNREADABLE-LEASE','unreadable-reservation-cat','dispatching','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-unreadable-reservation:p1", "UNREADABLE-LEASE", "attempt-unreadable", reservedAt);
    const events = await recoverInterruptedDispatches(db, [{ id: "unreadable-reservation-cat", state: "idle" }], Date.parse(reservedAt) + 10 * 60_000,
      async () => ({ exitCode: 1, stdout: "" }));
    expect(events).toEqual([]);
    expect(db.query("SELECT key FROM dispatch_reservations WHERE pane='w-unreadable-reservation:p1'").get().key).toBe("UNREADABLE-LEASE");
    expect(db.query("SELECT status FROM tasks WHERE key='UNREADABLE-LEASE'").get().status).toBe("dispatching");
    db.close();
  });

  it("keeps send-attempt evidence after history truncation", () => {
    const db = unitDb();
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('durable-send-cat','Durable Send','w-durable-send:p1')").run();
    const history = JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ ev: "noise", index })));
    db.query("INSERT INTO tasks(key,cat,status,history,send_attempted) VALUES('DURABLE-SEND','durable-send-cat','dispatching',?,1)").run(history);
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-durable-send:p1", "DURABLE-SEND", "durable-send-attempt", reservedAt);
    const reservation = db.query("SELECT pane,key,attempt,reserved_at FROM dispatch_reservations WHERE key=?").get("DURABLE-SEND");
    expect(recoverDispatchReservation(db, reservation, "idle", Date.parse(reservedAt) + 11 * 60_000)).toBeNull();
    expect(db.query("SELECT status FROM tasks WHERE key=?").get("DURABLE-SEND").status).toBe("dispatching");
    expect(db.query("SELECT key FROM dispatch_reservations WHERE pane=?").get("w-durable-send:p1").key).toBe("DURABLE-SEND");
    db.close();
  });

  it("does not grow duplicate recovery history across 50 question-state cycles", async () => {
    const db = unitDb();
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const history = JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ ev: "noise", index })));
    db.query("INSERT INTO cats(id,name,pane) VALUES('question-recovery-cat','Question Recovery','w-question-recovery:p1')").run();
    db.query(`INSERT INTO tasks(key,cat,status,history,completion_claimed,send_attempted)
      VALUES('QUESTION-RECOVERY','question-recovery-cat','dispatching',?,1,1)`).run(history);
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-question-recovery:p1", "QUESTION-RECOVERY", "question-recovery-attempt", reservedAt);
    const nowMs = Date.parse(reservedAt) + 11 * 60_000;
    for (let cycle = 0; cycle < 50; cycle++) {
      expect(await recoverInterruptedDispatches(db, [{ id: "question-recovery-cat", state: "question" }], nowMs,
        async () => ({ exitCode: 0, stdout: "Question pending\nNeed confirmation\n❯" }))).toEqual([]);
    }
    const task = db.query("SELECT status,history,completion_claimed,send_attempted FROM tasks WHERE key='QUESTION-RECOVERY'").get();
    const events = JSON.parse(task.history);
    expect(task.status).toBe("send-failed-unconfirmed");
    expect(task.completion_claimed).toBe(1);
    expect(task.send_attempted).toBe(1);
    expect(events).toHaveLength(40);
    expect(events.filter((event) => event.ev === "send-failed-unconfirmed")).toHaveLength(1);
    expect(events.some((event) => event.ev === "send-attempted" || event.ev === "done-claimed")).toBe(false);
    db.close();
  });

  it("claims recovery ownership before allowing picker Escape to mutate the pane", () => {
    const db = unitDb();
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('picker-race-cat','Picker Race','w-picker-race:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('PICKER-RACE','picker-race-cat','dispatching','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-picker-race:p1", "PICKER-RACE", "attempt-picker-race", reservedAt);
    const reservation = db.query("SELECT pane,key,attempt,reserved_at FROM dispatch_reservations WHERE key=?").get("PICKER-RACE");
    expect(classify("Select model\n→ model [provider]\n❯").state).toBe("model-picker");
    const recoveryToken = claimPickerRecoveryImmediatelyBeforeEscape(db, reservation, Date.parse(reservedAt) + 11 * 60_000);
    expect(recoveryToken).toBeTruthy();
    expect(db.query("SELECT recovery_token FROM dispatch_reservations WHERE key=?").get("PICKER-RACE").recovery_token).toBe(recoveryToken);
    expect(recordDispatchSendAttempt(db, reservation.pane, reservation.key, reservation.attempt)).toBe(false);
    expect(recoverDispatchReservation(db, { ...reservation, recoveryToken }, "idle", Date.parse(reservedAt) + 11 * 60_000))
      .toBe("FLEET_DISPATCH_INTERRUPTED PICKER-RACE pane=w-picker-race:p1 reservation_released");
    db.close();
  });

  it("recovers an expired dispatch and allows its task key to be retried", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "interrupted-dispatch-prompt.txt");
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(prompt, "interrupted dispatch fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('interrupted-cat','Interrupted','w-interrupted:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('INTERRUPTED-TASK','interrupted-cat','dispatching','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-interrupted:p1", "INTERRUPTED-TASK", "interrupted-attempt", reservedAt);
    db.close();

    const recovered = unitDb();
    const events = await recoverInterruptedDispatches(recovered, [{ id: "interrupted-cat", state: "idle" }], Date.parse(reservedAt) + 11 * 60_000,
      async () => ({ exitCode: 0, stdout: "Idle\n❯" }));
    expect(events).toEqual(["FLEET_DISPATCH_INTERRUPTED INTERRUPTED-TASK pane=w-interrupted:p1 reservation_released"]);
    expect(recovered.query("SELECT status FROM tasks WHERE key='INTERRUPTED-TASK'").get().status).toBe("dispatch-interrupted");
    expect(recovered.query("SELECT key FROM dispatch_reservations WHERE pane='w-interrupted:p1'").get()).toBeNull();
    recovered.close();

    let reads = 0;
    const result = await dispatch("interrupted-cat", "INTERRUPTED-TASK", prompt, {
      keepModel: true,
      sleep: async () => {},
      runCommand: async (argv) => ({
        exitCode: 0,
        stdout: argv[2] === "read" ? (++reads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "",
      }),
    });
    expect(result).toContain("DISPATCH_OK interrupted-cat INTERRUPTED-TASK");
  });

  it("preserves stale reservations when the pane read fails", async () => {
    const db = unitDb();
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('unreadable-cat','Unreadable','w-unreadable:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('UNREADABLE-TASK','unreadable-cat','dispatching','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-unreadable:p1", "UNREADABLE-TASK", "unreadable-attempt", reservedAt);
    const reads = [];
    const events = await recoverInterruptedDispatches(db, [{ id: "unreadable-cat", state: "idle" }], Date.parse(reservedAt) + 10 * 60_000, async (argv) => {
      reads.push(argv);
      return { exitCode: 1, stdout: "" };
    });
    expect(events).toEqual([]);
    expect(reads).toHaveLength(1);
    expect(db.query("SELECT status FROM tasks WHERE key=?").get("UNREADABLE-TASK").status).toBe("dispatching");
    expect(db.query("SELECT key FROM dispatch_reservations WHERE pane=?").get("w-unreadable:p1").key).toBe("UNREADABLE-TASK");
    db.close();
  });

  it("does not clear a fresh possibly-sent reservation from an idle pane", async () => {
    const db = unitDb();
    const reservedAt = new Date().toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('fresh-send-cat','Fresh Send','w-fresh-send:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('FRESH-SEND','fresh-send-cat','send-failed-unconfirmed',?)")
      .run(JSON.stringify([{ ev: "send-attempted", attempt: "attempt-fresh-send" }]));
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-fresh-send:p1", "FRESH-SEND", "attempt-fresh-send", reservedAt);
    const commands = [];
    const events = await recoverInterruptedDispatches(db, [{ id: "fresh-send-cat", state: "idle" }], Date.now(), async (argv) => {
      commands.push(argv);
      return { exitCode: 0, stdout: "Idle\n❯" };
    });
    expect(events).toEqual([]);
    expect(commands.map((argv) => argv[2])).toEqual(["read"]);
    expect(reservationLeaseExpiredAndOwned(db, { pane: "w-fresh-send:p1", key: "FRESH-SEND", attempt: "attempt-fresh-send", reserved_at: reservedAt }, Date.now())).toBe(false);
    expect(db.query("SELECT key FROM dispatch_reservations WHERE pane='w-fresh-send:p1'").get().key).toBe("FRESH-SEND");
    db.close();
  });

  it("releases an expired send-failed reservation so the pane can accept new work", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "after-send-failed-prompt.txt");
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(prompt, "after uncertain send fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('send-failed-recovery-cat','Send Failed','w-send-failed:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history,send_attempted) VALUES('SEND-ATTEMPTED-OLD','send-failed-recovery-cat','dispatching',?,1)")
      .run(JSON.stringify([{ ev: "send-attempted", attempt: "attempt-send-failed" }]));
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-send-failed:p1", "SEND-ATTEMPTED-OLD", "attempt-send-failed", reservedAt);
    const reservation = db.query("SELECT pane,key,attempt,reserved_at FROM dispatch_reservations WHERE key=?").get("SEND-ATTEMPTED-OLD");

    const events = await recoverInterruptedDispatches(db, [{ id: "send-failed-recovery-cat", state: "idle" }], Date.parse(reservedAt) + 11 * 60_000,
      async () => ({ exitCode: 0, stdout: "Idle\n❯" }));
    expect(events).toEqual(["FLEET_SEND_FAILED_UNCONFIRMED SEND-ATTEMPTED-OLD pane=w-send-failed:p1 reservation_released"]);
    expect(db.query("SELECT status FROM tasks WHERE key=?").get("SEND-ATTEMPTED-OLD").status).toBe("send-failed-unconfirmed");
    expect(db.query("SELECT key FROM dispatch_reservations WHERE pane='w-send-failed:p1'").get()).toBeNull();
    db.close();

    let reads = 0;
    const result = await dispatch("send-failed-recovery-cat", "AFTER-SEND-FAILED", prompt, {
      keepModel: true,
      sleep: async () => {},
      runCommand: async (argv) => ({
        exitCode: 0,
        stdout: argv[2] === "read" ? (++reads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "",
      }),
    });
    expect(result).toContain("DISPATCH_OK send-failed-recovery-cat AFTER-SEND-FAILED");
  });

  it("escapes and confirms the prompt before reclaiming a stale model-picker reservation", async () => {
    const db = unitDb();
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('picker-cat','Picker','w-picker:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('PICKER-TASK','picker-cat','dispatching','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-picker:p1", "PICKER-TASK", "picker-attempt", reservedAt);
    db.close();

    expect(classify("Select model\n→ claude-sonnet [anthropic]\n❯").state).toBe("model-picker");
    const calls = [];
    const recovered = unitDb();
    let reads = 0;
    const events = await recoverInterruptedDispatches(recovered, [{ id: "picker-cat", state: "model-picker" }], Date.parse(reservedAt) + 11 * 60_000, async (argv) => {
      calls.push(argv);
      if (argv[2] === "send-keys") {
        expect(recordDispatchSendAttempt(recovered, "w-picker:p1", "PICKER-TASK", "picker-attempt")).toBe(false);
      }
      return { exitCode: 0, stdout: argv[2] === "read" ? (++reads === 1 ? "Select model\n→ claude-sonnet [anthropic]\n❯" : "Idle\n❯") : "" };
    });
    expect(calls.map((argv) => argv.slice(1, 4))).toEqual([
      ["pane", "read", "w-picker:p1"],
      ["pane", "send-keys", "w-picker:p1"],
      ["pane", "send-keys", "w-picker:p1"],
      ["pane", "read", "w-picker:p1"],
    ]);
    expect(calls.map((argv) => argv[4]).filter((key) => key === "Escape" || key === "ctrl+u"))
      .toEqual(["Escape", "ctrl+u"]);
    expect(events).toEqual(["FLEET_DISPATCH_INTERRUPTED PICKER-TASK pane=w-picker:p1 reservation_released"]);
    expect(recovered.query("SELECT key FROM dispatch_reservations WHERE pane='w-picker:p1'").get()).toBeNull();
    recovered.close();
  });

  it("recovers a dirty dispatch-error reservation only after input is empty", async () => {
    const db = unitDb();
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('dirty-recovery-cat','Dirty Recovery','w-dirty-recovery:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,result,history) VALUES('DIRTY-RECOVERY','dirty-recovery-cat','dispatch-error','cleanup failed','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-dirty-recovery:p1", "DIRTY-RECOVERY", "dirty-recovery-attempt", reservedAt);
    let input = "/thinking xhigh";
    const calls = [];
    const events = await recoverInterruptedDispatches(db, [{ id: "dirty-recovery-cat", state: "idle" }],
      Date.parse(reservedAt) + 11 * 60_000, async (argv) => {
        calls.push(argv);
        if (argv[2] === "read") return { exitCode: 0, stdout: `Idle\n❯ ${input}` };
        if (argv[2] === "send-keys" && argv[4] === "ctrl+u") input = "";
        return { exitCode: 0, stdout: "" };
      });
    expect(calls.map((argv) => argv[2] === "read" ? "read" : argv[4])).toEqual(["read", "Escape", "ctrl+u", "read"]);
    expect(events).toEqual(["FLEET_DISPATCH_INTERRUPTED DIRTY-RECOVERY pane=w-dirty-recovery:p1 reservation_released"]);
    expect(db.query("SELECT status FROM tasks WHERE key='DIRTY-RECOVERY'").get().status).toBe("dispatch-interrupted");
    expect(db.query("SELECT key FROM dispatch_reservations WHERE key='DIRTY-RECOVERY'").get()).toBeNull();
    db.close();
  });

  it("keeps dispatch-error recovery reserved when cleanup cannot verify empty input", async () => {
    const db = unitDb();
    const reservedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('dirty-recovery-fail-cat','Dirty Recovery Fail','w-dirty-recovery-fail:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,result,history) VALUES('DIRTY-RECOVERY-FAIL','dirty-recovery-fail-cat','dispatch-error','cleanup failed','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-dirty-recovery-fail:p1", "DIRTY-RECOVERY-FAIL", "dirty-recovery-fail-attempt", reservedAt);
    let cleared = false;
    const events = await recoverInterruptedDispatches(db, [{ id: "dirty-recovery-fail-cat", state: "idle" }],
      Date.parse(reservedAt) + 11 * 60_000, async (argv) => {
        if (argv[2] === "read") {
          if (cleared) throw new Error("screen unavailable");
          return { exitCode: 0, stdout: "Idle\n❯ /thinking xhigh" };
        }
        if (argv[2] === "send-keys" && argv[4] === "ctrl+u") cleared = true;
        return { exitCode: 0, stdout: "" };
      });
    expect(events).toEqual([]);
    expect(db.query("SELECT status FROM tasks WHERE key='DIRTY-RECOVERY-FAIL'").get().status).toBe("dispatch-error");
    expect(db.query("SELECT key,recovery_token FROM dispatch_reservations WHERE key='DIRTY-RECOVERY-FAIL'").get())
      .toEqual({ key: "DIRTY-RECOVERY-FAIL", recovery_token: null });
    db.close();
  });

  it("does not escape a model picker while its reservation is fresh", async () => {
    const db = unitDb();
    const reservedAt = new Date().toISOString();
    db.query("INSERT INTO cats(id,name,pane) VALUES('fresh-picker-cat','Fresh Picker','w-fresh-picker:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES('FRESH-PICKER-TASK','fresh-picker-cat','dispatching','[]')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt,reserved_at) VALUES(?,?,?,?)")
      .run("w-fresh-picker:p1", "FRESH-PICKER-TASK", "fresh-picker-attempt", reservedAt);
    db.close();

    const calls = [];
    const recovered = unitDb();
    expect(await recoverInterruptedDispatches(recovered, [{ id: "fresh-picker-cat", state: "model-picker" }], Date.now(), async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "Idle\n❯" };
    })).toEqual([]);
    expect(calls.map((argv) => argv[2])).toEqual(["read"]);
    expect(recovered.query("SELECT key FROM dispatch_reservations WHERE pane='w-fresh-picker:p1'").get().key)
      .toBe("FRESH-PICKER-TASK");
    recovered.close();
  });

  it("reserves the pane before either concurrent dispatch can switch its model", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "model-reservation-prompt.txt");
    writeFileSync(prompt, "model reservation fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('model-reservation-cat','Model Reservation','w-model:p1')").run();
    db.close();

    let resolveSwitchGate;
    let switchCalls = 0;
    const switchCallbacks = [];
    const firstSwitch = new Promise((resolve) => { switchCallbacks.push(resolve); });
    const secondSwitch = new Promise((resolve) => { switchCallbacks.push(resolve); });
    const switchGate = new Promise((resolve) => { resolveSwitchGate = resolve; });
    const switchPaneModel = async () => {
      switchCallbacks[switchCalls++]();
      await switchGate;
      return "MODEL_SWITCHED fixture";
    };
    const runCommand = async (argv) => ({
      exitCode: 0,
      stdout: argv[2] === "read" ? "Idle\n❯" : "",
    });
    let first;
    let second;
    try {
      first = dispatch("model-reservation-cat", "MODEL-RESERVE-1", prompt, {
        runCommand,
        switchPaneModel,
        sleep: async () => {},
      });
      await firstSwitch;
      second = dispatch("model-reservation-cat", "MODEL-RESERVE-2", prompt, {
        runCommand,
        switchPaneModel,
        sleep: async () => {},
      });
      const outcome = await Promise.race([
        second.then((result) => ({ result })),
        secondSwitch.then(() => ({ switchEntered: true })),
      ]);
      expect(outcome).toEqual({ result: "DISPATCH_HOLD model-reservation-cat pane-reserved; not sent" });
      expect(switchCalls).toBe(1);
    } finally {
      resolveSwitchGate();
      await Promise.allSettled([first, second].filter(Boolean));
    }
  });

  it("holds a second dispatch on a pane while the first send is unresolved", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "reservation-prompt.txt");
    writeFileSync(prompt, "reservation fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('reservation-cat','Reservation','w-res:p1')").run();
    db.close();

    let beginSend;
    let releaseSend;
    const sendStarted = new Promise((resolve) => { beginSend = resolve; });
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const commands = [];
    const runCommand = async (argv) => {
      commands.push(argv);
      if (argv[2] === "read") return { exitCode: 0, stdout: "Idle\n❯" };
      if (argv[2] === "send-text") {
        beginSend();
        await sendGate;
      }
      return { exitCode: 0, stdout: "" };
    };

    const first = dispatch("reservation-cat", "RESERVATION-1", prompt, {
      keepModel: true,
      runCommand,
      sleep: async () => {},
    });
    await sendStarted;
    expect(await dispatch("reservation-cat", "RESERVATION-1", prompt, {
      keepModel: true,
      runCommand,
      sleep: async () => {},
    })).toBe("DISPATCH_HOLD reservation-cat duplicate-key; not sent");
    const second = await dispatch("reservation-cat", "RESERVATION-2", prompt, {
      keepModel: true,
      runCommand,
      sleep: async () => {},
    });
    expect(second).toBe("DISPATCH_HOLD reservation-cat pane-reserved; not sent");
    expect(commands.find((argv) => argv[2] === "send-text")?.[4]).toContain("[attempt=");
    releaseSend();
    expect(await first).toContain("DISPATCH_UNCONFIRMED reservation-cat RESERVATION-1");
  });

  it("releases a blocked task reservation so the pane can take a new dispatch", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "blocked-release-prompt.txt");
    writeFileSync(prompt, "after blocked fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('blocked-release-cat','Blocked Release','w-block:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status) VALUES('BLOCKED-OLD','blocked-release-cat','working')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES('w-block:p1','BLOCKED-OLD','attempt-blocked')").run();
    db.close();

    markTaskBlocked("BLOCKED-OLD", "not proceeding");
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key='BLOCKED-OLD'").get().status).toBe("blocked");
    expect(stored.query("SELECT key FROM dispatch_reservations WHERE pane='w-block:p1'").get()).toBeNull();
    stored.close();

    let reads = 0;
    const result = await dispatch("blocked-release-cat", "AFTER-BLOCKED", prompt, {
      keepModel: true,
      sleep: async () => {},
      runCommand: async (argv) => ({
        exitCode: 0,
        stdout: argv[2] === "read" ? (++reads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "",
      }),
    });
    expect(result).toContain("DISPATCH_OK blocked-release-cat AFTER-BLOCKED");
  });

  it("closes a task with a required reason and releases its active pane", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "closed-release-prompt.txt");
    writeFileSync(prompt, "dispatch after a closed task\n");
    db.query("INSERT INTO cats(id,name,pane,task) VALUES('closed-release-cat','Closed Release','w-closed:p1','CLOSED-OLD')").run();
    db.query("INSERT INTO tasks(key,cat,status) VALUES('CLOSED-OLD','closed-release-cat','working')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES('w-closed:p1','CLOSED-OLD','attempt-closed')").run();
    db.close();

    expect(await markTaskClosed("CLOSED-OLD", "owner closed stale acloud task"))
      .toBe("FLEET_TASK_CLOSED CLOSED-OLD reason=owner closed stale acloud task");
    expect(await markTaskClosed("CLOSED-OLD", "")).toBe("FLEET_TASK_CLOSE_ERROR CLOSED-OLD reason_required");
    const stored = unitDb();
    expect(stored.query("SELECT status,result FROM tasks WHERE key='CLOSED-OLD'").get())
      .toEqual({ status: "closed", result: "owner closed stale acloud task" });
    expect(stored.query("SELECT key FROM dispatch_reservations WHERE pane='w-closed:p1'").get()).toBeNull();
    expect(stored.query("SELECT task FROM cats WHERE id='closed-release-cat'").get().task).toBeNull();
    expect(JSON.parse(stored.query("SELECT history FROM tasks WHERE key='CLOSED-OLD'").get().history)
      .some((event) => event.ev === "closed" && event.reason === "owner closed stale acloud task")).toBe(true);
    stored.close();

    let reads = 0;
    const dispatched = await dispatch("closed-release-cat", "AFTER-CLOSED", prompt, {
      keepModel: true,
      sleep: async () => {},
      runCommand: async (argv) => ({
        exitCode: 0,
        stdout: argv[2] === "read" ? (++reads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "",
      }),
    });
    expect(dispatched).toContain("DISPATCH_OK closed-release-cat AFTER-CLOSED");
  });

  for (const status of ["dispatching", "sent-unconfirmed", "send-failed-unconfirmed"]) {
    it(`clears and verifies pane input before closing a ${status} task`, async () => {
      const db = unitDb();
      const pane = `w-close-${status}:p1`;
      const key = `CLOSE-${status.toUpperCase()}`;
      db.query("INSERT INTO cats(id,name,pane,task) VALUES(?,?,?,?)").run(key, key, pane, key);
      db.query("INSERT INTO tasks(key,cat,status) VALUES(?,?,?)").run(key, key, status);
      db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES(?,?,?)").run(pane, key, `attempt-${status}`);
      db.close();

      let input = "/thinking xhigh";
      const calls = [];
      const runCommand = async (argv) => {
        calls.push(argv);
        if (argv[2] === "read") return { exitCode: 0, stdout: `Idle\n❯ ${input}` };
        if (argv[2] === "send-keys" && argv[4] === "ctrl+u") input = "";
        return { exitCode: 0, stdout: "" };
      };
      expect(await markTaskClosed(key, "owner cancelled pending task", runCommand))
        .toBe(`FLEET_TASK_CLOSED ${key} reason=owner cancelled pending task`);
      const escape = calls.findIndex((argv) => argv[2] === "send-keys" && argv[4] === "Escape");
      const clear = calls.findIndex((argv) => argv[2] === "send-keys" && argv[4] === "ctrl+u");
      expect(escape).toBeGreaterThanOrEqual(0);
      expect(clear).toBeGreaterThan(escape);
      expect(calls.slice(clear + 1).some((argv) => argv[2] === "read")).toBe(true);
      const stored = unitDb();
      expect(stored.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("closed");
      expect(stored.query("SELECT key FROM dispatch_reservations WHERE key=?").get(key)).toBeNull();
      stored.close();
    });
  }

  for (const reserved of [false, true]) {
    it(`holds dispatch after a configured pane move with ${reserved ? "an old reservation" : "unresolved work"}`, async () => {
      const db = unitDb();
      const previous = db.query("SELECT * FROM cats WHERE id='crm'").get();
      const key = `STALE-PANE-${reserved}`;
      const nextKey = `${key}-NEXT`;
      const prompt = join(unitHome, `${key}.txt`);
      writeFileSync(prompt, "synthetic stale pane fixture\n");
      db.query(`INSERT INTO cats(id,name,pane,task) VALUES('crm','CRM','old-configured-pane',?)
        ON CONFLICT(id) DO UPDATE SET pane=excluded.pane,task=excluded.task`).run(key);
      db.query("INSERT INTO tasks(key,cat,status) VALUES(?,'crm',?)").run(key, reserved ? "send-failed-unconfirmed" : "working");
      if (reserved) db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES('old-configured-pane',?,'stale-pane-attempt')").run(key);
      const calls = [];
      try {
        const result = await dispatch("crm", nextKey, prompt, {
          keepModel: true,
          sleep: async () => {},
          runCommand: async argv => {
            calls.push(argv);
            return { exitCode: 0, stdout: argv[2] === "read" ? "Idle\n❯" : "" };
          },
        });
        expect(result).toBe(`DISPATCH_HOLD crm ${reserved ? "pane-reserved" : "prior-task-unresolved"}; not sent`);
        expect(calls.every(argv => argv[2] === "read" && argv[3] !== "old-configured-pane")).toBe(true);
        expect(db.query("SELECT key FROM tasks WHERE key=?").get(nextKey)).toBeNull();
        expect(db.query("SELECT task FROM cats WHERE id='crm'").get().task).toBe(key);
        if (reserved) expect(db.query("SELECT key FROM dispatch_reservations WHERE key=?").get(key)?.key).toBe(key);
      } finally {
        db.query("DELETE FROM dispatch_reservations WHERE key=?").run(key);
        db.query("DELETE FROM tasks WHERE key IN (?,?)").run(key, nextKey);
        if (previous) db.query("UPDATE cats SET pane=?,task=? WHERE id='crm'").run(previous.pane, previous.task);
        else db.query("DELETE FROM cats WHERE id='crm'").run();
        db.close();
      }
    });
  }

  it("retains a sent-unconfirmed reservation when input cleanup fails", async () => {
    const db = unitDb();
    const key = "TASK-SENT-UNCONFIRMED-CLEANUP-FAILURE";
    const pane = "uncertain-close:p1";
    db.query("INSERT INTO cats(id,name,pane,task) VALUES(?,'Uncertain Close',?,?)").run(key, pane, key);
    db.query("INSERT INTO tasks(key,cat,status) VALUES(?,?,'sent-unconfirmed')").run(key, key);
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES(?,?,'uncertain-close-attempt')").run(pane, key);
    db.close();
    const calls = [];
    expect(await markTaskClosed(key, "owner cancelled uncertain input", async argv => {
      calls.push(argv);
      if (argv[2] === "read") return { exitCode: 0, stdout: "Idle\n❯ stale instruction" };
      return { exitCode: argv[4] === "ctrl+u" ? 1 : 0, stdout: "" };
    })).toBe(`FLEET_TASK_CLOSE_ERROR ${key} input_cleanup_unverified`);
    expect(calls.some(argv => argv[4] === "ctrl+u")).toBe(true);
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("sent-unconfirmed");
    expect(stored.query("SELECT task FROM cats WHERE id=?").get(key).task).toBe(key);
    expect(stored.query("SELECT key,attempt,recovery_token FROM dispatch_reservations WHERE key=?").get(key))
      .toEqual({ key, attempt: "uncertain-close-attempt", recovery_token: null });
    expect(JSON.parse(stored.query("SELECT history FROM tasks WHERE key=?").get(key).history).some(event => event.ev === "closed")).toBe(false);
    stored.close();
  });

  it("clears the reservation pane rather than the current configured pane on close", async () => {
    const db = unitDb();
    const reservationPane = "w5:p1";
    db.query(`INSERT INTO cats(id,name,pane,task) VALUES('omonyang','Captain','w3:p2','CLOSE-OLD-PANE')
      ON CONFLICT(id) DO UPDATE SET pane=excluded.pane,task=excluded.task`).run();
    db.query("INSERT INTO tasks(key,cat,status) VALUES('CLOSE-OLD-PANE','omonyang','dispatching')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES(?,'CLOSE-OLD-PANE','old-pane-attempt')").run(reservationPane);
    db.close();

    let input = "/thinking xhigh";
    const calls = [];
    const runCommand = async (argv) => {
      calls.push(argv);
      if (argv[2] === "read") return { exitCode: 0, stdout: `Idle\n❯ ${input}` };
      if (argv[2] === "send-keys" && argv[4] === "ctrl+u") input = "";
      return { exitCode: 0, stdout: "" };
    };
    expect(await markTaskClosed("CLOSE-OLD-PANE", "owner cancelled pending task", runCommand))
      .toBe("FLEET_TASK_CLOSED CLOSE-OLD-PANE reason=owner cancelled pending task");
    expect(calls.every((argv) => argv[3] === reservationPane)).toBe(true);
    const stored = unitDb();
    expect(stored.query("SELECT key FROM dispatch_reservations WHERE key='CLOSE-OLD-PANE'").get()).toBeNull();
    stored.close();
  });

  it("keeps a pending close and reservation when empty input cannot be verified", async () => {
    const db = unitDb();
    const pane = "w-close-dirty:p1";
    db.query("INSERT INTO cats(id,name,pane,task) VALUES('CLOSE-DIRTY','Close Dirty',?,'CLOSE-DIRTY')").run(pane);
    db.query("INSERT INTO tasks(key,cat,status) VALUES('CLOSE-DIRTY','CLOSE-DIRTY','dispatching')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES(?,'CLOSE-DIRTY','attempt-close-dirty')").run(pane);
    db.close();

    const runCommand = async (argv) => {
      if (argv[2] === "read") {
        if (runCommand.cleared) throw new Error("screen unreadable after clear");
        return { exitCode: 0, stdout: "Idle\n❯ /thinking xhigh" };
      }
      if (argv[2] === "send-keys" && argv[4] === "ctrl+u") runCommand.cleared = true;
      return { exitCode: 0, stdout: "" };
    };
    expect(await markTaskClosed("CLOSE-DIRTY", "owner cancelled pending task", runCommand))
      .toBe("FLEET_TASK_CLOSE_ERROR CLOSE-DIRTY input_cleanup_unverified");
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key='CLOSE-DIRTY'").get().status).toBe("dispatching");
    expect(stored.query("SELECT recovery_token FROM dispatch_reservations WHERE key='CLOSE-DIRTY'").get().recovery_token).toBeNull();
    stored.close();
  });

  it("does not let blocked completion overwrite a closed task", async () => {
    const db = unitDb();
    db.query("INSERT INTO tasks(key,status,result) VALUES('CLOSED-TERMINAL','closed','owner closed it')").run();
    db.close();
    expect(markTaskBlocked("CLOSED-TERMINAL", "stale blocked marker")).toBe(false);
    expect((await markTaskClosed("CLOSED-TERMINAL", "second close")).startsWith("FLEET_TASK_CLOSE_HOLD")).toBe(true);
    const stored = unitDb();
    expect(stored.query("SELECT status,result FROM tasks WHERE key='CLOSED-TERMINAL'").get())
      .toEqual({ status: "closed", result: "owner closed it" });
    stored.close();
  });

  it("exposes manual close through the fleet command", async () => {
    const result = await runFleetCommand({
      catTask: "CLOSE-VIA-CLI",
      taskStatus: "working",
      command: ["close", "CLOSE-VIA-CLI", "owner", "closed", "stale", "task"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("FLEET_TASK_CLOSED CLOSE-VIA-CLI reason=owner closed stale task");
    expect(result.taskStatus).toBe("closed");
    expect(result.taskHistory.some((event) => event.ev === "closed" && event.reason === "owner closed stale task")).toBe(true);
  });

  it("does not treat a closed task as a prior unresolved track", async () => {
    const db = unitDb();
    db.query("INSERT INTO cats(id,name,pane) VALUES('closed-track-cat','Closed Track','w-closed-track:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status,result) VALUES('CLOSED-TRACK-OLD','closed-track-cat','closed','owner closed it')").run();
    expect(await track("TASK-AFTER-CLOSED-TRACK", "closed-track-cat", "cmd:true", "new work"))
      .toBe("TRACKED_UNCONFIRMED TASK-AFTER-CLOSED-TRACK on closed-track-cat");
    const tracked = db.query("SELECT * FROM tasks WHERE key='TASK-AFTER-CLOSED-TRACK'").get();
    expect(tracked.status).toBe("tracked-unconfirmed");
    expect(completionBelongsToDispatchAttempt(tracked, classify("⏺ Tracked work complete\nTASK-AFTER-CLOSED-TRACK_DONE finished\n\n❯").done)).toBe(true);
    expect(JSON.parse(tracked.history).some((event) => event.ev === "tracked")).toBe(true);
    db.close();
  });

  it("releases a prompt-lost task reservation so the pane can take a new dispatch", async () => {
    const db = unitDb();
    const prompt = join(unitHome, "prompt-lost-release-prompt.txt");
    writeFileSync(prompt, "after prompt lost fixture\n");
    db.query("INSERT INTO cats(id,name,pane) VALUES('prompt-lost-release-cat','Prompt Lost Release','w-lost:p1')").run();
    db.query("INSERT INTO tasks(key,cat,status) VALUES('PROMPT-LOST-OLD','prompt-lost-release-cat','working')").run();
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES('w-lost:p1','PROMPT-LOST-OLD','attempt-lost')").run();
    db.close();

    markTaskPromptLost("PROMPT-LOST-OLD");
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key='PROMPT-LOST-OLD'").get().status).toBe("prompt-lost");
    expect(stored.query("SELECT key FROM dispatch_reservations WHERE pane='w-lost:p1'").get()).toBeNull();
    stored.close();

    let reads = 0;
    const result = await dispatch("prompt-lost-release-cat", "AFTER-PROMPT-LOST", prompt, {
      keepModel: true,
      sleep: async () => {},
      runCommand: async (argv) => ({
        exitCode: 0,
        stdout: argv[2] === "read" ? (++reads < 3 ? "Idle\n❯" : "Working (1s)\n❯") : "",
      }),
    });
    expect(result).toContain("DISPATCH_OK prompt-lost-release-cat AFTER-PROMPT-LOST");
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

  for (const kind of ["DONE", "BLOCKED"]) {
    for (const suffix of [
      "\nattempt=12345678-1234-4234-8234-123456789abc finished",
      " attempt=\n12345678-1234-4234-8234-123456789abc finished",
      " attempt=12345678-1234-4234-\n8234-123456789abc finished",
    ]) {
      it(`recognizes a wrapped ${kind} attempt ID (${JSON.stringify(suffix)})`, () => {
        const done = classify(`⏺ Completed response\nTASK-WRAPPED_${kind}${suffix}\n\n❯`).done;
        expect(done).toEqual({ key: "TASK-WRAPPED", kind, attempt: "12345678-1234-4234-8234-123456789abc", text: "finished" });
        expect(completionBelongsToDispatchAttempt({ status: "working", dispatch_attempt: done.attempt, send_attempted: 1, history: "[]" }, done)).toBe(true);
      });
    }
  }
  it("does not borrow an attempt ID from a separate response after a completion marker", () => {
    expect(classify("⏺ Completed response\nTASK-WRAPPED_DONE\n⏺ Different response\nattempt=12345678-1234-4234-8234-123456789abc unrelated\n\n❯").done?.attempt).toBeNull();
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
    expect(classify(screen).done).toEqual({ key: "TASK-X", kind: "DONE", attempt: null, text: "finished" });
  });

  it("finds a completion marker before Omo throughput and advances its task", async () => {
    const attempt = "10000000-0000-4000-8000-000000000001";
    const screen = [
      "⏺ Response block",
      "",
      `TASK-X-1_DONE attempt=${attempt} summary`,
      "",
      " TPS 35.3 tok/s. Cache hit 96.5%, 659.5s",
      "",
      "────",
      "❯",
    ].join("\n");
    expect(classify(screen).done).toEqual({ key: "TASK-X-1", kind: "DONE", attempt, text: "summary" });
    const result = await runWatchCycle({
      catTask: "TASK-X-1",
      taskStatus: "working",
      dispatchAttempt: attempt,
      taskHistory: [{ ev: "send-attempted", attempt, at: "2026-10-12T00:00:00.000Z" }],
      taskSentAt: "2026-10-12T00:00:01.000Z",
      paneScreen: screen,
    });
    expect(result.output).toContain("FLEET_TASK_DONE crm TASK-X-1 summary");
    expect(result.taskStatus).toBe("done-claimed");
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
  for (const ok of [true, false]) {
    it(`keeps owner closure terminal during an asynchronous ${ok ? "passing" : "failing"} verification`, async () => {
      const db = unitDb();
      const key = `VERIFY-CLOSED-DURING-CHECK-${ok}`;
      db.query("INSERT INTO tasks(key,cat,done,status,completion_claimed) VALUES(?,'verify-race-cat','cmd:synthetic','done-claimed',1)").run(key);
      db.close();
      let started;
      const checking = new Promise(resolve => { started = resolve; });
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const verification = verify(key, async () => { started(); await pending; return { ok, detail: "synthetic check" }; });
      await checking;
      expect(await markTaskClosed(key, "owner closed during check")).toContain(`FLEET_TASK_CLOSED ${key}`);
      finish();
      expect(await verification).toBe(`VERIFY_CLOSED ${key}: task is terminal`);
      const stored = unitDb();
      const task = stored.query("SELECT status,result,evidence,history FROM tasks WHERE key=?").get(key);
      expect(task.status).toBe("closed");
      expect(task.result).toBe("owner closed during check");
      expect(task.evidence).toBeNull();
      expect(JSON.parse(task.history).some(event => ["verified", "not-done"].includes(event.ev))).toBe(false);
      stored.close();
    });
  }
  it("re-verifies not-done tasks with prior completion claims during watch polling", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE tasks(key TEXT,done TEXT,status TEXT,completion_claimed INTEGER)");
    db.query("INSERT INTO tasks(key,done,status,completion_claimed) VALUES('RETRY-PR-REAL','pr:owner/repo#1','not-done',1)").run();
    db.query("INSERT INTO tasks(key,done,status,completion_claimed) VALUES('NOT-A-CLAIM','cmd:true','not-done',1)").run();
    const storage = unitDb();
    storage.query("INSERT INTO tasks(key,cat,done,status,history,completion_claimed) VALUES('RETRY-PR-REAL','crm','pr:owner/repo#1','not-done','[]',1)").run();
    const keys = [];
    const checked = [];
    const events = await retryNotDoneTasks(db, async (key) => {
      keys.push(key);
      return verify(key, async (signal) => {
        checked.push(signal);
        return { ok: false, detail: "state=OPEN" };
      });
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("NOT_DONE RETRY-PR-REAL");
    expect(keys).toEqual(["RETRY-PR-REAL"]);
    expect(checked).toEqual(["pr:owner/repo#1"]);
    db.close();
    storage.close();
  });

  it("keeps not-done PRs in active Bugbot polling", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE tasks(key TEXT, done TEXT, status TEXT, sent_at TEXT)");
    db.query("INSERT INTO tasks(key,done,status,sent_at) VALUES('NOT-DONE-BUGBOT','pr:owner/repo#7','not-done','1')").run();
    const polled = [];
    await bugbotLimitEvents(db, new Map(), async (signal) => {
      polled.push(signal);
      return null;
    });
    expect(polled).toEqual(["pr:owner/repo#7"]);
    db.close();
  });

  it("retries not-done tasks with completion claims and skips unrelated tasks", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE tasks(key TEXT,done TEXT,status TEXT,history TEXT,completion_claimed INTEGER)");
    db.query("INSERT INTO tasks(key,status,done,history,completion_claimed) VALUES('NOT-DONE-PR','not-done','pr:owner/repo#1',?,1)")
      .run(JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ ev: "not-done", index }))));
    db.query("INSERT INTO tasks(key,status,done,history,completion_claimed) VALUES('NOT-DONE-NO-CLAIM','not-done','pr:owner/repo#2','[]',0)").run();

    const retried = [];
    expect(await retryNotDoneTasks(db, async (key) => {
      retried.push(key);
      return `VERIFY_RETRY ${key}`;
    })).toEqual(["VERIFY_RETRY NOT-DONE-PR"]);
    expect(retried).toEqual(["NOT-DONE-PR"]);
    db.close();
  });

  it("caps PR retries at three per cycle and rotates through the backlog", async () => {
    const picker = new Database(":memory:");
    picker.exec("CREATE TABLE tasks(key TEXT,done TEXT,status TEXT,completion_claimed INTEGER)");
    const storage = unitDb();
    const keys = Array.from({ length: 7 }, (_, index) => `ROTATING-PR-${index + 1}`);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      const signal = `pr:owner/repo#${index + 1}`;
      picker.query("INSERT INTO tasks(key,done,status,completion_claimed) VALUES(?,?,'not-done',1)").run(key, signal);
      storage.query(`INSERT INTO tasks(key,cat,done,status,history,completion_claimed)
        VALUES(?,'crm',?,'not-done','[]',1)`).run(key, signal);
    }
    const checked = [];
    let active = 0;
    let maximum = 0;
    const verifyTask = async (key) => {
      checked.push(key);
      return verify(key, async () => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return { ok: false, detail: "state=OPEN" };
      });
    };
    const first = await retryNotDoneTasks(picker, verifyTask);
    const second = await retryNotDoneTasks(picker, verifyTask);
    const third = await retryNotDoneTasks(picker, verifyTask);
    expect([first.length, second.length, third.length]).toEqual([3, 3, 3]);
    expect(new Set(checked.slice(0, 7)).size).toBe(7);
    expect(checked.slice(0, 7).sort()).toEqual(keys.slice().sort());
    expect(maximum).toBe(3);
    picker.close();
    storage.close();
  });

  it("re-verifies after 45 failures and completes when durable ACCEPT evidence is present", async () => {
    const db = unitDb();
    const key = "VERIFY-45-FAILURES";
    const head = "0123456789abcdef0123456789abcdef01234567";
    const history = [
      { ev: "done-claimed", text: "ready" },
      ...Array.from({ length: 38 }, (_, index) => ({ ev: "not-done", detail: `prior-${index}` })),
    ];
    db.query(`INSERT INTO tasks(key,cat,done,status,history,completion_claimed,claim_evidence)
      VALUES(?,?,?,'not-done',?,1,'{}')`)
      .run(key, "reservation-cat", "pr:owner/repo#1", JSON.stringify(history));
    let failedChecks = 0;
    const failedCheck = async () => {
      failedChecks++;
      return { ok: false, detail: `state=OPEN attempt=${failedChecks}`, headRefOid: head };
    };
    for (let attempt = 0; attempt < 45; attempt++) {
      expect(await verify(key, failedCheck)).toContain(`NOT_DONE ${key}`);
    }
    expect(failedChecks).toBe(45);
    const capped = db.query("SELECT history,completion_claimed,claim_evidence FROM tasks WHERE key=?").get(key);
    expect(JSON.parse(capped.history)).toHaveLength(40);
    expect(JSON.parse(capped.history).some((event) => event.ev === "done-claimed" || event.ev === "claim-ok")).toBe(false);
    expect(capped.completion_claimed).toBe(1);
    expect(JSON.parse(capped.claim_evidence)).toEqual({});

    recordTaskClaimEvidence(db, key, {
      kind: "cursor-accept", ok: true, head, acceptedPrefix: head.slice(0, 8), actualHead: head, detail: "slack_author_full_head_match",
    });
    recordTaskClaimEvidence(db, key, {
      kind: "pr-ready", ok: true, head, acceptedPrefix: head.slice(0, 10), actualHead: head, detail: "pr_head_match",
    });
    const verified = await verify(key, async () => ({
      ok: true, detail: "merged", headRefOid: head, mergeCommit: "f".repeat(40),
    }));
    expect(verified).toContain(`VERIFIED_DONE ${key}`);
    expect(db.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("verified-done");
    db.close();
  });

  it("matches bundled PR claims to every configured completion signal", async () => {
    const db = unitDb();
    const key = "VERIFY-MULTI-PR";
    const signalOne = "pr:owner/one#11";
    const signalTwo = "pr:owner/two#22";
    const heads = {
      [signalOne]: "1111111111111111111111111111111111111111",
      [signalTwo]: "2222222222222222222222222222222222222222",
    };
    const task = {
      key,
      sent_at: "2026-10-12T10:00:00.000Z",
      done: `${signalOne};${signalTwo}`,
    };
    db.query(`INSERT INTO tasks(key,cat,done,status,sent_at,history,completion_claimed,claim_evidence)
      VALUES(?,?,?,'done-claimed',?,'[]',1,'{}')`)
      .run(key, "reservation-cat", task.done, task.sent_at);
    const claims = await verifyClaims([
      `Cursor ACCEPT owner/two#22 head=${heads[signalTwo].slice(0, 8)}`,
      `owner/two#22 PR READY head=${heads[signalTwo].slice(0, 8)}`,
      `Cursor ACCEPT owner/one#11 head=${heads[signalOne].slice(0, 8)}`,
      `owner/one#11 PR READY head=${heads[signalOne].slice(0, 8)}`,
    ].join("\n"), task, {
      getPrHead: async (signal) => heads[signal],
      slackHasHead: async (head, sentAt, pr) => sentAt === task.sent_at
        && head === heads[`pr:${pr.repo}#${pr.prNumber}`],
    });
    expect(claims.map(({ kind, signal, ok }) => ({ kind, signal, ok }))).toEqual([
      { kind: "cursor-accept", signal: signalTwo, ok: true },
      { kind: "cursor-accept", signal: signalOne, ok: true },
      { kind: "pr-ready", signal: signalTwo, ok: true },
      { kind: "pr-ready", signal: signalOne, ok: true },
    ]);
    for (const claim of claims) recordTaskClaimEvidence(db, key, claim);
    const verified = await verify(key, async (signal) => ({
      ok: true, detail: "merged", headRefOid: heads[signal], mergeCommit: "f".repeat(40),
    }));
    expect(verified).toContain(`VERIFIED_DONE ${key}`);
    expect(db.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("verified-done");
    db.close();
  });

  it("preserves concurrent task history appends", async () => {
    const db = unitDb();
    const key = "HISTORY-CONCURRENT";
    db.query("INSERT INTO tasks(key,cat,status,history) VALUES(?,'reservation-cat','working','[]')").run(key);
    db.close();

    const first = unitDb();
    const second = unitDb();
    await Promise.all([
      Promise.resolve().then(() => appendTaskHistory(first, key, { ev: "done-claimed", text: "finished" })),
      Promise.resolve().then(() => appendTaskHistory(second, key, { ev: "claim-ok", claim: "cursor-accept" })),
    ]);
    first.close();
    second.close();

    const stored = unitDb();
    const history = JSON.parse(stored.query("SELECT history FROM tasks WHERE key=?").get(key).history);
    expect(history.map((event) => event.ev)).toEqual(["done-claimed", "claim-ok"]);
    stored.close();
  });

  it("checks PR signals using injected argv commands and validates full object IDs", async () => {
    const calls = [];
    const head = "0123456789abcdef0123456789abcdef01234567";
    const merge = "abcdef0123456789abcdef0123456789abcdef01";
    const result = await checkSignal("pr:whelp99-code/jm-omo#77", async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: JSON.stringify({ state: "MERGED", headRefOid: head, mergeCommit: { oid: merge } }) };
    });
    expect(calls).toEqual([["gh", "pr", "view", "77", "--repo", "whelp99-code/jm-omo", "--json", "state,mergeCommit,headRefOid"]]);
    expect(result).toMatchObject({ ok: true, headRefOid: head, mergeCommit: merge });

    const failed = await checkSignal("pr:whelp99-code/jm-omo#77", async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ state: "MERGED", headRefOid: "short", mergeCommit: { oid: "short" } }),
    }));
    expect(failed).toMatchObject({ ok: false, headRefOid: undefined, mergeCommit: undefined });
  });

  it("records bounded, deduplicated context for swallowed PR and Slack errors", async () => {
    const lines = [];
    const originalLog = console.log;
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    const task = {
      key: "VERIFY-ERROR-LOG",
      sent_at: "2026-10-12T10:00:00.000Z",
      done: "pr:owner/repo#97",
    };
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const failHead = async () => { throw new Error("g".repeat(200)); };
      await verifyClaims(`Cursor ACCEPT head=${head.slice(0, 8)}`, task, { getPrHead: failHead });
      await verifyClaims(`Cursor ACCEPT head=${head.slice(0, 8)}`, task, { getPrHead: failHead });
      await verifyClaims(`Cursor ACCEPT head=${head.slice(0, 8)}`, task, {
        getPrHead: async () => head,
        slackHasHead: async () => { throw new Error("Slack request timeout"); },
      });
    } finally {
      console.log = originalLog;
    }
    const headErrors = lines.filter((line) => line.startsWith("FLEET_PR_HEAD_VERIFY_ERROR signal=pr:owner/repo#97 "));
    expect(headErrors).toHaveLength(1);
    const errorPrefix = "FLEET_PR_HEAD_VERIFY_ERROR signal=pr:owner/repo#97 ";
    expect(headErrors[0].slice(errorPrefix.length)).toHaveLength(120);
    expect(lines.some((line) => line === "FLEET_SLACK_ACCEPT_CHECK_ERROR signal=pr:owner/repo#97 Slack request timeout")).toBe(true);
  });

  it("rejects unsupported and credential-bearing curl URLs without executing them", async () => {
    const calls = [];
    for (const signal of [
      "url:ftp://example.com/status=200",
      "url:https://user:password@example.com/status=200",
    ]) {
      expect(await checkSignal(signal, async (argv) => { calls.push(argv); return { exitCode: 0, stdout: "200" }; }))
        .toMatchObject({ ok: false, detail: "unsupported URL" });
    }
    expect(calls).toHaveLength(0);

    const accepted = await checkSignal("url:https://example.com/status=200", async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "200" };
    });
    expect(accepted).toMatchObject({ ok: true, httpCode: 200 });
    expect(calls[0]).toEqual(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "6", "--", "https://example.com/status"]);
  });

  it("requires Cursor acceptance and an exact PR head before verified-done", async () => {
    const db = unitDb();
    const key = "VERIFY-CLAIMS";
    const head = "0123456789abcdef0123456789abcdef01234567";
    const history = [
      { ev: "reserved", attempt: "attempt-123" },
      { ev: "claim-ok", claim: "cursor-accept", head, acceptedPrefix: head, actualHead: head, detail: "slack_author_full_head_match" },
      { ev: "claim-ok", claim: "pr-ready", head, acceptedPrefix: head, actualHead: head, detail: "pr_head_match" },
    ];
    db.query("INSERT INTO tasks(key,cat,done,status,history) VALUES(?,?,?,'done-claimed',?)")
      .run(key, "reservation-cat", "pr:whelp99-code/jm-omo#77", JSON.stringify(history));
    db.query("INSERT INTO dispatch_reservations(pane,key,attempt) VALUES(?,?,?)")
      .run("w-verify:p1", key, "attempt-123");
    db.close();

    const result = await verify(key, async () => ({
      ok: true,
      headRefOid: "0123456789abcdef0123456789abcdef01234567",
      mergeCommit: "abcdef0123456789abcdef0123456789abcdef01",
    }));
    expect(result).toContain("VERIFIED_DONE VERIFY-CLAIMS");
    const stored = unitDb();
    const task = stored.query("SELECT status,evidence FROM tasks WHERE key=?").get(key);
    expect(task.status).toBe("verified-done");
    expect(JSON.parse(task.evidence)).toMatchObject({
      attempt: "attempt-123",
      claims: [{ headRefOid: head, cursorAccept: { headRefOid: head, acceptedPrefix: head, ok: true }, prReady: { headRefOid: head, acceptedPrefix: head, actualHead: head, ok: true } }],
    });
    stored.close();
  });

  it("rejects a merged head different from the recorded ACCEPT and PR READY heads", async () => {
    const db = unitDb();
    const key = "VERIFY-OLD-HEAD";
    const headA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    db.query("INSERT INTO tasks(key,cat,done,status,result,history,completion_claimed) VALUES(?,?,?,'done-claimed','finished',?,1)")
      .run(key, "reservation-cat", "pr:whelp99-code/jm-omo#79", JSON.stringify([
        { ev: "claim-ok", claim: "cursor-accept", head: headA, acceptedPrefix: headA, actualHead: headA, detail: "slack_author_full_head_match" },
        { ev: "claim-ok", claim: "pr-ready", head: headA, acceptedPrefix: headA, actualHead: headA, detail: "pr_head_match" },
      ]));
    db.close();

    const result = await verify(key, async () => ({ ok: true, headRefOid: headB, mergeCommit: "c".repeat(40) }));
    expect(result).toContain("NOT_DONE VERIFY-OLD-HEAD");
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("not-done");
    stored.close();
  });

  it("normalizes abbreviated accepted and PR READY heads to the full merged head", async () => {
    const db = unitDb();
    const key = "VERIFY-SHORT-HEAD";
    const fullHead = "abcdef0123456789abcdef0123456789abcdef01";
    const sentAt = "2026-10-12T00:00:00.000Z";
    let slackHead;
    const claims = await verifyClaims("Cursor ACCEPT head=abcdef01\nPR READY head=abcdef0123", {
      sent_at: sentAt,
      done: "pr:whelp99-code/jm-omo#81",
    }, {
      slackHasHead: async (head) => { slackHead = head; return head === fullHead; },
      getPrHead: async () => fullHead,
    });
    expect(slackHead).toBe(fullHead);
    expect(claims).toMatchObject([
      { kind: "cursor-accept", ok: true, head: fullHead, acceptedPrefix: "abcdef01", actualHead: fullHead },
      { kind: "pr-ready", ok: true, head: fullHead, acceptedPrefix: "abcdef0123", actualHead: fullHead },
    ]);
    db.query("INSERT INTO tasks(key,cat,done,status,result,history) VALUES(?,?,?,'done-claimed','finished',?)")
      .run(key, "reservation-cat", "pr:whelp99-code/jm-omo#81", JSON.stringify([
        ...claims.map((claim) => ({ ev: "claim-ok", claim: claim.kind, head: claim.head, acceptedPrefix: claim.acceptedPrefix, actualHead: claim.actualHead, detail: claim.detail })),
      ]));
    db.close();

    const result = await verify(key, async () => ({ ok: true, headRefOid: fullHead, mergeCommit: "e".repeat(40) }));
    expect(result).toContain("VERIFIED_DONE VERIFY-SHORT-HEAD");
    const stored = unitDb();
    const task = stored.query("SELECT status,evidence FROM tasks WHERE key=?").get(key);
    expect(task.status).toBe("verified-done");
    expect(JSON.parse(task.evidence).claims[0]).toMatchObject({
      headRefOid: fullHead,
      cursorAccept: { headRefOid: fullHead, acceptedPrefix: "abcdef01", ok: true },
      prReady: { headRefOid: fullHead, acceptedPrefix: "abcdef0123", actualHead: fullHead, ok: true },
    });
    stored.close();
  });

  it("retries failed verification after matching claims arrive without changing DONE", async () => {
    const db = unitDb();
    const key = "VERIFY-RETRY";
    const headA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const done = "pr:whelp99-code/jm-omo#80";
    db.query("INSERT INTO tasks(key,cat,done,status,result,history,completion_claimed) VALUES(?,?,?,'done-claimed','finished',?,1)")
      .run(key, "reservation-cat", done, JSON.stringify([
        { ev: "done-claimed", text: "finished" },
        { ev: "claim-ok", claim: "cursor-accept", head: headA, acceptedPrefix: headA, actualHead: headA, detail: "slack_author_full_head_match" },
        { ev: "claim-ok", claim: "pr-ready", head: headA, acceptedPrefix: headA, actualHead: headA, detail: "pr_head_match" },
      ]));
    db.close();

    const first = await verify(key, async () => ({ ok: false, headRefOid: headB }));
    expect(first).toContain("NOT_DONE VERIFY-RETRY");
    const second = await verify(key, async () => ({ ok: true, headRefOid: headA, mergeCommit: "d".repeat(40) }));
    expect(second).toContain("VERIFIED_DONE VERIFY-RETRY");
    const stored = unitDb();
    expect(stored.query("SELECT status,done FROM tasks WHERE key=?").get(key)).toEqual({ status: "verified-done", done });
    stored.close();
  });

  it("retries failed verification after a bare DONE claim with an empty result", async () => {
    const db = unitDb();
    const key = "VERIFY-EMPTY-RESULT";
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    db.query("INSERT INTO tasks(key,cat,done,status,result,history,completion_claimed) VALUES(?,?,?,'not-done','',?,1)")
      .run(key, "reservation-cat", "pr:whelp99-code/jm-omo#82", JSON.stringify([
        { ev: "done-claimed", text: "" },
        { ev: "claim-ok", claim: "cursor-accept", head, acceptedPrefix: head.slice(0, 8), actualHead: head, detail: "slack_author_full_head_match" },
        { ev: "claim-ok", claim: "pr-ready", head, acceptedPrefix: head.slice(0, 10), actualHead: head, detail: "pr_head_match" },
        { ev: "not-done", detail: "PR was not merged yet" },
      ]));
    db.close();

    const result = await verify(key, async () => ({ ok: true, headRefOid: head, mergeCommit: "f".repeat(40) }));
    expect(result).toContain("VERIFIED_DONE VERIFY-EMPTY-RESULT");
    const stored = unitDb();
    expect(stored.query("SELECT status,result FROM tasks WHERE key=?").get(key))
      .toEqual({ status: "verified-done", result: "" });
    stored.close();
  });

  it("retains an unverified PR task when Cursor claim evidence is missing", async () => {
    const db = unitDb();
    const key = "VERIFY-MISSING-CLAIM";
    db.query("INSERT INTO tasks(key,cat,done,status,history) VALUES(?,?,?,'done-claimed',?)")
      .run(key, "reservation-cat", "pr:whelp99-code/jm-omo#78", JSON.stringify([
        { ev: "claim-ok", claim: "pr-ready", detail: "pr_head_match" },
      ]));
    db.close();

    const result = await verify(key, async () => ({ ok: true }));
    expect(result).toContain("NOT_DONE VERIFY-MISSING-CLAIM");
    const stored = unitDb();
    expect(stored.query("SELECT status FROM tasks WHERE key=?").get(key).status).toBe("not-done");
    stored.close();
  });

  it("accepts full SHA only when the ACCEPT identifies the target PR", async () => {
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: `ACCEPT owner/jm-omo#5 head=${head}` },
      { user: "UOTHER", text: `ACCEPT owner/jm-omo#5 head=${head}` },
    ], head, { repo: "owner/jm-omo", prNumber: "5" })).toBe(true);
    expect(await cursorHeadMatches([
      { user: "UOTHER", text: `ACCEPT owner/jm-omo#5 head=${head}` },
      { user: "U0B81F5GR6V", text: `ACCEPT owner/jm-omo#99 head=${head}` },
    ], head, { repo: "owner/jm-omo", prNumber: "5" })).toBe(false);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: `ACCEPT jm-omo PR5 head=${head}` },
    ], head, { repo: "owner/jm-omo", prNumber: "5" })).toBe(true);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: `ACCEPT head=${head}` },
    ], head)).toBe(false);
  });

  it("requires PR context for short Slack SHA tokens but accepts an exact full SHA", async () => {
    const head = "ce1cbb7b17d38b58c55e22e24963ca96afcbb0b3";
    const options = {
      repo: "whelp99-code/jm-omo",
      prNumber: "5",
    };
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: "ACCEPT head=ce1cbb7b" },
    ], head, options, async () => ({ exitCode: 0, stdout: `${head}\n` }))).toBe(false);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: "ACCEPT jm-omo PR5 head=ce1cbb7b" },
    ], head, options, async () => ({ exitCode: 0, stdout: `${head}\n` }))).toBe(true);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: "ACCEPT jm-omo PR99 head=ce1cbb7b" },
    ], head, options, async () => ({ exitCode: 0, stdout: `${head}\n` }))).toBe(false);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: "ACCEPT other-repo#5 head=ce1cbb7b" },
    ], head, options, async () => ({ exitCode: 0, stdout: `${head}\n` }))).toBe(false);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: `ACCEPT head=${head}` },
    ], head)).toBe(false);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: `ACCEPT TASK-OMO-5 head=${head}` },
    ], head, { taskKey: "TASK-OMO-5" })).toBe(true);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: "ACCEPT whelp99-code/jm-omo head=ce1cbb7b" },
    ], head, options, async () => ({ exitCode: 0, stdout: `${head}\n` }))).toBe(false);
  });

  it("does not treat a REJECT verdict that names the head as acceptance", async () => {
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: `REJECT head=${head}: claim check is wrong` },
    ], head)).toBe(false);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: `reviewed ${head}, needs changes` },
    ], head)).toBe(false);
  });

  it("reads the verdict on the head's own table row", async () => {
    const rejected = `e2963141${"0".repeat(32)}`;
    const accepted = `14344f04${"0".repeat(32)}`;
    const table = `| 건 | head | 판정 | | --- | --- | --- | | Mail #57 | \`${accepted}\` | ACCEPT | | jm-omo #2 | \`${rejected}\` | REJECT |`;
    expect(await cursorHeadMatches([{ user: "U0B81F5GR6V", text: table }], rejected, { repo: "owner/jm-omo", prNumber: "2" })).toBe(false);
    expect(await cursorHeadMatches([{ user: "U0B81F5GR6V", text: table }], accepted, { repo: "owner/mail", prNumber: "57" })).toBe(true);
    const lines = `jm-omo #2 ${rejected} REJECT\nMail #57 ${accepted} ACCEPT`;
    expect(await cursorHeadMatches([{ user: "U0B81F5GR6V", text: lines }], rejected, { repo: "owner/jm-omo", prNumber: "2" })).toBe(false);
    expect(await cursorHeadMatches([{ user: "U0B81F5GR6V", text: lines }], accepted, { repo: "owner/mail", prNumber: "57" })).toBe(true);
  });

  it("requires target PR identity on the ACCEPT line and rejects another owner shorthand", async () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const messages = [
      { user: "U0B81F5GR6V", text: `owner/jm-omo#5 ${head} REJECT\nother-owner/jm-omo#5 ${head} ACCEPT` },
      { user: "U0B81F5GR6V", text: `TASK-BOUND-PR ${head} REJECT\nACCEPT head=${head}` },
    ];
    expect(await cursorHeadMatches(messages, head, {
      repo: "owner/jm-omo", prNumber: "5", taskKey: "TASK-BOUND-PR",
    })).toBe(false);
    expect(await cursorHeadMatches([
      { user: "U0B81F5GR6V", text: `other-jm-omo#5 ${head} ACCEPT` },
    ], head, { repo: "owner/jm-omo", prNumber: "5" })).toBe(false);
  });

  it("resolves a short claim through the PR and checks Slack against the full SHA", async () => {
    const fullHead = "abcdef0123456789abcdef0123456789abcdef01";
    const acceptedPrefix = fullHead.slice(0, 8);
    const task = { sent_at: "2026-10-09T10:00:00.000Z", done: "pr:whelp99-code/jm-omo#1" };
    const slackMessages = [{ user: "U0B81F5GR6V", text: `ACCEPT jm-omo#1 head=${acceptedPrefix}` }];
    let checkedHead;
    const verified = await verifyClaims(`Cursor ACCEPT head=${acceptedPrefix}`, task, {
      slackHasHead: async (head, sentAt) => {
        checkedHead = head;
        return head === fullHead && sentAt === task.sent_at && await cursorHeadMatches(slackMessages, head,
          { repo: "whelp99-code/jm-omo", prNumber: "1" },
          async (argv) => ({ exitCode: 0, stdout: argv[1] === "api" ? `${fullHead}\n` : "" }));
      },
      getPrHead: async () => fullHead,
    });
    expect(checkedHead).toBe(fullHead);
    expect(verified[0]).toMatchObject({ kind: "cursor-accept", ok: true, head: fullHead, acceptedPrefix, actualHead: fullHead });
    expect(claimEvent("crm", "TASK-X", verified[0])).toBe("FLEET_CLAIM_OK crm TASK-X cursor-accept slack_author_full_head_match");

    const differentPrefix = "ffffffff";
    const mismatchedSlack = await verifyClaims(`Cursor ACCEPT head=${acceptedPrefix}`, task, {
      slackHasHead: async (head) => cursorHeadMatches([{ user: "U0B81F5GR6V", text: `ACCEPT head=${differentPrefix} PR #1` }], head,
        { repo: "whelp99-code/jm-omo", prNumber: "1" },
        async () => ({ exitCode: 0, stdout: `${fullHead}\n` })),
      getPrHead: async () => fullHead,
    });
    expect(mismatchedSlack[0]).toMatchObject({ kind: "cursor-accept", ok: false, actualHead: fullHead });

    const rejected = await verifyClaims(`Cursor APPROVE head=${acceptedPrefix}`, task, {
      slackHasHead: async () => false,
      getPrHead: async () => fullHead,
    });
    expect(rejected[0]).toMatchObject({ kind: "cursor-accept", ok: false });
    expect(claimEvent("crm", "TASK-X", rejected[0])).toStartWith("FLEET_CLAIM_FALSE ");

    const separateLine = await verifyClaims("Cursor ACCEPT\nPR READY head=abcdef123456", {
      sent_at: task.sent_at,
      done: "pr:whelp99-code/jm-omo#1",
    }, {
      slackHasHead: async () => true,
      getPrHead: async () => fullHead,
    });
    expect(separateLine.find((claim) => claim.kind === "cursor-accept").ok).toBe(false);
  });

  it("uses the parsed task PR number in default Slack short-head verification", async () => {
    const repo = "whelp99-code/jm-omo";
    const prNumber = "85";
    const fullHead = "efaf6d9222222222222222222222222222222222";
    const prefix = "efaf6d92";
    const task = {
      sent_at: "2026-10-12T10:00:00.000Z",
      done: `pr:${repo}#${prNumber}`,
    };
    const calls = [];
    let messages = [{ user: "U0B81F5GR6V", text: `ACCEPT jm-omo PR${prNumber} head=${prefix}` }];
    const runCommand = async (argv) => {
      calls.push(argv);
      if (argv[1] === "pr") return { exitCode: 0, stdout: JSON.stringify({ headRefOid: fullHead }) };
      if (argv[1] === "api") return { exitCode: 0, stdout: `${fullHead}\n` };
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    };
    const matched = await verifyClaims(`Cursor ACCEPT PR #${prNumber} head=${prefix}`, task, {
      runCommand,
      slackHistory: async () => messages,
    });
    expect(matched[0]).toMatchObject({ kind: "cursor-accept", ok: true, head: fullHead, actualHead: fullHead });
    expect(calls).toEqual([
      ["gh", "pr", "view", prNumber, "--repo", repo, "--json", "headRefOid"],
      ["gh", "api", `repos/${repo}/pulls/${prNumber}/commits`, "--paginate", "--jq", ".[].sha"],
    ]);

    calls.length = 0;
    messages = [{ user: "U0B81F5GR6V", text: `ACCEPT jm-omo PR99 head=${prefix}` }];
    const wrongPr = await verifyClaims(`Cursor ACCEPT PR #99 head=${prefix}`, task, {
      runCommand,
      slackHistory: async () => messages,
    });
    expect(wrongPr[0]).toMatchObject({ kind: "cursor-accept", ok: false });
    expect(calls).toEqual([["gh", "pr", "view", prNumber, "--repo", repo, "--json", "headRefOid"]]);
  });

  it("rejects a Slack ACCEPT prefix that resolves to a different commit", async () => {
    const mergedHead = "efaf6d945ebb757ee0d349e3a65c5345cf882a8d";
    const differentHead = "efaf6d9a1234567890abcdef1234567890abcdef";
    const prefix = mergedHead.slice(0, 8);
    const commitsCommand = async () => ({ exitCode: 0, stdout: `${mergedHead}\n${differentHead}\n` });
    let checkedHead;
    const claims = await verifyClaims(`Cursor ACCEPT head=${prefix}\nPR READY head=${prefix}`, {
      sent_at: "2026-10-09T10:00:00.000Z",
      done: "pr:whelp99-code/jm-omo#83",
    }, {
      slackHasHead: async (head) => {
        checkedHead = head;
        return cursorHeadMatches([{ user: "U0B81F5GR6V", text: `ACCEPT head=${differentHead.slice(0, 8)} PR #83` }], head,
          { repo: "whelp99-code/jm-omo", prNumber: "83" }, commitsCommand);
      },
      getPrHead: async () => mergedHead,
    });
    expect(checkedHead).toBe(mergedHead);
    expect(claims.find((claim) => claim.kind === "cursor-accept")).toMatchObject({ ok: false, actualHead: mergedHead });
  });

  it("rejects an ambiguous prefix shared by current and prior PR commits", async () => {
    const headA = "efaf6d9111111111111111111111111111111111";
    const headB = "efaf6d9222222222222222222222222222222222";
    const accepted = await cursorHeadMatches(
      [{ user: "U0B81F5GR6V", text: "ACCEPT PR #84 head=efaf6d9" }],
      headB,
      { repo: "owner/repo", prNumber: "84" },
      async () => ({ exitCode: 0, stdout: `${headA}\n${headB}\n` }),
    );
    expect(accepted).toBe(false);
  });

  it("accepts a prefix that uniquely identifies the current PR head", async () => {
    const head = "efaf6d9222222222222222222222222222222222";
    const accepted = await cursorHeadMatches(
      [{ user: "U0B81F5GR6V", text: "ACCEPT owner/repo#85 head=efaf6d92" }],
      head,
      { repo: "owner/repo", prNumber: "85" },
      async () => ({ exitCode: 0, stdout: `${head}\n` }),
    );
    expect(accepted).toBe(true);
  });

  it("rejects a unique prefix that identifies an older PR commit", async () => {
    const current = "efaf6d9222222222222222222222222222222222";
    const previous = "efaf6d9111111111111111111111111111111111";
    const accepted = await cursorHeadMatches(
      [{ user: "U0B81F5GR6V", text: "ACCEPT owner/repo#86 head=efaf6d91" }],
      current,
      { repo: "owner/repo", prNumber: "86" },
      async () => ({ exitCode: 0, stdout: `${previous}\n${current}\n` }),
    );
    expect(accepted).toBe(false);
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
    expect(urlSignal).toBe("pr:other/repo#1");
  });

  it("uses a read-only argv gh pr view for the referenced PR", async () => {
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    const calls = [];
    const claims = await verifyClaims(`PR READY head=${head}`, { done: "pr:whelp99-code/jm-omo#1" }, {
      runCommand: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: JSON.stringify({ headRefOid: head }) };
      },
    });
    expect(calls).toEqual([["gh", "pr", "view", "1", "--repo", "whelp99-code/jm-omo", "--json", "headRefOid"]]);
    expect(claims[0]).toMatchObject({ kind: "pr-ready", ok: true });
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

describe("fleet startup schema migration", () => {
  it("serializes additive migrations when multiple fleet processes start together", async () => {
    const home = mkdtempSync(join(tmpdir(), "jm-omo-fleet-migration-race-"));
    const state = join(home, ".local", "state", "omonyang");
    mkdirSync(state, { recursive: true });
    const dbPath = join(state, "fleet.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE tasks(
      key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT,
      done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT,
      result TEXT, evidence TEXT, history TEXT DEFAULT '[]'
    );
    CREATE TABLE dispatch_reservations(pane TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,attempt TEXT NOT NULL);`);
    legacy.close();

    const fleetPath = new URL("./fleet.mjs", import.meta.url).pathname;
    const env = { ...process.env, HOME: home };
    try {
      const processes = Array.from({ length: 6 }, () => Bun.spawn([
        "bun", "-e", `await import(${JSON.stringify(fleetPath)});`,
      ], { env, stdout: "pipe", stderr: "pipe" }));
      const results = await Promise.all(processes.map(async (proc) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, exitCode };
      }));
      expect(results.filter((result) => result.exitCode !== 0)).toEqual([]);
      const migrated = new Database(dbPath);
      const taskColumns = new Set(migrated.query("PRAGMA table_info(tasks)").all().map((column) => column.name));
      const reservationColumns = new Set(migrated.query("PRAGMA table_info(dispatch_reservations)").all().map((column) => column.name));
      expect(["completion_claimed", "send_attempted", "claim_evidence"].every((column) => taskColumns.has(column))).toBe(true);
      expect(["reserved_at", "recovery_token", "recovery_started_at"].every((column) => reservationColumns.has(column))).toBe(true);
      migrated.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("fleet Gajae event deduplication", () => {
  it("evicts expired origins while retaining recent dedupe keys", () => {
    const nowMs = 5_000_000;
    const seen = new Map([
      ["expired C0C6HJM0BV5:1.1", nowMs - 31 * 60_000],
      ["recent C0C6HJM0BV5:2.2", nowMs - 20 * 60_000],
    ]);
    expect(shouldSuppressGajae(seen, "new C0C6HJM0BV5:3.3", nowMs)).toBe(false);
    expect(seen.has("expired C0C6HJM0BV5:1.1")).toBe(false);
    expect(seen.has("recent C0C6HJM0BV5:2.2")).toBe(true);
    expect(seen.size).toBe(2);
  });

  it("suppresses the same reason and origin for thirty minutes", () => {
    const seen = new Map();
    expect(shouldSuppressGajae(seen, "recovery_hold C0C6HJM0BV5:123.456", 1_000_000)).toBe(false);
    expect(shouldSuppressGajae(seen, "recovery_hold C0C6HJM0BV5:123.456", 1_000_000 + 29 * 60_000)).toBe(true);
    expect(shouldSuppressGajae(seen, "recovery_hold C0C6HJM0BV5:123.456", 1_000_000 + 30 * 60_000)).toBe(false);
  });
});

describe("fleet dispatch CLI persistence", () => {
  for (const paneScreen of ["Compacting", "Question pending"]) {
    it(`queues a dispatch while the pane is ${paneScreen}`, async () => {
      const result = await runBlockedDispatch(paneScreen);
      expect(result.exitCode).toBe(0, result.stderr);
      expect(result.row?.status).toBe("waiting");
      expect(result.row?.prompt).toBe(join(result.home, "prompt.txt"));
      expect(result.row?.dispatch_type).toBe("impl");
      expect(result.row?.keep_model).toBe(1);
      expect(result.herdrCalls).toHaveLength(1);
      expect(result.herdrCalls[0]).toContain("pane read w6:p1");
      expect(result.herdrCalls[0]).not.toMatch(/send-text|send-keys/);
      expect(existsSync(result.home)).toBe(false);
    });
  }

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
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, HERDR_LOG: herdrLog, FLEET_CAT_CRM_PANE: "w6:p1" };
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
describe("fleet watch sent-unconfirmed recheck", () => {
  for (const completed of [false, true]) {
    it(`observes a newly tracked task on an unchanged ${completed ? "completed" : "working"} screen`, async () => {
      const key = `TASK-TRACK-UNCHANGED-${completed ? "COMPLETED" : "WORKING"}`;
      const expected = completed ? `FLEET_TASK_DONE crm ${key}` : `FLEET_TASK_STARTED crm ${key}`;
      const result = await runWatchCycle({
        catTask: key,
        trackAfterHeartbeat: true,
        waitForOutput: expected,
        command: ["watch", "0"],
        paneScreen: completed ? `Working (1s)\n⏺ Completed response\n${key}_DONE finished\n\n❯` : "Working (1s)\n❯",
      });
      expect(result.output).toContain(expected);
      expect(result.taskStatus).toBe(completed ? "done-claimed" : "working");
    });
  }
  it("marks a late Working pane as started without resending", async () => {
    const home = mkdtempSync(join(tmpdir(), "jm-omo-fleet-unconfirmed-"));
    const state = join(home, ".local", "state", "omonyang");
    const bin = join(home, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin);
    const dbPath = join(state, "fleet.sqlite");
    const herdrLog = join(home, "herdr.log");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE cats(
      id TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT, pane TEXT, product TEXT,
      state TEXT, model TEXT, task TEXT, last_seen TEXT, note TEXT
    );
    CREATE TABLE tasks(
      key TEXT PRIMARY KEY, cat TEXT, title TEXT, prompt TEXT, skill TEXT, model TEXT,
      done TEXT, status TEXT, sent_at TEXT, started_at TEXT, ended_at TEXT,
      result TEXT, evidence TEXT, history TEXT DEFAULT '[]'
    );
    CREATE TABLE beats(who TEXT PRIMARY KEY, at TEXT, detail TEXT);`);
    db.query("INSERT INTO cats(id,name,kind,pane,task) VALUES('crm','CRM','pane','w6:p1','CHILD')").run();
    db.query("INSERT INTO tasks(key,cat,status,sent_at) VALUES('CHILD','crm','sent-unconfirmed',?)").run(new Date().toISOString());
    db.close();

    try {
      const herdrPath = join(bin, "herdr");
      const pgrepPath = join(bin, "pgrep");
      const journalPath = join(bin, "journalctl");
      writeFileSync(herdrPath, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HERDR_LOG\"\nif [ \"$1\" = pane ] && [ \"$2\" = read ]; then printf 'Working (late start)\\n'; fi\n");
      writeFileSync(pgrepPath, "#!/bin/sh\nexit 0\n");
      writeFileSync(journalPath, "#!/bin/sh\nexit 0\n");
      chmodSync(herdrPath, 0o755);
      chmodSync(pgrepPath, 0o755);
      chmodSync(journalPath, 0o755);
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, HERDR_LOG: herdrLog };
      const fleetPath = new URL("./fleet.mjs", import.meta.url).pathname;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const proc = Bun.spawn(["bun", fleetPath, "watch", "1"], {
        cwd: new URL("..", import.meta.url).pathname,
        env,
        signal: controller.signal,
        stdout: "pipe",
        stderr: "ignore",
      });
      const reader = proc.stdout.getReader();
      let output = "";
      const decoder = new TextDecoder();
      try {
        while (!output.includes("FLEET_TASK_STARTED crm CHILD")) {
          const { value, done } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(timeout);
        proc.kill();
        await proc.exited;
        reader.releaseLock();
      }
      expect(output).toContain("FLEET_TASK_STARTED crm CHILD");
      const stored = new Database(dbPath);
      const task = stored.query("SELECT status,started_at FROM tasks WHERE key='CHILD'").get();
      stored.close();
      expect(task.status).toBe("working");
      expect(task.started_at).not.toBeNull();
      expect(readFileSync(herdrLog, "utf8")).not.toMatch(/send-text|send-keys/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("fleet working-task compaction recovery", () => {
  it("releases a working task reservation when compaction definitively fails", async () => {
    const result = await runWatchCycle({
      catTask: "WORKING-COMPACTION",
      taskStatus: "working",
      reservation: true,
      paneScreen: "compaction did not complete\n❯",
    });
    expect(result.output).toContain("FLEET_PROMPT_LOST crm WORKING-COMPACTION");
    expect(result.taskStatus).toBe("prompt-lost");
    expect(result.reservationLeft).toBe(false);
  });
});

describe("fleet usage and Bugbot alerts", () => {
  it("honors an idle completion marker before reconciling an expired send reservation", async () => {
    const attempt = "20000000-0000-4000-8000-000000000002";
    const result = await runWatchCycle({
      catTask: "TASK-DONE-ON-RESTART",
      taskStatus: "send-failed-unconfirmed",
      dispatchAttempt: attempt,
      taskHistory: [{ ev: "send-attempted", attempt, at: "2026-10-12T00:00:00.000Z" }],
      taskSentAt: "2026-10-12T00:00:01.000Z",
      reservation: true,
      reservationAgeMs: 10 * 60_000,
      paneScreen: `⏺ The work is complete.\nTASK-DONE-ON-RESTART_DONE attempt=${attempt} finished\n\n❯`,
    });
    expect(result.output).toContain("FLEET_TASK_DONE crm TASK-DONE-ON-RESTART finished");
    expect(result.taskStatus).toBe("done-claimed");
    expect(result.herdrWrites).toEqual([]);
    expect(result.reservationLeft).toBe(true);
  });

  it("accepts an attemptless DONE after startup migrates a legacy sent task", async () => {
    const result = await runWatchCycle({
      catTask: "TASK-LEGACY-DONE-AFTER-MIGRATION",
      taskStatus: "working",
      taskHistory: [{ ev: "send-attempted", attempt: "old-version-attempt", at: "2026-10-12T00:00:00.000Z" }],
      taskSentAt: "2026-10-12T00:00:01.000Z",
      paneScreen: "⏺ Legacy worker completed\nTASK-LEGACY-DONE-AFTER-MIGRATION_DONE finished\n\n❯",
    });
    expect(result.output).toContain("FLEET_TASK_DONE crm TASK-LEGACY-DONE-AFTER-MIGRATION finished");
    expect(result.taskStatus).toBe("done-claimed");
    expect(result.taskDispatchAttempt).toBeNull();
    expect(result.taskSendAttempted).toBe(1);
  });

  it("recovers an idle reservation when the same-key DONE belongs to an older attempt", async () => {
    const currentAttempt = "70000000-0000-4000-8000-000000000007";
    const staleAttempt = "80000000-0000-4000-8000-000000000008";
    const result = await runWatchCycle({
      catTask: "TASK-STALE-DONE-RECOVERY",
      taskStatus: "dispatching",
      dispatchAttempt: currentAttempt,
      taskHistory: [{ ev: "send-attempted", attempt: currentAttempt, at: "2026-10-12T00:00:00.000Z" }],
      taskSentAt: "2026-10-12T00:00:01.000Z",
      reservation: true,
      reservationAgeMs: 10 * 60_000,
      paneScreen: `⏺ Old response\nTASK-STALE-DONE-RECOVERY_DONE attempt=${staleAttempt} old result\n\n❯`,
    });
    expect(result.output).toContain("FLEET_SEND_FAILED_UNCONFIRMED TASK-STALE-DONE-RECOVERY");
    expect(result.output).not.toContain("FLEET_TASK_DONE crm TASK-STALE-DONE-RECOVERY");
    expect(result.taskStatus).toBe("send-failed-unconfirmed");
    expect(result.reservationLeft).toBe(false);
    expect(result.herdrWrites).toContain("pane send-keys w6:p1 ctrl+u");
  });

  it("ignores a DONE marker from an earlier dispatch attempt after restart", async () => {
    const result = await runWatchCycle({
      catTask: "STALE-ATTEMPT-DONE",
      taskStatus: "working",
      dispatchAttempt: "30000000-0000-4000-8000-000000000003",
      taskHistory: [{ ev: "send-attempted", attempt: "30000000-0000-4000-8000-000000000003", at: "2026-10-12T00:00:00.000Z" }],
      taskSentAt: "2026-10-12T00:00:01.000Z",
      paneScreen: "⏺ Prior response\nSTALE-ATTEMPT-DONE_DONE attempt=20000000-0000-4000-8000-000000000002 finished\n\n❯",
    });
    expect(result.output).not.toContain("FLEET_TASK_DONE crm STALE-ATTEMPT-DONE");
    expect(result.taskStatus).toBe("working");
  });

  it("ignores a legacy DONE marker without the dispatch attempt ID", async () => {
    const attempt = "50000000-0000-4000-8000-000000000005";
    const result = await runWatchCycle({
      catTask: "LEGACY-DONE-MARKER",
      taskStatus: "working",
      dispatchAttempt: attempt,
      taskHistory: [{ ev: "send-attempted", attempt, at: "2026-10-12T00:00:00.000Z" }],
      taskSentAt: "2026-10-12T00:00:01.000Z",
      paneScreen: "⏺ Prior response\nLEGACY-DONE-MARKER_DONE finished\n\n❯",
    });
    expect(result.output).not.toContain("FLEET_TASK_DONE crm LEGACY-DONE-MARKER");
    expect(result.taskStatus).toBe("working");
  });

  for (const kind of ["DONE", "BLOCKED"]) {
    it(`accepts a ${kind} marker for a tracked task by key and track time`, async () => {
      const key = `TASK-TRACKED-${kind}`;
      const result = await runWatchCycle({
        catTask: key,
        taskStatus: "tracked-unconfirmed",
        taskHistory: kind === "DONE" ? [] : [{ ev: "tracked", at: "2026-10-12T00:00:00.000Z" }],
        taskSentAt: "2026-10-12T00:00:01.000Z",
        paneScreen: `Working (1s)\n⏺ Tracked response\n${key}_${kind} tracked result\n\n❯`,
      });
      expect(result.output).toContain(`FLEET_TASK_${kind} crm ${key} tracked result`);
      expect(result.taskStatus).toBe(kind === "DONE" ? "done-claimed" : "blocked");
    });
  }

  it("accepts a matching attempt after Enter fails when the pane is observed working", async () => {
    const attempt = "60000000-0000-4000-8000-000000000006";
    const result = await runWatchCycle({
      catTask: "TASK-EARLY-DONE-MARKER",
      taskStatus: "send-failed-unconfirmed",
      dispatchAttempt: attempt,
      taskHistory: [{ ev: "send-attempted", attempt, at: "2026-10-12T00:00:01.000Z" }],
      taskSentAt: "2026-10-12T00:00:00.000Z",
      paneScreen: `Working (1s)\n⏺ Prior response\nTASK-EARLY-DONE-MARKER_DONE attempt=${attempt} finished\n\n❯`,
    });
    expect(result.output).toContain("FLEET_TASK_DONE crm TASK-EARLY-DONE-MARKER finished");
    expect(result.taskStatus).toBe("done-claimed");
    expect(result.taskSentAt).toBe("2026-10-12T00:00:01.000Z");
  });

  it("keeps a closed task terminal when its prior DONE marker remains visible after restart", async () => {
    const attempt = "40000000-0000-4000-8000-000000000004";
    const result = await runWatchCycle({
      catTask: "CLOSED-DONE-REPLAY",
      taskStatus: "closed",
      dispatchAttempt: attempt,
      taskHistory: [{ ev: "send-attempted", attempt, at: "2026-10-12T00:00:00.000Z" }],
      taskSentAt: "2026-10-12T00:00:01.000Z",
      paneScreen: `⏺ Prior response\nCLOSED-DONE-REPLAY_DONE attempt=${attempt} stale result\n\n❯`,
    });
    expect(result.output).not.toContain("FLEET_TASK_DONE crm CLOSED-DONE-REPLAY");
    expect(result.taskStatus).toBe("closed");
  });

  it("re-verifies not-done PR tasks during a watch cycle", async () => {
    const result = await runWatchCycle({
      catTask: "WATCH-RETRY-PR",
      taskStatus: "not-done",
      taskHistory: [{ ev: "done-claimed", text: "ready" }],
      prDone: "pr:whelp99-code/jm-omo#77",
      paneScreen: "Idle\n❯",
    });
    expect(result.output).toContain("NOT_DONE WATCH-RETRY-PR");
    expect(result.ghCalls).toContain("pr view 77 --repo whelp99-code/jm-omo --json state,mergeCommit,headRefOid");
    expect(result.taskStatus).toBe("not-done");
  });

  it("keeps not-done PRs visible and re-verifies them on each watch cycle", async () => {
    const result = await runWatchCycle({
      catTask: "NOT-DONE-PR",
      taskStatus: "not-done",
      taskHistory: [{ ev: "done-claimed", text: "merged" }],
      prDone: "pr:whelp99-code/jm-omo#77",
      paneScreen: "Idle\n❯",
      checkRuns: [{
        name: "Cursor Bugbot",
        status: "completed",
        conclusion: "neutral",
        output: { title: "usage limit reached", summary: "", text: "" },
      }],
    });
    expect(result.output).toContain("NOT_DONE NOT-DONE-PR");
    expect(result.output).toContain("FLEET_BUGBOT_LIMIT NOT-DONE-PR");
    expect(result.taskStatus).toBe("not-done");

    const board = await runFleetBoard({
      catTask: "NOT-DONE-PR",
      taskStatus: "not-done",
      prDone: "pr:whelp99-code/jm-omo#77",
    });
    expect(board.output).toContain("#77 OPEN draft");
  });

  it("monitors tracked tasks in the watcher and board before completion", async () => {
    const options = {
      catTask: "TRACKED-PR",
      taskStatus: "tracked-unconfirmed",
      prDone: "pr:whelp99-code/jm-omo#77",
      paneScreen: "Working (2s)\n❯",
      checkRuns: [{
        name: "Cursor Bugbot",
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Bugbot couldn't run - usage limit reached",
          summary: "Bugbot couldn't run - usage limit reached",
          text: "",
        },
      }],
    };
    const watch = await runWatchCycle(options);
    expect(watch.output).toContain("FLEET_TASK_STARTED crm TRACKED-PR");
    expect(watch.taskStatus).toBe("working");
    expect(watch.output).toContain("FLEET_BUGBOT_LIMIT TRACKED-PR");

    const board = await runFleetBoard(options);
    expect(board.output).toContain("#77 OPEN draft");
    expect(board.output).toContain("Cursor Bugbot=USAGE_LIMIT");
  });

  it("reconciles a visibly working send-failed-unconfirmed task", async () => {
    const result = await runWatchCycle({
      catTask: "SEND-FAILED",
      taskStatus: "send-failed-unconfirmed",
      paneScreen: "Working (1s)\n❯",
    });
    expect(result.output).toContain("FLEET_TASK_STARTED crm SEND-FAILED");
    expect(result.taskStatus).toBe("working");
    expect(result.herdrWrites).toEqual([]);
  });

  it("emits one alert for each USAGE_TICK threshold without switching models", async () => {
    const result = await runWatchCycle({ usageTick: "USAGE_TICK anthropic=60% chatgpt-subscription=80%" });
    expect(result.output).toContain("FLEET_USAGE_LIMIT provider=anthropic used=60% remaining=40% threshold=60%");
    expect(result.output).toContain("FLEET_USAGE_LIMIT provider=chatgpt-subscription used=80% remaining=20% threshold=80%");
    expect(result.herdrWrites).toEqual([]);
    expect(result.ghCalls).toEqual([]);
  });

  it("alerts on the Cursor Bugbot usage-limit check using read-only GitHub data", async () => {
    const result = await runWatchCycle({
      prDone: "pr:whelp99-code/jm-omo#77",
      checkRuns: [{
        name: "Cursor Bugbot",
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Bugbot couldn't run - usage limit reached",
          summary: "Bugbot couldn't run - usage limit reached",
          text: "",
        },
      }],
    });
    expect(result.output).toContain("FLEET_BUGBOT_LIMIT");
    expect(result.output).toContain("usage_limit_reached");
    expect(result.ghCalls).toContain("pr view 77 --repo whelp99-code/jm-omo --json headRefOid");
    expect(result.ghCalls.some((line) => line.startsWith("api repos/whelp99-code/jm-omo/commits/"))).toBe(true);
    expect(result.herdrWrites).toEqual([]);
  });

  it("bounds concurrent Bugbot lookups while polling many active PRs", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE tasks(key TEXT, done TEXT, status TEXT, sent_at TEXT)");
    for (let i = 1; i <= 20; i++) {
      db.query("INSERT INTO tasks(key,done,status,sent_at) VALUES(?,?,'working',?)").run(`BUGBOT-${i}`, `pr:owner/repo#${i}`, String(i));
    }
    let active = 0;
    let maximum = 0;
    const calls = [];
    await bugbotLimitEvents(db, new Map(), async (signal, deadline) => {
      calls.push(signal);
      expect(deadline.aborted).toBe(false);
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return null;
    });
    expect(calls).toHaveLength(20);
    expect(maximum).toBeLessThanOrEqual(5);
    db.close();
  });
});

describe("fleet question policy", () => {
  it("does not apply a policy phrase from assistant history to a staging question", () => {
    const screen = [
      "⏺ I will not use the production auth account.",
      "Question pending",
      "May I use the staging account password?",
      "❯",
    ].join("\n");
    const state = classify(screen);
    expect(state.questionText).toBe("May I use the staging account password?");
    expect(questionPolicy(state.questionText)).toBeNull();
  });

  it("matches allowlisted policies only against the pending question", () => {
    const screen = [
      "Earlier response: I avoided using the production auth account.",
      "Question pending",
      "Can I use the staging account password?",
      "❯",
    ].join("\n");
    const classified = classify(screen);
    expect(classified.questionText).toBe("Can I use the staging account password?");
    expect(questionPolicy(classified.questionText)).toBeNull();
    expect(questionPolicy("May I use the production auth account?")?.id).toBe("production-auth-prohibited");
    expect(questionPolicy("Should we use the production auth account for this one?")).toBeNull();
    expect(questionPolicy("May I use Jaemin's password or OTP now? before the release?")).toBeNull();
  });

  it("joins a wrapped pending question before applying an exact policy", async () => {
    const question = "May I use Jaemin's password\nor OTP now?";
    const screen = `Question pending\n${question}\n❯`;
    const classified = classify(screen);
    expect(classified.questionText).toBe("May I use Jaemin's password or OTP now?");
    expect(questionPolicy(classified.questionText)?.id).toBe("personal-credentials-defer");

    const result = await runWatchCycle({
      catTask: "Q-WRAPPED-POLICY",
      paneScreen: screen,
    });
    expect(result.output).toContain("FLEET_AUTO_ANSWER crm Q-WRAPPED-POLICY policy=personal-credentials-defer");
    expect(result.herdrWrites).toHaveLength(2);
  });

  it("keeps unanswered words inside a near-miss question and does not auto-answer it", async () => {
    const question = "May I use the production auth account for this unanswered issue?";
    const classified = classify(`Question pending\n${question}\n❯`);
    expect(classified.state).toBe("question");
    expect(classified.questionText).toBe(question);
    expect(questionPolicy(classified.questionText)).toBeNull();

    const result = await runWatchCycle({
      catTask: "Q-UNANSWERED-WORD",
      paneScreen: `Question pending\n${question}\n❯`,
    });
    expect(result.output).toContain("FLEET_QUESTION_NOTIFY owner=omonyang crm Q-UNANSWERED-WORD");
    expect(result.herdrWrites).toEqual([]);
    expect(classify("This is still an unanswered issue\n❯").state).toBe("idle");
  });

  it("does not answer an exact allowlisted prompt unless the pane is in question state", async () => {
    const calls = [];
    const answered = await answerPaneQuestion("w6:p1", "Should we use the production auth account?", "Do not use it.", async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "Should we use the production auth account?\n❯" };
    });
    expect(answered).toBe(false);
    expect(calls).toEqual([["herdr", "pane", "read", "w6:p1", "--source", "visible", "--format", "text"]]);
  });

  it("retries an allowlisted answer after a transient send failure", async () => {
    const result = await runFleetCommand({
      catTask: "Q-RETRY",
      paneScreen: "Question pending\nMay I use Jaemin's password or OTP now?\n❯",
      failFirstQuestionAnswer: true,
      waitForOutput: "FLEET_QUESTION_ANSWERED",
      command: ["watch", "0"],
    });
    expect(result.output).toContain("FLEET_QUESTION_SEND_FAILED crm Q-RETRY");
    expect(result.output).toContain("FLEET_QUESTION_ANSWERED crm Q-RETRY");
    expect(result.herdrWrites.filter((line) => line.startsWith("pane send-text"))).toHaveLength(2);
    expect(result.herdrWrites.at(-1)).toBe("pane send-keys w6:p1 Enter");
  });

  it("does not answer when the same pane now shows a different question", async () => {
    const calls = [];
    const answered = await answerPaneQuestion("w6:p1", "May I use the production account?", "Do not use it.", async (argv) => {
      calls.push(argv);
      return {
        exitCode: 0,
        stdout: argv[2] === "read" ? "Question pending\nA different question is now active.\n❯" : "",
      };
    });
    expect(answered).toBe(false);
    expect(calls).toEqual([["herdr", "pane", "read", "w6:p1", "--source", "visible", "--format", "text"]]);
  });

  it("does not auto-answer near-miss policy prompts", async () => {
    const question = "Should we use the production auth account for this unanswered issue?";
    expect(questionPolicy(question)).toBeNull();
    const result = await runWatchCycle({
      catTask: "Q-NEAR-MISS",
      paneScreen: `Question pending\n${question}\n❯`,
    });
    expect(result.output).toContain("FLEET_QUESTION_NOTIFY owner=omonyang crm Q-NEAR-MISS");
    expect(result.output).not.toContain("FLEET_AUTO_ANSWER");
    expect(result.herdrWrites).toEqual([]);
  });

  it("defers personal password or OTP use and answers through the fake pane", async () => {
    const result = await runWatchCycle({
      catTask: "Q-PERSONAL",
      paneScreen: "Question pending\nMay I use Jaemin's password or OTP now?\n❯",
    });
    expect(result.output).toContain("FLEET_QUESTION_ANSWERED crm Q-PERSONAL policy=personal-credentials-defer");
    expect(result.herdrWrites).toEqual([
      "pane send-text w6:p1 재민의 비밀번호나 OTP는 사용하지 말고 내일로 미뤄.",
      "pane send-keys w6:p1 Enter",
    ]);
  });

  it("prohibits production authentication account use", async () => {
    const result = await runWatchCycle({
      catTask: "Q-PRODUCTION",
      paneScreen: "Question pending\nShould we use the production auth account?\n❯",
    });
    expect(result.output).toContain("FLEET_QUESTION_ANSWERED crm Q-PRODUCTION policy=production-auth-prohibited");
    expect(result.output).toContain("FLEET_AUTO_ANSWER crm Q-PRODUCTION policy=production-auth-prohibited");
    expect(result.taskHistory.some((event) => event.ev === "question-auto-answer" && event.policy === "production-auth-prohibited")).toBe(true);
    expect(result.output).toContain("FLEET_AUTO_ANSWER crm Q-PRODUCTION policy=production-auth-prohibited");
    expect(result.taskHistory.some((event) => event.ev === "question-auto-answer" && event.policy === "production-auth-prohibited")).toBe(true);
    expect(result.herdrWrites).toEqual([
      "pane send-text w6:p1 운영 인증 계정은 사용하지 마.",
      "pane send-keys w6:p1 Enter",
    ]);
  });

  it("notifies Omonyang and sends nothing for non-allowlisted questions", async () => {
    const result = await runWatchCycle({
      catTask: "Q-UNKNOWN",
      paneScreen: "Question pending\nCan I use the staging account password?\n❯",
    });
    expect(result.output).toContain("FLEET_QUESTION_NOTIFY owner=omonyang crm Q-UNKNOWN");
    expect(result.herdrWrites).toEqual([]);
  });
});

describe("fleet text board", () => {
  it("omits closed PR tasks from active board review lists", async () => {
    const board = await runFleetBoard({
      catTask: "CLOSED-PR",
      taskStatus: "closed",
      prDone: "pr:whelp99-code/jm-omo#78",
    });
    expect(board.exitCode).toBe(0);
    expect(board.output).not.toContain("#78 OPEN draft");
    expect(board.output).not.toContain("FLEET_BUGBOT_LIMIT CLOSED-PR");
  });

  it("persists unknown cat state after a pane read failure", async () => {
    const result = await runFleetCommand({
      catState: "working",
      paneReadFailure: true,
      command: ["status"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("unknown");
    expect(result.output).not.toContain("working");
    expect(result.output).toContain("FLEET_REFRESH_ERROR crm");
  });

  it("shows all roadmap items, live cats, PR review state, and unknown deployment evidence", async () => {
    const result = await runFleetBoard({
      catTask: "PR-TASK",
      prDone: "pr:whelp99-code/jm-omo#77",
      paneScreen: "Working (5s)\n❯",
      checkRuns: [{ name: "Cursor Bugbot", status: "in_progress", conclusion: null, output: {} }],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (let number = 1; number <= 8; number++) expect(result.output).toMatch(new RegExp(`^${number}\\.`, "m"));
    expect(result.output).toContain("5. Usage inventory — NOT_STARTED");
    expect(result.output).toContain("7. Pane context management — NOT_STARTED");
    expect(result.output).toContain("CRM (crm, w6:p1): working");
    expect(result.output).toContain("#2 OPEN draft");
    expect(result.output).toContain("#77 OPEN draft");
    expect(result.output).toContain("REVIEW_REQUIRED");
    expect(result.output).toContain("Cursor Bugbot=IN_PROGRESS");
    expect(result.output).toContain("Deployment: NOT_RUN");
    expect(result.output).toContain("Production deployment: UNKNOWN");
    expect(result.herdrWrites).toEqual([]);
    expect(result.ghCalls.some((line) => line.startsWith("pr list "))).toBe(true);
    expect(result.ghCalls.every((line) => !/--method\s+POST/i.test(line))).toBe(true);
  });
});

describe("fleet UTF-8 dispatch and prompt isolation", () => {
  it("sends the generated dispatch prompt as raw UTF-8 and ignores its prompt-only done example", async () => {
    const result = await runRawUtf8Dispatch();
    const sentMessage = result.sendBytes.subarray(0, result.sendBytes.length - 1).toString("utf8");
    const attempt = sentMessage.match(/^UTF8-QA \[attempt=([0-9a-f-]{36}) skill:ulw\]:/)?.[1];
    const expectedMessage = `UTF8-QA [attempt=${attempt} skill:ulw]: 지시문 파일 ${result.prompt} 전체를 읽고 그대로 수행해. 끝나면 마지막 줄에 UTF8-QA_DONE attempt=${attempt} <한 줄 요약> 또는 UTF8-QA_BLOCKED attempt=${attempt} reason=<한 줄>.`;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("DISPATCH_OK crm UTF8-QA started (MODEL_KEPT)");
    expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.sendBytes).toEqual(Buffer.concat([Buffer.from(expectedMessage, "utf8"), Buffer.from([0])]));
    const promptOnly = result.sendBytes.subarray(0, result.sendBytes.length - 1).toString("utf8");
    expect(classify(`❯ ${promptOnly}\n\n❯`).done).toBeNull();
  }, 15_000);
});

describe("fleet review-stall request correlation", () => {
  it("persists a cursor and revisits an old unanswered request after restart", async () => {
    const db = unitDb();
    const nowMs = Date.now();
    const requestTs = String((nowMs - 30 * 60 * 60_000) / 1000);
    const request = {
      ts: requestTs,
      thread_ts: requestTs,
      channel: "C0C6HJM0BV5",
      reply_count: 1,
      user: "UOTHER",
      text: "Cursor 검수 요청 PR #98 TASK-OLD-REVIEW",
    };
    let since;
    const first = await pollReviewStalls(db, nowMs, async (oldest) => {
      since = oldest;
      return [request];
    });
    const bootstrapCursor = ((nowMs - 30 * 24 * 60 * 60_000) / 1000).toFixed(6);
    expect(since).toBe(bootstrapCursor);
    const exactRootParams = slackHistoryParams(requestTs);
    expect(exactRootParams.get("oldest")).toBe(requestTs);
    expect(exactRootParams.get("inclusive")).toBe("true");
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("TASK-OLD-REVIEW");
    expect(db.query("SELECT value FROM fleet_state WHERE key='slack-review-cursor'").get().value).toBe(requestTs);
    expect(db.query("SELECT ts FROM fleet_review_requests").get().ts).toBe(requestTs);

    const restartedPoll = await pollReviewStalls(db, nowMs + 60 * 60_000, async (oldest) => {
      since = oldest;
      return [
        request,
        { ts: String((nowMs + 1_000) / 1000), thread_ts: requestTs, app_id: "A08SKDT6QUW", text: "확인했어" },
      ];
    });
    expect(since).toBe(requestTs);
    expect(slackHistoryParams(since).get("inclusive")).toBe("true");
    const refetchedRoots = reviewRequestThreadRoots([request]);
    const refetchedThreadRoots = [];
    await fetchSlackThreadReplies(refetchedRoots, async (root) => {
      refetchedThreadRoots.push(root.ts);
      return [{ ts: String(Number(root.ts) + 1), thread_ts: root.ts, app_id: "A08SKDT6QUW", text: "prior review reply" }];
    }, new AbortController().signal);
    expect(refetchedThreadRoots).toEqual([requestTs]);
    expect(restartedPoll).toEqual([]);
    expect(db.query("SELECT ts FROM fleet_review_requests").get()).toBeNull();
    expect(db.query("SELECT value FROM fleet_state WHERE key='slack-review-cursor'").get().value)
      .toBe(requestTs);
    db.close();
  });

  it("fetches thread replies only for review-request roots", () => {
    const roots = reviewRequestThreadRoots([
      { ts: "1.1", reply_count: 3, user: "UOTHER", text: "Cursor 검수 요청 PR #12" },
      { ts: "2.2", reply_count: 8, user: "UOTHER", text: "Unrelated discussion" },
      { ts: "3.3", reply_count: 0, user: "UOTHER", text: "Cursor 검수 요청 PR #13" },
    ]);
    expect(roots.map((root) => root.ts)).toEqual(["1.1"]);
  });

  it("bounds Slack thread fetch concurrency and respects an expired deadline", async () => {
    const roots = Array.from({ length: 12 }, (_, i) => ({ ts: String(i) }));
    const controller = new AbortController();
    let active = 0;
    let maximum = 0;
    const replies = await fetchSlackThreadReplies(roots, async (root) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return [`reply-${root.ts}`];
    }, controller.signal);
    expect(replies).toHaveLength(12);
    expect(maximum).toBeLessThanOrEqual(5);

    const expired = new AbortController();
    expired.abort();
    let called = false;
    expect(await fetchSlackThreadReplies(roots, async () => { called = true; return []; }, expired.signal)).toBeNull();
    expect(called).toBe(false);
  });

  it("fetches unanswered review requests and emits each stall once", async () => {
    const nowMs = 100_000_000;
    const requestTs = String((nowMs - 46 * 60_000) / 1000);
    const messages = [{
      ts: requestTs,
      thread_ts: requestTs,
      channel: "C0C6HJM0BV5",
      user: "UOTHER",
      text: "Cursor 검수 요청 PR #93 TASK-REVIEW-STALL",
    }];
    const alerted = new Set();
    let since;
    const fetchMessages = async (oldest) => {
      since = oldest;
      return messages;
    };
    const first = await reviewStallEvents(nowMs, alerted, fetchMessages);
    expect(Number(since)).toBeLessThan(Number(requestTs));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("FLEET_REVIEW_STALL_DRAFT");
    expect(first[0]).toContain("TASK-REVIEW-STALL");
    expect(await reviewStallEvents(nowMs + 60_000, alerted, fetchMessages)).toEqual([]);
  });

  it("extracts request keys and recognizes the existing review-request wording", () => {
    expect(reviewRequestKeys("서윤아, Cursor 검수 요청 PR #42 head=abcdef012345 TASK-OMO-IMPROVE-3-4-6-8"))
      .toEqual(["pr:42", "head:abcdef01", "task:TASK-OMO-IMPROVE-3-4-6-8"]);
    expect(isReviewRequest({ user: "UOTHER", text: "서윤아, Cursor 검수 요청: 확인 부탁해" })).toBe(true);
    expect(isReviewRequest({ user: "U0B81F5GR6V", text: "Cursor 검수 요청 PR #42" })).toBe(false);
    expect(isReviewRequest({ user: "UOTHER", text: "Cursor 검수 요청, 참조 키 없음" })).toBe(true);
  });

  it("pairs replies per request in the same thread without reusing one reply", () => {
    const requests = [
      { ts: "100.000001", thread_ts: "90.000001", user: "UOTHER", text: "Cursor 검수 요청 PR #42 head=abcdef012345 TASK-REQ-A" },
      { ts: "200.000001", thread_ts: "90.000001", user: "UOTHER", text: "Cursor 검수 요청 PR #42 head=abcdef012345 TASK-REQ-B" },
      { ts: "360.000001", thread_ts: "90.000001", user: "UOTHER", text: "Cursor 검수 요청" },
      { ts: "370.000001", thread_ts: "90.000001", user: "UOTHER", text: "Cursor 검수 요청" },
    ];
    const replies = [
      { ts: "250.000001", thread_ts: "90.000001", user: "U0B81F5GR6V", text: "PR #42 head=abcdef012345 TASK-REQ-B" },
      { ts: "350.000001", thread_ts: "90.000001", app_id: "A08SKDT6QUW", text: "확인했어" },
      { ts: "400.000001", thread_ts: "90.000001", user: "UOTHER", text: "TASK-REQ-A" },
      { ts: "500.000001", thread_ts: "499.000001", user: "U0B81F5GR6V", text: "PR #42 head=abcdef012345 TASK-REQ-A" },
    ];
    expect([...pairReviewReplies(requests, replies)]).toEqual([
      ["200.000001", "250.000001"],
      ["100.000001", "350.000001"],
    ]);
  });

  it("pairs an identifier-free reply only when one request is eligible in its thread", () => {
    const request = {
      ts: "600.000001",
      thread_ts: "590.000001",
      user: "UOTHER",
      text: "Cursor 검수 요청 PR #94 TASK-REQ-ONLY",
    };
    const reply = { ts: "700.000001", thread_ts: "590.000001", app_id: "A08SKDT6QUW", text: "확인했어" };
    expect([...pairReviewReplies([request], [reply])]).toEqual([["600.000001", "700.000001"]]);

    const ambiguous = [
      request,
      { ...request, ts: "650.000001", text: "Cursor 검수 요청 PR #95 TASK-REQ-OTHER" },
    ];
    expect([...pairReviewReplies(ambiguous, [reply])]).toEqual([]);
    expect([...pairReviewReplies([request], [{ ...reply, text: "PR #999 TASK-UNRELATED" }])]).toEqual([]);
  });

  it("alerts each unanswered request at its own 45-minute deadline", () => {
    const requests = [
      { ts: "1000.000001", thread_ts: "1000.000001", user: "UOTHER", text: "Cursor 검수 요청 PR #42 TASK-REQ-A" },
      { ts: "1600.000001", thread_ts: "1600.000001", user: "UOTHER", text: "Cursor 검수 요청 PR #43 TASK-REQ-B" },
    ];
    const replies = [
      { ts: "1100.000001", thread_ts: "1000.000001", user: "U0B81F5GR6V", text: "PR #42 TASK-REQ-A 확인" },
    ];
    const alerted = new Set();
    const firstDeadline = reviewStallDrafts(requests, replies, 1000_000 + 45 * 60_000, alerted);
    expect(firstDeadline).toHaveLength(0);
    const secondDeadline = reviewStallDrafts(requests, replies, 1600_000 + 45 * 60_000, alerted);
    expect(secondDeadline).toHaveLength(1);
    expect(secondDeadline[0]).toContain("FLEET_REVIEW_STALL_DRAFT owner=omonyang");
    expect(secondDeadline[0]).toContain("TASK-REQ-B");
    expect(secondDeadline[0]).toContain("p1600000001");
    expect(reviewStallDrafts(requests, replies, 1700_000 + 45 * 60_000, alerted)).toEqual([]);
  });
});
