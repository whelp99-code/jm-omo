import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

describe("Slack startup failure diagnostics", () => {
  it.each([
    ["module", "module", "ERR_MODULE_NOT_FOUND"],
    ["credentials", "credentials", "EACCES"],
    ["app-token", "app-token", "ENOENT"],
    ["login", "login", "invalid_auth"],
    ["listener", "listener", "ECONNREFUSED"],
  ])("records the %s failure without private error text", async (failure, stage, code) => {
    const home = mkdtempSync(join(tmpdir(), "jmomo-slack-startup-"));
    let child;
    try {
      if (failure !== "app-token") {
        mkdirSync(join(home, ".config/omonyang"), { recursive: true });
        writeFileSync(join(home, ".config/omonyang/slack-app-token"), "task-owned-app-token", { mode: 0o600 });
      }
      child = Bun.spawn([process.execPath, "--preload",
        fileURLToPath(new URL("./fixtures/slack-startup-preload.mjs", import.meta.url)),
        fileURLToPath(new URL("./slack-listen.mjs", import.meta.url))], {
        env: { ...process.env, HOME: home, SLACK_STARTUP_FIXTURE: failure,
          FLEET_AGENT_MESSENGER_CREDENTIAL_PATH: join(home, "override/credential-manager.js") },
        stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(5_000),
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(1);
      expect(readFileSync(join(home, "sdk-source"), "utf8")).toBe("override");
      expect(stderr).toContain(`SLACK_START_FAILED stage=${stage} code=${code}`);
      expect(stdout + stderr).not.toContain("private fixture detail");
      expect(stdout + stderr).not.toContain("xoxb-do-not-log");
      const inbox = new Database(join(home, ".omo/omonyang/durable/inbox.sqlite"));
      try { expect(inbox.query("SELECT COUNT(*) AS count FROM owner").get().count).toBe(0); }
      finally { inbox.close(); }
    } finally {
      if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      rmSync(home, { recursive: true, force: true });
      expect(existsSync(home)).toBe(false);
    }
  });
});
