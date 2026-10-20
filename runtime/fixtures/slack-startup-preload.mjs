import { mock } from "bun:test";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const config = await Bun.file(new URL("../../fleet/fleet.config.json", import.meta.url)).json();
const sdk = new URL("./index.js", pathToFileURL(config.agentMessengerCredentialPath)).pathname;
const failure = process.env.SLACK_STARTUP_FIXTURE;
const rejected = (code) => Object.assign(new Error("private fixture detail xoxb-do-not-log"), { code });
const factory = source => () => {
  writeFileSync(`${process.env.HOME}/sdk-source`, source);
  if (failure === "module") throw rejected("ERR_MODULE_NOT_FOUND");
  return {
    SlackBotCredentialManager: class {
      getCredentials() {
        if (failure === "private-message") throw new Error("EPRIVATE_ACCOUNT_ID");
        if (failure === "credentials") throw rejected("EACCES");
        return { token: "xoxb-task-owned-fixture" };
      }
    },
    SlackBotClient: class {
      login() {
        if (failure === "login") {
          throw Object.assign(new Error("private fixture detail xoxb-do-not-log"), { data: { error: "invalid_auth" } });
        }
        return this;
      }
    },
    SlackBotListener: class {
      on() {}
      stop() {}
      start() { throw new Error("private fixture detail xoxb-do-not-log", { cause: rejected("ECONNREFUSED") }); }
    },
  };
};
mock.module(sdk, factory("default"));
if (process.env.FLEET_AGENT_MESSENGER_CREDENTIAL_PATH) {
  mock.module(new URL("./index.js", pathToFileURL(process.env.FLEET_AGENT_MESSENGER_CREDENTIAL_PATH)).pathname, factory("override"));
}
