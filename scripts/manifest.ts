/**
 * Builds the Slack app manifest from a commands file.
 *
 *   deno task manifest [commands.yaml] > manifest.json
 *
 * Paste the result into https://api.slack.com/apps → Create New App → From a
 * manifest. Run it again, and paste it into the app's Manifest page, whenever
 * the commands file changes: Slack only delivers commands the manifest lists.
 */

import { type CommandsFile, loadCommands } from "../src/commands.ts";

export function buildManifest(file: CommandsFile, name = "Swamp") {
  return {
    display_information: {
      name,
      description: "Run swamp workflows as yourself, and approve their gates.",
      background_color: "#2f4f3a",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: true,
      },
      bot_user: { display_name: name.toLowerCase(), always_online: true },
      slash_commands: [
        {
          command: file.appCommand,
          description: "Link your swamp account, or run a workflow",
          usage_hint: "link | status | run <workflow> [name=value …] | unlink",
          should_escape: false,
        },
        ...file.commands.map((c) => ({
          command: c.command,
          description: c.description.slice(0, 100),
          ...(c.usageHint ? { usage_hint: c.usageHint } : {}),
          should_escape: false,
        })),
      ],
    },
    oauth_config: {
      scopes: {
        // commands: receive slash commands. chat:write: post and update run
        // messages. users:read and users:read.email: the person's name and
        // email, which serve checks against their swamp-club account.
        bot: ["commands", "chat:write", "users:read", "users:read.email"],
      },
    },
    settings: {
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

if (import.meta.main) {
  const path = Deno.args[0] ?? Deno.env.get("SLACKWATER_COMMANDS") ?? "./commands.yaml";
  console.log(JSON.stringify(buildManifest(await loadCommands(path)), null, 2));
}
