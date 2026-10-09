// One-shot secret drop page, tailnet only.
// Usage: bun secret-drop.ts <name> <bind-ip> <port>
// Prints a URL with a random one-time path. The first valid POST writes the
// secret to ~/.config/omonyang/secrets/<name> (0600) and the server exits.
// The secret value is never logged or echoed back.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const [name, host, portArg] = process.argv.slice(2);
if (!name || !/^[a-z0-9-]+$/.test(name) || !host || !portArg) {
  console.error("usage: bun secret-drop.ts <name> <bind-ip> <port>");
  process.exit(2);
}
const token = randomBytes(24).toString("base64url");
const dir = join(homedir(), ".config/omonyang/secrets");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const target = join(dir, name);
const expiresAt = Date.now() + 30 * 60 * 1000;

const page = `<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>오모냥 비밀값 전달</title>
<body style="font-family:system-ui;max-width:520px;margin:24px auto;padding:0 16px;font-size:17px">
<h2>오모냥에게 비밀값 전달 (${name})</h2>
<p>복사한 값을 붙여넣고 보내기를 누르세요. 한 번만 쓸 수 있고 30분 뒤 닫힙니다.</p>
<form method="post"><textarea name="v" rows="4" style="width:100%;font-size:16px" autocomplete="off"></textarea>
<button style="margin-top:12px;font-size:18px;padding:10px 20px">보내기</button></form></body></html>`;

const server = Bun.serve({
  hostname: host,
  port: Number(portArg),
  async fetch(req) {
    const url = new URL(req.url);
    if (Date.now() > expiresAt) { setTimeout(() => process.exit(3), 50); return new Response("만료됨", { status: 410 }); }
    if (url.pathname !== `/${token}`) return new Response("not found", { status: 404 });
    if (req.method === "GET") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (req.method === "POST") {
      const form = await req.formData();
      const v = String(form.get("v") ?? "").trim();
      if (v.length < 8 || v.length > 4096) return new Response("값이 비어 있거나 너무 깁니다", { status: 400 });
      writeFileSync(target, v + "\n", { mode: 0o600 });
      chmodSync(target, 0o600);
      console.log(`SECRET_SAVED ${name} len=${v.length}`);
      setTimeout(() => { server.stop(); process.exit(0); }, 100);
      return new Response("<meta name=viewport content='width=device-width'><p style='font-size:20px'>받았어요. 창을 닫아도 됩니다.</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("method not allowed", { status: 405 });
  },
});
console.log(`SECRET_DROP_URL http://${host}:${portArg}/${token}`);
