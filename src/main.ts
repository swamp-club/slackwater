/**
 * Starts Slackwater: connects to Slack in Socket Mode with Bolt and hands
 * each event to `Slackwater` in `app.ts`.
 *
 * Socket Mode means the app opens an outbound connection to Slack using the
 * app-level token (`xapp-…`), so it needs no public URL and no signing secret.
 * Slack only sends this connection events for this app.
 */

import { App, type BlockAction, type ButtonAction, LogLevel } from "@slack/bolt";
import { type Log, type SlackApi, Slackwater } from "./app.ts";
import { loadCommands } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { ServeClient } from "./serve/client.ts";
import { SetupError } from "./setup_error.ts";
import { EncryptedFileStore } from "./store.ts";
import { TokenKeeper } from "./tokens.ts";

const log: Log = (event, fields = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

async function main() {
  const config = loadConfig();
  const commands = await loadCommands(config.commandsFile);
  const store = await EncryptedFileStore.open(config.stateDir, config.storeKey);
  const serve = new ServeClient({
    baseUrl: config.serveUrl,
    credential: config.integrationCredential,
    timeoutMs: config.serveTimeoutMs,
  });

  const bolt = new App({
    token: config.slackBotToken.reveal(),
    appToken: config.slackAppToken.reveal(),
    socketMode: true,
    // Bolt's debug level logs event bodies. Stay at INFO.
    logLevel: LogLevel.INFO,
  });

  const who = await bolt.client.auth.test();
  if (!who.team_id) throw new Error("Slack's auth.test didn't say which workspace this is");

  const slack: SlackApi = {
    async postMessage(channel, message) {
      const r = await bolt.client.chat.postMessage({ channel, ...message });
      return { channel: r.channel!, ts: r.ts! };
    },
    async update(channel, ts, message) {
      await bolt.client.chat.update({ channel, ts, ...message });
    },
    async postEphemeral(channel, user, message) {
      await bolt.client.chat.postEphemeral({ channel, user, ...message });
    },
    async openView(triggerId, view) {
      // deno-lint-ignore no-explicit-any
      await bolt.client.views.open({ trigger_id: triggerId, view: view as any });
    },
    async userInfo(userId) {
      const r = await bolt.client.users.info({ user: userId });
      const profile = r.user?.profile;
      return {
        display: profile?.display_name || profile?.real_name || r.user?.name || userId,
        email: profile?.email,
        isBot: Boolean(r.user?.is_bot),
      };
    },
  };

  const app = new Slackwater({
    slack,
    serve,
    store,
    tokens: new TokenKeeper(serve, store),
    commands,
    teamId: who.team_id,
    workspaceName: who.team ?? who.team_id,
    log,
  });

  bolt.command(/.*/, async ({ command, ack, respond }) => {
    await app.onCommand(
      {
        command: command.command,
        text: command.text,
        teamId: command.team_id,
        userId: command.user_id,
        channelId: command.channel_id,
        triggerId: command.trigger_id,
      },
      () => ack(),
      (m) => respond({ response_type: "ephemeral", ...m }).then(() => {}),
    );
  });

  bolt.action<BlockAction<ButtonAction>>(
    /^gate_(approve|reject)$/,
    async ({ ack, body, action }) => {
      await app.onButton({
        actionId: action.action_id,
        value: action.value ?? "",
        // The person who clicked, as Slack reports it. Their own token is used.
        teamId: body.user.team_id ?? body.team?.id ?? "",
        userId: body.user.id,
        channelId: body.channel?.id ?? body.user.id,
        actionTs: action.action_ts,
      }, () => ack());
    },
  );

  // The consent button opens a URL; Slack still sends a click, which needs an ack.
  bolt.action("consent_link", async ({ ack }) => await ack());

  bolt.view("run_form", async ({ ack, body, view }) => {
    await app.onSubmission({
      viewId: view.id,
      teamId: body.user.team_id ?? body.team?.id ?? "",
      userId: body.user.id,
      privateMetadata: view.private_metadata,
      values: view.state.values,
    }, (response) => (ack as (r?: unknown) => Promise<void>)(response));
  });

  await app.resume();
  setInterval(() => void app.tick(), 1_000);
  await bolt.start();
  log("started", {
    team: who.team_id,
    commands: commands.commands.map((c) => c.command).join(" "),
  });
}

main().catch((error) => {
  // A setup problem says what to fix. For anything else print only its name:
  // an unexpected error's message isn't known to be free of secrets.
  const safe = error instanceof SetupError
    ? error.message
    : (error as Error)?.name ?? "unknown error";
  console.error(`slackwater: ${safe}`);
  Deno.exit(1);
});
