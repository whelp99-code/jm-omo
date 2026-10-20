import { appendFileSync } from "node:fs";

// All provider, pane and terminal effects stay inside this native process fixture.
Bun.$ = (parts, ...values) => {
  const command = parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  appendFileSync(process.env.ROUTING_LOG, command + "\n");
  const stdout = command.includes("print-bearer-token") ? "task-owned-bearer"
    : command.includes("orca terminal read") ? JSON.stringify({ result: { terminal: { tail: "(anthropic) ⚡ claude-haiku-4-5:off" } } })
    : command.includes("herdr pane read") ? "Idle\n(anthropic) ⚡ claude-haiku-4-5:off\n❯" : "";
  return { nothrow() { return this; }, quiet: async () => ({ exitCode: 0, stdout: Buffer.from(stdout) }) };
};
Bun.sleep = async () => {};
globalThis.fetch = async () => new Response("{}", { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.99" } });
globalThis.setInterval = () => 0;
