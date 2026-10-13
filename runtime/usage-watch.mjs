// Provider-usage guard (whelp99 2026-09-28): when the provider a session is using reaches 95%,
// switch that session to another provider. No user notifications; prints USAGE_* lines for the monitor only.
//
// 2026-10-05 (윤비서): Anthropic auth/usage failures (e.g. HTTP 403 oauth_not_allowed) used to
// collapse to 0% via `Number(null)||0`, which made selfPolicy force-switch OmO back to Opus and
// broke every call until Codex was restored. Rules now:
//  1) Usage/auth lookup failure is FAILURE (throw → USAGE_ERROR), never treated as 0% idle.
//  2) OmO temporary secondary is the approved Codex model (gpt-6.1-sol); do not auto-revert to Opus
//     merely because a usage read looks low.
//  3) Auto-return to Opus only after a successful real Opus model call (not usage-header HTTP 200).
const INTERVAL = 10 * 60 * 1000;
const LIMIT = 0.95;
const FALLBACK = {
  anthropic: "xai/grok-4.7",
  "chatgpt-subscription": "xai/grok-4.7",
  "cursor-cli-oauth": "xai/grok-4.7",
};
const ORCA_TERMINALS = ["term_8eac441f-f846-4a47-b602-1148570eda89"]; // JARVIS OmO session, reopened after the 2026-09-29 12:49 reboot
const HERDR_PANES = ["w1:p1", "w2:p1"];

const sh = async (cmd) => (await Bun.$`bash -c ${cmd}`.nothrow().quiet()).stdout.toString();

async function anthropicBearer() {
  const tok = (await sh("omo auth print-bearer-token --provider anthropic")).trim();
  if (!tok) throw new Error("anthropic bearer empty");
  return tok;
}

async function anthropicUsage() {
  const tok = await anthropicBearer();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer " + tok, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  });
  if (r.status === 429) return 1;
  // Auth/org failures (403 oauth_not_allowed, 401, …) must not collapse to 0%.
  if (!r.ok) throw new Error(`anthropic usage HTTP ${r.status}`);
  const u5 = r.headers.get("anthropic-ratelimit-unified-5h-utilization");
  const u7 = r.headers.get("anthropic-ratelimit-unified-7d-utilization");
  if (u5 == null && u7 == null) throw new Error("anthropic usage headers missing");
  return Math.max(Number(u5) || 0, Number(u7) || 0);
}

/** Real Opus call used only as evidence before auto-returning OmO to SELF_PRIMARY. */
async function opusCallSucceeds() {
  const tok = await anthropicBearer();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer " + tok, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  });
  if (r.status === 429) return true; // rate-limited still means the call was accepted by the model path
  return r.ok;
}

async function chatgptUsage() {
  const d = JSON.parse(await Bun.file(`${process.env.HOME}/.opencodex/codex-quota-cache.json`).text());
  const pcts = Object.values(d.quotas || {}).filter((q) => q.weeklyResetAt * 1000 > Date.now()).map((q) => q.weeklyPercent / 100);
  if (!pcts.length) throw new Error("chatgpt quota cache empty or expired");
  return Math.min(...pcts);
}

const footerProvider = (screen) => screen.match(/\((anthropic|chatgpt-subscription|cursor-cli-oauth|xai)[@)]/)?.[1];
const footerModel = (screen) => screen.match(/\((anthropic|chatgpt-subscription|cursor-cli-oauth|xai)(?:@[^)]*)?\)[\s\u26a1]+([\w.\-]+)/)?.[2]
  ?? screen.match(/~\/\.omo\/omonyang[^\n]*\b(gpt-6\.1-sol|gpt-6-sol|gpt-6-astra|claude-opus-5-5):/)?.[1];
const footerSel = (screen) => {
  const m = screen.match(/\((anthropic|chatgpt-subscription|cursor-cli-oauth|xai)(?:@[^)]*)?\)[\s\u26a1]+([\w.\-]+):(\w+)/);
  return m ? { provider: m[1], model: m[2], thinking: m[3] } : {};
};

// 오모냥: fixed to Opus 5.5 high by owner 2026-10-06 (no secondary switch). Historical: Opus 5.5 high primary; temporary Codex gpt-6.1-sol high while Claude is at limit
// or until a real Opus call succeeds again (2026-10-05 Jae Min temporary Codex approval).
// Herdr pane w5:p1.
const SELF_PANE = "w5:p1";
const SELF_PRIMARY = { provider: "anthropic", model: "claude-opus-5-5", thinking: "high" };
const SELF_SECONDARY = { provider: "chatgpt-subscription", model: "gpt-6.1-sol", thinking: "high" };

async function sendCmd(text, confirm) {
  await Bun.$`herdr pane send-text ${SELF_PANE} ${text}`.nothrow().quiet();
  await Bun.sleep(500);
  await Bun.$`herdr pane send-keys ${SELF_PANE} Enter`.nothrow().quiet();
  if (confirm) {
    await Bun.sleep(800);
    await Bun.$`herdr pane send-keys ${SELF_PANE} Enter`.nothrow().quiet();
  }
}

async function selfPolicy(usage) {
  // Disabled 2026-10-13: JARVIS owns w5:p1; fleet usage checks must not switch it.
  return;
  let screen = await sh(`herdr pane read ${SELF_PANE} --source visible --format text`);
  if (/esc to interrupt/.test(screen) || usage.anthropic === undefined) return;
  const cur = footerSel(screen);
  if (!cur.model) {
    console.log("USAGE_HOLD self:omonyang footer unreadable; no command sent");
    return;
  }
  const onSecondary = cur.model === SELF_SECONDARY.model || cur.model === "gpt-6.1-sol-fast" || cur.model === "gpt-6-astra" || cur.model === "gpt-6-astra-fast";

  // 2026-10-06 owner (C0C5Z4SJ309:1791293906.307409): 오모냥 is fixed to Opus 5.5 high.
  // Never switch this session to another model, regardless of Claude usage.
  let want = SELF_PRIMARY;
  if (false) {
    // Usage looks available, but do NOT return to Opus on usage headers alone.
    // Require a successful real Opus model call (rule 3).
    let ok = false;
    try {
      ok = await opusCallSucceeds();
    } catch (e) {
      console.log("USAGE_HOLD self:omonyang stay " + SELF_SECONDARY.model + " (opus probe error: " + (e?.message || e) + ")");
      return;
    }
    if (!ok) {
      console.log("USAGE_HOLD self:omonyang stay " + SELF_SECONDARY.model + " (opus call not ok; anthropic " + Math.round(usage.anthropic * 100) + "%)");
      return;
    }
    want = SELF_PRIMARY;
    console.log("USAGE_OPUS_OK self:omonyang probe succeeded; allowing return to " + SELF_PRIMARY.model);
  } else {
    want = SELF_PRIMARY;
  }

  if (cur.model !== want.model) {
    const id = `${want.provider}/${want.model}`;
    await sendCmd(`/model ${id}`, true);
    console.log(`USAGE_SWITCH self:omonyang ${cur.provider}/${cur.model} -> ${id} (anthropic ${Math.round(usage.anthropic * 100)}%)`);
    await Bun.sleep(1200);
    screen = await sh(`herdr pane read ${SELF_PANE} --source visible --format text`);
  }
  const after = footerSel(screen);
  if (after.model === want.model && after.thinking && after.thinking !== want.thinking) {
    await sendCmd(`/thinking ${want.thinking}`, false);
    console.log(`USAGE_THINKING self:omonyang ${after.model} ${after.thinking} -> ${want.thinking}`);
  }
}

async function readOrca(h) {
  const j = JSON.parse(await sh(`orca terminal read --terminal ${h} --screen --json`));
  const t = j.result.terminal.tail;
  return typeof t === "string" ? t : t.join("\n");
}

async function switchIfNeeded(label, screen, send, usage) {
  const prov = footerProvider(screen);
  if (!prov || !(prov in FALLBACK) || usage[prov] === undefined || usage[prov] < LIMIT) return;
  if (/esc to interrupt/.test(screen)) return console.log(`USAGE_WAIT ${label} busy on ${prov}`);
  const target = FALLBACK[prov];
  const lastSelection = [...screen.matchAll(/^\s*Model:\s+([\w.-]+)/gm)].at(-1)?.[1];
  if (lastSelection === target.split("/")[1]) return;
  await send(`/model ${target}`);
  console.log(`USAGE_SWITCH ${label} ${prov} ${Math.round(usage[prov] * 100)}% -> ${target}`);
}

async function tick() {
  const usage = {};
  try { usage.anthropic = await anthropicUsage(); } catch (e) { console.log("USAGE_ERROR anthropic " + (e?.message || e)); }
  try { usage["chatgpt-subscription"] = await chatgptUsage(); } catch (e) { console.log("USAGE_ERROR chatgpt " + (e?.message || e)); }

  for (const h of ORCA_TERMINALS) {
    try {
      await switchIfNeeded(`orca:${h.slice(0, 13)}`, await readOrca(h), async (text) => {
        await Bun.$`orca terminal send --terminal ${h} --text ${text} --json`.nothrow().quiet();
        for (let i = 0; i < 2; i++) {
          await Bun.sleep(800);
          await Bun.$`orca terminal send --terminal ${h} --text ${"\r"} --json`.nothrow().quiet();
        }
      }, usage);
    } catch (e) { console.log(`USAGE_ERROR ${h} ${e?.message || e}`); }
  }
  for (const p of HERDR_PANES) {
    try {
      await switchIfNeeded(`herdr:${p}`, await sh(`herdr pane read ${p}`), async (text) => {
        await Bun.$`herdr pane send-text ${p} ${text}`.nothrow().quiet();
        for (let i = 0; i < 2; i++) {
          await Bun.sleep(800);
          await Bun.$`herdr pane send-keys ${p} Enter`.nothrow().quiet();
        }
      }, usage);
    } catch (e) { console.log(`USAGE_ERROR ${p} ${e?.message || e}`); }
  }
  try { await selfPolicy(usage); } catch (e) { console.log(`USAGE_ERROR self ${e?.message || e}`); }

  console.log(`USAGE_TICK ${Object.entries(usage).map(([k, v]) => `${k}=${Math.round(v * 100)}%`).join(" ") || "(no successful reads)"}`);
}

await tick();
setInterval(() => tick().catch((e) => console.log("USAGE_ERROR " + (e?.message || e))), INTERVAL);
