/**
 * Settings, all from the environment. `.env.example` lists them.
 * Secrets are wrapped in `Secret` as soon as they are read.
 */

import { Secret } from "./serve/secret.ts";
import { SetupError } from "./setup_error.ts";

export interface Config {
  slackBotToken: Secret;
  slackAppToken: Secret;
  serveUrl: string;
  integrationCredential: Secret;
  stateDir: string;
  storeKey: Secret;
  commandsFile: string;
  serveTimeoutMs: number;
}

export function loadConfig(env: (name: string) => string | undefined = Deno.env.get): Config {
  const missing: string[] = [];
  const need = (name: string) => {
    const value = env(name)?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const config: Config = {
    slackBotToken: new Secret(need("SLACK_BOT_TOKEN")),
    slackAppToken: new Secret(need("SLACK_APP_TOKEN")),
    serveUrl: need("SWAMP_SERVE_URL"),
    integrationCredential: new Secret(need("SWAMP_INTEGRATION_CREDENTIAL")),
    stateDir: env("SLACKWATER_STATE_DIR")?.trim() || "./state",
    storeKey: new Secret(need("SLACKWATER_STORE_KEY")),
    commandsFile: env("SLACKWATER_COMMANDS")?.trim() || "./commands.yaml",
    serveTimeoutMs: Number(env("SLACKWATER_SERVE_TIMEOUT_MS") ?? "") || 10_000,
  };
  if (missing.length > 0) {
    throw new SetupError(`missing settings: ${missing.join(", ")}. See .env.example.`);
  }
  // Check the shapes, without ever printing a value.
  const shapes: [string, Secret, string][] = [
    ["SLACK_BOT_TOKEN", config.slackBotToken, "xoxb-"],
    ["SLACK_APP_TOKEN", config.slackAppToken, "xapp-"],
    ["SWAMP_INTEGRATION_CREDENTIAL", config.integrationCredential, "swi1."],
  ];
  const wrong = shapes.filter(([, value, prefix]) => !value.reveal().startsWith(prefix))
    .map(([name, , prefix]) => `${name} should start with ${prefix}`);
  if (!/^https?:\/\//.test(config.serveUrl)) wrong.push("SWAMP_SERVE_URL should be a URL");
  if (wrong.length > 0) throw new SetupError(`settings look wrong: ${wrong.join("; ")}`);
  return config;
}
