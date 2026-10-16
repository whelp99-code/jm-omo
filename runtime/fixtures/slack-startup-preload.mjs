import { mock } from "bun:test";
import { pathToFileURL } from "node:url";

const config = await Bun.file(new URL("../../fleet/fleet.config.json", import.meta.url)).json();
const sdk = new URL("./index.js", pathToFileURL(config.agentMessengerCredentialPath)).pathname;
const failure = process.env.SLACK_STARTUP_FIXTURE;
const rejected = (code) => Object.assign(new Error("private fixture detail xoxb-do-not-log"), { code });
mock.module(sdk, () => {
  if (failure === "module") throw rejected("ERR_MODULE_NOT_FOUND");
  return {
    SlackBotCredentialManager: class {
      getCredentials() {
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
});
