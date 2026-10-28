import { expect, test } from "bun:test";
import { linkDoriInput, linkGajaegunInput } from "./bot-response-watchdog-pr2.mjs";

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

test("gajaegun links only a confirmed payload slack ts for the same delivery and session", () => {
  const linked = linkGajaegunInput({
    inbound: {
      message_id: "C0C6HJM0BV5:1793201965.550809",
      bound_session_id: "session-1",
      terminal_delivery_id: "gw-1",
    },
    delivery: {
      delivery_id: "gw-1",
      state: "confirmed",
      payload: { sessionId: "session-1", slackTs: "1793202263.539099", deliveryId: "gw-1" },
    },
  });
  expect(linked.slackReplyMessageId).toBe("1793202263.539099");
  expect(linked.replyLink).toBe("partial");
  expect(linked.inference).toBe("unsupported");
  expect(linked.gatewayDeliveryIdIsSlackTs).toBe(false);
});

test("a gateway delivery id without slack ts does not confirm a gajaegun reply", () => {
  const linked = linkGajaegunInput({
    inbound: {
      message_id: "C0C6HJM0BV5:1793201965.550809",
      bound_session_id: "session-1",
      terminal_delivery_id: "gw-1",
    },
    delivery: {
      delivery_id: "gw-1",
      state: "confirmed",
      payload: { sessionId: "session-1", deliveryId: "gw-1" },
    },
  });
  expect(linked.slackReplyMessageId).toBeNull();
  expect(linked.replyLink).toBe("unsupported");
});
