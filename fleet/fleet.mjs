#!/usr/bin/env bun
import { loadFleetConfig } from "./config.mjs";

export { resolveFleetConfig } from "./config.mjs";
export { classify } from "./pane-classification.mjs";

const CONFIGURED_CAT_PANES = new Map(loadFleetConfig().cats.map(({ id, pane }) => [id, pane]));

export function configuredCatPane(catId, fallback = null) {
  return CONFIGURED_CAT_PANES.get(catId) ?? fallback;
}
export async function readPaneResult(pane) {
  const proc = Bun.spawn({ cmd: ["herdr", "pane", "read", pane, "--source", "visible", "--format", "text"], stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10_000) });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const retirement = "The fleet work ledger was retired on 2026-11-23.";

export function dispatch() {
  return `DISPATCH_HOLD ${retirement}`;
}

export function verify() {
  return retirement;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "routes") {
    const routes = await Bun.file(new URL("./routes.json", import.meta.url)).json();
    console.log(JSON.stringify(routes, null, 1));
  } else if (command === "dispatch") {
    console.log(dispatch());
  } else if (command === "verify") {
    console.log(verify());
  } else {
    console.log("usage: fleet routes");
    if (command !== undefined) process.exitCode = 1;
  }
}
