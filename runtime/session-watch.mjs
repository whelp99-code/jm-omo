// Watches Orca terminals and herdr agents; posts to Discord (as the bot) when a
// session finishes, stalls, or waits for input. Prints SESSION_* lines for the monitor.
const CHANNEL = "1553646054778470494";
// 오모냥 now runs in omonyang.service (screen), not an Orca terminal, so there is no
// fixed handle. Skip any terminal or agent titled 오모냥 in case one is opened again.
const isSelf = (title) => /오모냥|omonyang/i.test(title || "");
const POLL_MS = 20_000;
const DONE_IDLE_MS = 45_000;
const STALL_MS = 10 * 60_000;

const state = new Map(); // key -> { working, lastOutputAt, stallReported, title }
let first = true;

const run = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
};

const post = async (text) => {
  if (process.env.SESSION_WATCH_POST === "0") return;
  const p = Bun.spawn(["agent-discordbot", "message", "send", CHANNEL, text], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
};

const isAgentTerminal = (t) =>
  Boolean(t.agentIdentity) || /^(OmO|✳|Claude|Codex|grok)/i.test(t.title || "") || /esc to interrupt/.test(t.preview || "");

async function pollOrca(now, events) {
  let json;
  try {
    json = JSON.parse(await run(["orca", "terminal", "list", "--json"]));
  } catch {
    return;
  }
  for (const t of json?.result?.terminals || []) {
    if (isSelf(t.title) || !isAgentTerminal(t)) continue;
    const key = "orca:" + t.handle;
    const marker = /esc to interrupt/.test(t.preview || "");
    const idleFor = now - (t.lastOutputAt || 0);
    const prev = state.get(key);
    const where = (t.worktreePath || "").split("/").pop();
    const title = `${t.title || t.handle} (${where})`;
    if (prev && !first) {
      // Only a turn we actually saw running ("esc to interrupt") can finish;
      // prompt repaints move lastOutputAt without any work happening.
      if (prev.sawMarker && !marker && idleFor > DONE_IDLE_MS) {
        // Never forward terminal text: previews can hold passwords or tokens.
        events.push({ kind: "DONE", title, detail: "턴이 멈췄어. 내용은 내가 읽고 따로 정리할게." });
      } else if (marker && idleFor > STALL_MS && !prev.stallReported) {
        events.push({ kind: "STALL", title, detail: `${Math.round(idleFor / 60000)}분째 출력 없음` });
        state.set(key, { ...prev, stallReported: true, sawMarker: true });
        continue;
      }
    }
    const finished = Boolean(prev?.sawMarker && !marker && idleFor > DONE_IDLE_MS);
    state.set(key, {
      sawMarker: marker || (Boolean(prev?.sawMarker) && !finished),
      stallReported: marker ? prev?.stallReported || false : false,
      title,
    });
  }
}

async function pollHerdr(events) {
  let json;
  try {
    json = JSON.parse(await run(["herdr", "agent", "list"]));
  } catch {
    return;
  }
  for (const a of json?.result?.agents || []) {
    if (isSelf(a.terminal_title_stripped || a.title)) continue;
    const key = "herdr:" + a.pane_id;
    const status = a.agent_status;
    const title = `${a.terminal_title_stripped || a.title} (herdr ${a.pane_id})`;
    const prev = state.get(key);
    if (prev && !first && prev.status !== status) {
      if (prev.status === "working" && (prev.workingPolls || 0) >= 3 && status !== "working" && status !== "blocked") {
        events.push({ kind: "DONE", title, detail: `상태 ${status}` });
      } else if (status === "blocked") {
        events.push({ kind: "BLOCKED", title, detail: "입력이나 승인을 기다려" });
      }
    }
    const workingPolls = status === "working" ? (prev?.status === "working" ? (prev.workingPolls || 0) + 1 : 1) : 0;
    state.set(key, { status, title, workingPolls });
  }
}

const labels = { DONE: "✅ 끝났어", STALL: "⏸ 멈춘 것 같아", BLOCKED: "✋ 입력 기다려" };

async function tick() {
  const now = Date.now();
  const events = [];
  await Promise.all([pollOrca(now, events), pollHerdr(events)]);
  if (first) {
    first = false;
    console.log(`SESSION_WATCH_UP tracked=${state.size}`);
  }
  for (const e of events) {
    console.log(`SESSION_${e.kind} ${e.title} | ${e.detail}`);
    await post(`${labels[e.kind]}: ${e.title}\n${e.detail}`.slice(0, 1900));
  }
}

await tick();
setInterval(() => {
  tick().catch((err) => console.log("SESSION_WATCH_ERROR " + (err?.message || err)));
}, POLL_MS);
