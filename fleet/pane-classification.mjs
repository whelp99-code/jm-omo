function isQuestionStatusLine(line) {
  return /^\s*(?:Question pending|Unanswered)\s*$/i.test(String(line ?? ""));
}
function completionPromptTemplate(line, key, kind, tail) {
  const normalized = line.replace(/^\s*[`*_~]+/, "").replace(/[`*_~]+\s*$/, "").replace(/\s+/g, " ").trim();
  const normalizedTail = tail.replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/\s+/g, "");
  const compactTail = normalizedTail.replace(/\s+/g, "");
  if (kind === "DONE" && (compact.includes("<한줄요약>") || compactTail.includes("<한줄요약>"))) return true;
  if (kind === "BLOCKED" && (compact.includes("reason=<한줄>") || compactTail.startsWith("reason=<한줄>"))) return true;
  const prefix = normalized.slice(0, normalized.indexOf(`${key}_${kind}`));
  return (kind === "DONE" && normalizedTail === "<summary>" && /instructions|finish with/i.test(prefix))
    || (kind === "BLOCKED" && normalizedTail === "reason=<one line>");
}

function completionMarkerOnLine(line) {
  let text = String(line ?? "").trimStart();
  text = text.replace(/^(?:(?:[-•●⏺✻>])\s*|[*_`~]+\s*)+/, "").replace(/[*_`~]+\s*$/, "").trimEnd();
  const match = text.match(/^(TASK-[A-Z0-9-]+)_(DONE|BLOCKED)\b(.*)$/i);
  return match ? { key: match[1], kind: match[2].toUpperCase(), tail: match[3] } : null;
}

function completionContinuationBoundary(line) {
  return /^\s*(?:❯|[•●]|[-*]\s|⏺|✻|TPS\b|Warning:|Error:|Extension\b|Bash\(|Tool call\b|[─━═-]{3,})/i.test(line);
}

function parseCompletionCandidates(screen) {
  const lines = String(screen ?? "").replace(/\r/g, "").split("\n");
  const dividers = lines.flatMap((line, index) => /^\s*[─━═-]{3,}\s*$/.test(line) ? [index] : []);
  const inputBoxLines = new Set();
  for (const promptIndex of lines.flatMap((line, index) => /^\s*❯/.test(line) ? [index] : [])) {
    const start = dividers.findLast((index) => index < promptIndex);
    const end = dividers.find((index) => index > promptIndex);
    if (start === undefined || end === undefined) continue;
    for (let index = start; index <= end; index++) inputBoxLines.add(index);
  }
  const transcript = lines.map((line, index) => inputBoxLines.has(index) ? null : line);
  const candidates = [];
  for (let index = 0; index < transcript.length; index++) {
    const line = transcript[index];
    if (line === null) continue;
    const marker = completionMarkerOnLine(line);
    if (!marker) continue;
    const { key, kind } = marker;
    let tail = marker.tail;
    const continuationLines = [];
    for (let next = index + 1; next < transcript.length; next++) {
      const continuation = transcript[next];
      if (continuation === null || !continuation.trim() || completionMarkerOnLine(continuation)
        || completionContinuationBoundary(continuation)) break;
      continuationLines.push(continuation.trim());
      tail += ` ${continuation.trim()}`;
    }
    const attemptMatch = tail.match(/(?:^|[\s—–-]\s*)attempt\s*(?:=|:)\s*((?:[a-f0-9-]\s*){36})(?=\s|$)/i);
    const attempt = attemptMatch?.[1].replace(/\s/g, "") ?? null;
    let summary = attemptMatch
      ? `${tail.slice(0, attemptMatch.index)} ${tail.slice(attemptMatch.index + attemptMatch[0].length)}`
      : tail;
    summary = summary.replace(/^[\s—–-]+|[`*_~]+$/g, "").replace(/\s*\n\s*/g, " ").trim();
    const templateContext = [line, ...continuationLines].join(" ");
    candidates.push({
      key, kind, attempt, text: summary,
      filtered: completionPromptTemplate(templateContext, key, kind, summary),
    });
  }
  return candidates;
}

export function classify(screen) {
  const L = screen.split("\n");
  const tail = L.slice(-14).join("\n");
  const footer = [...screen.matchAll(/(?:⚡|\([a-z-]+\)|\s)\s*([a-z][A-Za-z0-9._-]+):(low|medium|high|xhigh|minimal|off)\s*$/gm)].at(-1);
  const model = footer ? `${footer[1]}:${footer[2]}` : "";
  let state = "idle";
  if (/compaction did not complete/i.test(tail) && !/Working \(/.test(tail)) state = "compaction-failed";
  else if (/Compacting/i.test(tail)) state = "compacting";
  else if (/Working \(|Running eval|esc to interrupt/.test(tail)) state = "working";
  else if (L.slice(-14).some(isQuestionStatusLine)) state = "question";
  else if (/Codex error|rate limit|usage limit|429|quota|Unable to verify/i.test(tail)) state = "provider-error";
  else if (/→\s+\S+\s+\[[^\]]+\]/.test(tail)) state = "model-picker";
  const output = responseBlock(screen);
  const doneCandidates = parseCompletionCandidates(screen);
  const parsedDone = doneCandidates.filter((candidate) => !candidate.filtered && candidate.attempt).at(-1);
  const done = parsedDone
    ? { key: parsedDone.key, kind: parsedDone.kind, attempt: parsedDone.attempt, text: parsedDone.text }
    : null;
  const ready = [...output.matchAll(/\b([A-Za-z0-9_.-]+) PR READY head=([0-9a-f]{7,40})\b/gi)].at(-1);
  // Result lines wrap in narrow panes: also look at the latest output block.
  const joined = output.split("\n").slice(-40).map((l) => l.trim()).join(" ");
  const readyLine = [...joined.matchAll(/\b([A-Z]+_[A-Z_]*READY)\b([^❯─]{0,400})/g)].at(-1);
  const claimText = output.split("\n").filter((line) => /\bCursor\s+(?:ACCEPT|APPROVE)\b|\bPR READY\s+head=|\b(?:tests?\s+\d+\s+(?:passed|passing)|\d+\s+tests?\s+(?:passed|passing))\b|테스트\s*\d+\s*(?:개\s*)?통과/i.test(line)).join("\n");
  let questionText = "";
  let questionActionable = false;
  if (state === "question") {
    const screenLines = screen.replace(/\r/g, "").split("\n");
    const marker = screenLines.findLastIndex(isQuestionStatusLine);
    const prompt = screenLines.findLastIndex((line) => /^\s*❯/.test(line));
    const questionLines = marker >= 0
      ? screenLines.slice(marker + 1, prompt >= marker ? prompt : undefined)
      : output.split("\n").filter((line) => !isQuestionStatusLine(line)).slice(-3);
    questionText = questionLines.map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(-800);
    const live = currentQuestionFrame(screenLines);
    questionActionable = Boolean(questionText) && live?.questionText === questionText;
  }
  return { state, model, done, doneCandidates, ready: ready ? { repo: ready[1], head: ready[2] } : null, readyLine: readyLine ? `${readyLine[1]}${readyLine[2]}`.replace(/\s+/g, " ").trim().slice(0, 300) : null, claimText, questionText, questionActionable };
}

function responseBlock(screen) {
  const lines = screen.replace(/\r/g, "").split("\n");
  const prompts = lines.flatMap((line, index) => /^\s*❯/.test(line) ? [index] : []);
  const input = prompts.at(-1);
  if (input === undefined) return "";
  const previousPrompt = prompts.at(-2);
  const visibleLines = lines.slice(previousPrompt === undefined ? 0 : previousPrompt + 1, input);
  if (previousPrompt !== undefined) {
    const response = visibleLines.findLastIndex((line) => /^\s*(?:⏺|●|•|✻|Assistant:)\s*/i.test(line));
    return response < 0 ? "" : visibleLines.slice(response).join("\n").trimEnd();
  }
  const visible = visibleLines.join("\n").trimEnd();
  return visible.split(/\n[ \t]*\n/)
    .filter((block) => block.trim() && !/^\s*(?:TPS [\d.]+ tok\/s\b|[─━]+\s*$)/.test(block))
    .at(-1) ?? "";
}

function paneWidth(lines) {
  return lines.reduce((width, line) => Math.max(width, line.trimEnd().length), 0);
}

function fullWidthRule(line, width) {
  const text = line.trim();
  return /^[─━]+$/.test(text) && text.length >= 8 && text.length >= width;
}

function uiChrome(line, width) {
  return /^\s*❯/.test(line)
    || fullWidthRule(line, width)
    || /(?:⚡|\([a-z-]+\)|\s)\s*[a-z][A-Za-z0-9._-]+:(?:low|medium|high|xhigh|minimal|off)\s*$/.test(line);
}

function contentAbovePrompt(lines) {
  let prompt = lines.length - 1;
  while (prompt >= 0 && !lines[prompt].trim()) prompt -= 1;
  if (prompt < 0 || !/^\s*❯/.test(lines[prompt])) return null;
  const width = paneWidth(lines);
  let start = 0;
  for (let index = prompt - 1; index >= 0; index -= 1) {
    if (uiChrome(lines[index], width)) {
      start = index + 1;
      break;
    }
  }
  const content = lines.slice(start, prompt).filter((line) => line.trim());
  if (content.some((line) => /^[─━]+$/.test(line.trim()) && !fullWidthRule(line, width))) return null;
  return { start, content };
}

function currentQuestionFrame(screenLines) {
  const located = contentAbovePrompt(screenLines);
  if (!located || !isQuestionStatusLine(located.content[0])) return null;
  const body = located.content.slice(1);
  if (body.some((line) => /^\s*(?:```|~~~|⏺|●|•|✻|Assistant:)/i.test(line))) return null;
  if (screenLines.slice(0, located.start).filter((line) => /^\s*(?:```|~~~)/.test(line)).length % 2 !== 0) return null;
  const questionText = body.map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(-800);
  return questionText ? { questionText } : null;
}
