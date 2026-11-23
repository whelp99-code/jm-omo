import { describe, expect, it } from "bun:test";
import { resolveFleetConfig } from "./config.mjs";
import { readFileSync } from "node:fs";

describe("fleet configuration", () => {
  it("preserves pane defaults and applies configuration overrides", () => {
    const defaults = JSON.parse(readFileSync(new URL("./fleet.config.json", import.meta.url), "utf8"));
    const config = resolveFleetConfig(defaults, {
      FLEET_CAT_CRM_PANE: "w9:p4",
      FLEET_SLACK_REVIEW_CHANNEL: "C_TEST",
      FLEET_CURSOR_USER_ID: "U_TEST",
      FLEET_REVIEW_REPLY_APP_ID: "A_TEST",
      FLEET_AGENT_MESSENGER_CREDENTIAL_PATH: "/tmp/credential-manager.js",
    });
    expect(config.cats.find((cat) => cat.id === "crm").pane).toBe("w9:p4");
    expect(config.slack).toEqual({
      reviewChannel: "C_TEST",
      cursorUserId: "U_TEST",
      reviewReplyAppId: "A_TEST",
    });
    expect(defaults.prLoop).toMatchObject({
      enabled: false,
      autoMerge: false,
      reviewChannel: "C0C5Z4SJ309",
      reviewThreadTs: "1791757469.519659",
      deploy: {},
    });
    expect(resolveFleetConfig(defaults, {
      FLEET_PR_LOOP_ENABLED: "true",
      FLEET_PR_LOOP_AUTO_MERGE: "true",
    }).prLoop).toMatchObject({ enabled: true, autoMerge: true });
    expect(config.agentMessengerCredentialPath).toBe("/tmp/credential-manager.js");
    const panes = Object.fromEntries(defaults.cats.map((cat) => [cat.id, cat.pane]));
    expect(panes).toMatchObject({
      omonyang: "w3:p2",
      gajae: "w2:p1",
      jarvis: "w5:p1",
      sb: "w5:p2",
      price: "w5:p3",
      crm: "w5:p4",
      mail: "w5:p5",
      omodev: "-",
      jarvis2: "-",
    });
    expect(defaults.agentMessengerCredentialPath.startsWith("/")).toBe(true);
  });
});
