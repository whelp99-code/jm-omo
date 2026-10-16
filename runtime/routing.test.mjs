import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function runRouting(args, overrides) {
  const home = mkdtempSync(join(tmpdir(), "jmomo-routing-"));
  const log = join(home, "routing.log");
  let child;
  try {
    child = Bun.spawn([process.execPath, ...args], {
      env: { ...process.env, HOME: home, ROUTING_LOG: log, ...overrides },
      stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(5_000),
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(0, stderr);
    return { stdout, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    rmSync(home, { recursive: true, force: true });
    expect(existsSync(home)).toBe(false);
  }
}

describe("shared runtime routing configuration", () => {
  it("serializes reports for the configured review channel", async () => {
    const source = new URL("./development-report.mjs", import.meta.url).href;
    const result = await runRouting(["--eval", `const {serializeReport}=await import(${JSON.stringify(source)}); console.log(serializeReport("fixture"));`],
      { FLEET_SLACK_REVIEW_CHANNEL: "C_TASK_OWNED" });
    expect(JSON.parse(result.stdout).channel).toBe("C_TASK_OWNED");
  });

  it("uses configured cats and terminal targets in the usage watcher", async () => {
    const result = await runRouting(["--preload", fileURLToPath(new URL("./fixtures/routing-preload.mjs", import.meta.url)),
      fileURLToPath(new URL("./usage-watch.mjs", import.meta.url))],
    { FLEET_CAT_GAJAE_PANE: "w-owned:p9", FLEET_USAGE_ORCA_TERMINALS: '["term_owned_fixture"]' });
    expect(result.stdout).toContain("USAGE_TICK");
    expect(result.calls).toContain("herdr pane read w-owned:p9");
    expect(result.calls).toContain("orca terminal read --terminal term_owned_fixture");
    expect(result.calls).not.toContain("herdr pane read w1:p1");
    expect(result.calls).not.toContain("herdr pane read w2:p1");
  });

  it("mentions the configured Cursor user in review requests", async () => {
    const source = new URL("../fleet/fleet.mjs", import.meta.url).href;
    const result = await runRouting(["--eval", `const {buildPrLoopReviewRequest}=await import(${JSON.stringify(source)}); console.log(JSON.stringify(buildPrLoopReviewRequest("owner/repo","1","https://example.invalid","a".repeat(40))));`],
      { FLEET_CURSOR_USER_ID: "U_TASK_OWNED" });
    expect(JSON.parse(result.stdout).text).toContain("<@U_TASK_OWNED>");
  });
});
