import { readFileSync } from "node:fs";

export function resolveFleetConfig(config, env = process.env) {
  const envBoolean = (value, fallback) => value === undefined ? Boolean(fallback) : value === "true";
  const cats = config.cats.map(cat => {
    const envKey = `FLEET_CAT_${cat.id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_PANE`;
    return { ...cat, pane: env[envKey] || cat.pane };
  });
  const orcaTerminals = env.FLEET_USAGE_ORCA_TERMINALS === undefined
    ? config.usageWatch?.orcaTerminals ?? [] : JSON.parse(env.FLEET_USAGE_ORCA_TERMINALS);
  if (!Array.isArray(orcaTerminals) || orcaTerminals.some(value => typeof value !== "string" || !value.trim())) {
    throw new Error("FLEET_USAGE_ORCA_TERMINALS_INVALID");
  }
  return {
    ...config, cats,
    slack: {
      ...config.slack,
      reviewChannel: env.FLEET_SLACK_REVIEW_CHANNEL || config.slack.reviewChannel,
      cursorUserId: env.FLEET_CURSOR_USER_ID || config.slack.cursorUserId,
      reviewReplyAppId: env.FLEET_REVIEW_REPLY_APP_ID || config.slack.reviewReplyAppId,
    },
    prLoop: {
      ...config.prLoop,
      enabled: envBoolean(env.FLEET_PR_LOOP_ENABLED, config.prLoop?.enabled),
      autoMerge: envBoolean(env.FLEET_PR_LOOP_AUTO_MERGE, config.prLoop?.autoMerge),
      deploy: config.prLoop?.deploy ?? {},
      mergeMethods: config.prLoop?.mergeMethods ?? {},
    },
    usageWatch: {
      ...config.usageWatch, orcaTerminals,
      herdrPanes: (config.usageWatch?.catIds ?? []).map(id => cats.find(cat => cat.id === id)?.pane)
        .filter(pane => pane && pane !== "-"),
      selfPane: cats.find(cat => cat.id === "omonyang")?.pane ?? "-",
    },
    agentMessengerCredentialPath: env.FLEET_AGENT_MESSENGER_CREDENTIAL_PATH || config.agentMessengerCredentialPath,
  };
}

export function loadFleetConfig(env = process.env) {
  return resolveFleetConfig(JSON.parse(readFileSync(new URL("./fleet.config.json", import.meta.url), "utf8")), env);
}
