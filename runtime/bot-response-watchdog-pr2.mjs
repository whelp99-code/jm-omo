// PR2 slice: link one Dori input to its session and confirmed Slack reply id.
// Does not read last_reply, does not send, and does not open a live database.

export function linkDoriInput(rows) {
  const request = rows?.request ?? null;
  const native = rows?.native ?? null;
  const reply = rows?.reply ?? null;
  const messageTs = request?.message_ts ?? null;
  const sessionId = native?.request_id === request?.id ? native.session_id ?? null : null;
  const replyId = reply?.request_id === request?.id && reply?.state === "confirmed"
    ? reply.provider_ts ?? null
    : null;
  const inference = "unsupported";
  const linked = Boolean(messageTs && sessionId && replyId);
  return {
    schema: "bot-response-watchdog.pr2.dori-input",
    bot: "dori",
    inputMessageId: messageTs,
    sessionId,
    inference,
    slackReplyMessageId: replyId,
    replyLink: linked ? "partial" : "unsupported",
    ignoredGlobalMax: true,
  };
}
