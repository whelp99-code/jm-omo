import { expect, test } from "bun:test";
import { linkDoriInput } from "./bot-response-watchdog-pr2.mjs";

const request = { id: 7, message_ts: "1793201965.550809" };
const native = { request_id: 7, session_id: "01a12f98-67b1-701a-b6cd-cacaf7a2ca11" };
const reply = { request_id: 7, state: "confirmed", provider_ts: "1793202263.539099" };

test("a confirmed reply links only that input id, session, and slack ts", () => {
  expect(linkDoriInput({ request, native, reply })).toEqual({
    schema: "bot-response-watchdog.pr2.dori-input",
    bot: "dori",
    inputMessageId: "1793201965.550809",
    sessionId: "01a12f98-67b1-701a-b6cd-cacaf7a2ca11",
    inference: "unsupported",
    slackReplyMessageId: "1793202263.539099",
    replyLink: "partial",
    ignoredGlobalMax: true,
  });
});

test("another session reply and a global max do not confirm this input", () => {
  const linked = linkDoriInput({
    request,
    native: { request_id: 8, session_id: "other-session" },
    reply: { request_id: 8, state: "confirmed", provider_ts: "1793999999.000001" },
    lastReplyMax: "1793999999.000001",
  });
  expect(linked.sessionId).toBeNull();
  expect(linked.slackReplyMessageId).toBeNull();
  expect(linked.replyLink).toBe("unsupported");
  expect(linked.ignoredGlobalMax).toBe(true);
});

test("done without a confirmed provider ts is not a reply", () => {
  const linked = linkDoriInput({
    request,
    native,
    reply: { request_id: 7, state: "done", provider_ts: "1793202263.539099" },
  });
  expect(linked.slackReplyMessageId).toBeNull();
  expect(linked.replyLink).toBe("unsupported");
});
