import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const config = await Bun.file(new URL("../../fleet/fleet.config.json", import.meta.url)).json();
const specifier = (credentialPath) => fileURLToPath(new URL("./index.js", pathToFileURL(credentialPath)));
const record = (source, path) => {
  appendFileSync(process.env.HOURLY_IMPORT_LOG, `${source} ${path}\n`);
  return {
    SlackBotCredentialManager: class {
      getCredentials() { return { token: "xoxb-task-owned-fixture", marker: source }; }
    },
  };
};
mock.module(specifier(config.agentMessengerCredentialPath), () => record("default", specifier(config.agentMessengerCredentialPath)));
const override = process.env.FLEET_AGENT_MESSENGER_CREDENTIAL_PATH;
if (override) mock.module(specifier(override), () => record("override-import", specifier(override)));
