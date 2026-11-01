// require-owner-approval.sh와 같은 판정이다. Slack을 조회하지 않고, 넘겨받은 응답만 본다.
const OWNER = "U0B833NMP5J";
const DORI = "U0C97QLUFUG";
const CHANNEL = "C0C9YHNUHUN";
const NUMBERS = new Set(["1", "6", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26"]);
const TS = /^\d{10}\.\d{6}$/;
const SEP = "(?:번)?[ \\t\\-.:,)]*";

function markers(message) {
  if (!message || typeof message !== "object") return true;
  if (message.bot_id || message.app_id || message.bot_profile) return true;
  return message.subtype === "bot_message";
}

function delegated(text) {
  const compact = String(text ?? "").replace(/\s+/g, "");
  return compact.includes("추천대로") || compact === "승인" || compact === "반영";
}

function blanket(text) {
  return /모두[ \t]+(?:진행|승인|반영)/.test(String(text ?? ""));
}

function tableRecommendation(text, number) {
  for (const line of String(text ?? "").split("\n")) {
    const stripped = line.trim();
    if (!stripped.startsWith("|")) continue;
    const cells = stripped.replace(/^\|/, "").replace(/\|$/, "").split("|").map((part) => part.trim());
    if (cells.length < 2) continue;
    const head = cells[0];
    const last = cells[cells.length - 1];
    if (head === number) return last;
    const alternatives = head.match(/(?<![0-9])\d+(?![0-9])/g) ?? [];
    if (alternatives.includes(number) && (head.includes("또는") || head.includes("혹은")) && last === number) return "반영";
    const tokens = head.split("·").map((part) => part.trim()).filter(Boolean);
    if (tokens.length > 1 && tokens.every((token) => /^[0-9]+$/.test(token)) && tokens.includes(number)) return last;
  }
  return null;
}

function phraseCode(text, number, verbs) {
  const body = String(text ?? "");
  const n = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hold = new RegExp(`(?<![0-9])${n}${SEP}(?:보류|되돌)`);
  const approvalThenHold = new RegExp(`(?<![0-9])${n}${SEP}(?:${verbs.join("|")})[^\\n0-9]{0,12}(?:보류|되돌)`);
  const approval = new RegExp(`(?<![0-9])${n}${SEP}(?:${verbs.join("|")})`);
  if (hold.test(body) || approvalThenHold.test(body)) return "OWNER_APPROVAL_HELD";
  if (!approval.test(body)) return "OWNER_APPROVAL_PHRASE";
  return "";
}

function listedCode(text, number, verbs) {
  const cell = tableRecommendation(text, number);
  if (cell == null) return phraseCode(text, number, verbs);
  if (cell.includes("보류") || cell.includes("되돌")) return "OWNER_APPROVAL_HELD";
  if ([...verbs, "만들기"].some((verb) => cell.includes(verb))) return "";
  return "OWNER_APPROVAL_PHRASE";
}

function itemRecommendation(text, number) {
  const cell = tableRecommendation(text, number);
  if (cell != null) return cell;
  const match = String(text ?? "").match(new RegExp(`(?<![0-9])${number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[.．]\\s+[^\\n]*?추천\\s*[:：]\\s*([^\\n*]+)`));
  return match ? match[1].trim().replace(/^\*+|\*+$/g, "").trim() : null;
}

function blanketCode(text, number) {
  const cell = itemRecommendation(text, number);
  const verbs = ["반영", "개발", "유지", "머지"];
  if (cell == null) {
    if (!new RegExp(`(?<![0-9])${number}(?![0-9])`).test(String(text ?? ""))) return "OWNER_APPROVAL_NOT_LISTED";
    return listedCode(text, number, verbs);
  }
  if (cell.includes("보류") || cell.includes("되돌")) return "OWNER_APPROVAL_HELD";
  if (verbs.some((verb) => cell.includes(verb))) return "";
  return "OWNER_APPROVAL_PHRASE";
}

function messageFor(messages, ts, defaultChannel) {
  const matched = messages.filter((item) => item && typeof item === "object" && item.ts === ts);
  if (matched.length === 0) return { code: "OWNER_APPROVAL_NOT_FOUND" };
  const message = matched[0];
  const channel = typeof message.channel === "string" && message.channel ? message.channel : defaultChannel;
  return { message, channel };
}

function decide(approval, approvalChannel, recommendation, recommendationChannel, token, number, recommendationTs) {
  if (approvalChannel !== CHANNEL) return "OWNER_APPROVAL_WRONG_CHANNEL";
  if (markers(approval)) return "OWNER_APPROVAL_BOT";
  if (approval.user !== OWNER || approval.ts !== token) return "OWNER_APPROVAL_NOT_OWNER";
  const direct = phraseCode(approval.text, number, ["반영", "승인", "유지"]);
  if (direct === "OWNER_APPROVAL_HELD") return direct;
  if (direct === "") return "ok";
  if (blanket(approval.text)) {
    if (!recommendationTs) return "OWNER_APPROVAL_RECOMMENDATION_REQUIRED";
    if (!recommendation) return "OWNER_APPROVAL_NOT_FOUND";
    if (recommendationChannel !== CHANNEL) return "OWNER_APPROVAL_WRONG_CHANNEL";
    if (recommendation.user !== DORI || recommendation.ts !== recommendationTs) {
      return markers(recommendation) ? "OWNER_APPROVAL_BOT" : "OWNER_APPROVAL_RECOMMENDATION_AUTHOR";
    }
    return blanketCode(recommendation.text, number) || "ok";
  }
  if (!delegated(approval.text)) return "OWNER_APPROVAL_PHRASE";
  if (!recommendationTs) return "OWNER_APPROVAL_RECOMMENDATION_REQUIRED";
  if (!recommendation) return "OWNER_APPROVAL_NOT_FOUND";
  if (recommendationChannel !== CHANNEL) return "OWNER_APPROVAL_WRONG_CHANNEL";
  if (recommendation.user !== DORI || recommendation.ts !== recommendationTs) {
    return markers(recommendation) ? "OWNER_APPROVAL_BOT" : "OWNER_APPROVAL_RECOMMENDATION_AUTHOR";
  }
  return listedCode(recommendation.text, number, ["반영", "승인", "유지", "머지"]) || "ok";
}

export function approvalAccepted({ token, number, recommendationTs = "", fixture } = {}) {
  if (typeof token !== "string" || !TS.test(token)) return { ok: false, code: "OWNER_APPROVAL_TS_INVALID" };
  if (!NUMBERS.has(String(number ?? ""))) return { ok: false, code: "OWNER_APPROVAL_NUMBER_INVALID" };
  if (recommendationTs && (typeof recommendationTs !== "string" || !TS.test(recommendationTs))) {
    return { ok: false, code: "OWNER_APPROVAL_TS_INVALID" };
  }
  if (!fixture || typeof fixture !== "object" || fixture.ok === false || fixture.error) {
    return { ok: false, code: "OWNER_APPROVAL_NOT_FOUND" };
  }
  const messages = Array.isArray(fixture.messages) ? fixture.messages : [];
  const defaultChannel = typeof fixture.channel === "string" ? fixture.channel : "";
  const approval = messageFor(messages, token, defaultChannel);
  if (approval.code) return { ok: false, code: approval.code };
  let recommendation = null;
  let recommendationChannel = "";
  if (recommendationTs) {
    const found = messageFor(messages, recommendationTs, defaultChannel);
    if (found.code) return { ok: false, code: found.code };
    recommendation = found.message;
    recommendationChannel = found.channel;
  }
  const code = decide(approval.message, approval.channel, recommendation, recommendationChannel, token, String(number), recommendationTs);
  return { ok: code === "ok", code };
}
