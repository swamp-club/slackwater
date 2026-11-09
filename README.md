# Slackwater

Slackwater is swamp's reference Slack app. A person links their Slack account to their swamp account
once. After that, Slack commands run swamp workflows **as that person**, and the Approve and Reject
buttons decide approval gates **as whoever clicks**. Serve checks each request against that person's
grants and records them as the actor, so permissions and the audit trail stay in swamp.

It talks to serve only over serve's HTTP routes for integrations. The whole protocol is in one
module, [`src/serve/client.ts`](src/serve/client.ts), written to be read: copy it, or read it to
build the same thing in another language.

## What people see

- `/swamp link` replies, visible only to the person, with a button to sign in to swamp-club and
  agree to what the app may do for them. When they agree, the app messages them who they're linked
  as.
- A command from the commands file, such as `/scale-web`, opens a form. Submitting it starts the
  workflow as that person and posts a message that follows the run step by step.
- When the run reaches an approval gate, the message shows the gate's question with **Approve** and
  **Reject**. A click decides as the person who clicked. If serve refuses them, they're told why,
  only they can see it, and nothing is recorded.
- `/swamp run <workflow> name=value …` runs any workflow without a form. `/swamp status` shows who
  you're linked as, and `/swamp unlink` ends the link.

## How it works

```
Slack ──Socket Mode──▶ Slackwater ──HTTPS──▶ swamp serve ──▶ swamp-club (sign-in, consent)
                          │
                          └─ store: each person's tokens, encrypted
```

1. **Linking.** The app calls `POST /api/v1/delegations/links` with its integration credential, the
   person's Slack identity and the ceiling, which is the most the link may ever do. Serve gives back
   a consent URL, which the app shows only to that person. The app polls `/redeem` until they agree,
   and then serve hands over an access token (good for one hour) and a refresh token (good for the
   life of the link, 30 days).
2. **Acting.** Each run, status check and decision is a `POST /api/v1/action` carrying that person's
   access token. Serve applies their own grants, cut down to the ceiling. The app never decides who
   may do what.
3. **Staying linked.** The app refreshes the access token before it expires. If serve refuses a
   refresh, the link is over and the person is asked to link again.

Details worth knowing before you change anything:

- Every serve call has a timeout. Starting a run carries an idempotency key made from Slack's
  trigger or form id, so a retry returns the same run instead of starting another.
- A decision sends back the gate's `suspendedAt`, which comes from `workflow.approvals`. So a click
  on an old message can't decide a gate that has since reopened (`gate_reopened`), and a second
  click gets `already_decided`.
- Slack must hear back within 3 seconds. Every handler acknowledges first and does the slow part
  afterwards.
- Only people in the workspace the app is installed in are served. People from other workspaces, for
  example in Slack Connect channels, are refused.

## Setting it up

You need [Deno](https://deno.com) 2.x, a swamp serve that people sign in to through swamp-club
(OAuth mode), and a Slack workspace where you can create apps.

### 1. Serve

Serve must run in OAuth mode and admit the people who will link:

```sh
swamp serve --auth-mode oauth --allowed-collectives <your-collective> --admins <you> ...
```

swamp-club must have links turned on for your collective. Then register the app as an integration on
the serve's repository:

```sh
swamp access integration register slackwater --name "Slackwater" \
  --ceiling 'run,read,approve=workflow:scale-web' \
  --require-email-match
```

- `--ceiling` is the most any link may ask for. List each workflow the commands file uses. `read`
  lets the app follow runs and find their gates.
- `--require-email-match` makes swamp-club refuse a link unless the person's Slack email matches
  their swamp-club email. Leave it on unless you have a reason not to.
- The command prints the integration credential (`swi1.…`) **once**. Put it straight into `.env`
  (step 3).

People still need their own grants on serve: run, read and approve on the workflows they'll use. The
ceiling only limits what the app may do; it never adds to what a person may do.

### 2. The Slack app

1. Copy `demo/commands.yaml` to `commands.yaml` and edit it for your workflows (see
   [Commands](#commands)). Then build the manifest:
   ```sh
   deno task manifest commands.yaml > manifest.json
   ```
   For the demo as it stands, `demo/manifest.json` is already built.
2. Go to <https://api.slack.com/apps>, choose **Create New App → From a manifest**, pick the
   workspace and paste `manifest.json`.
3. Under **Basic Information → App-Level Tokens**, choose **Generate Token and Scopes**, name it
   (for example `socket`), add the scope `connections:write` and generate. This is the `xapp-…`
   token.
4. Under **Install App**, install it to the workspace. This gives the **Bot User OAuth Token**,
   `xoxb-…`.
5. Invite the app to any channel where runs should be posted: `/invite @Swamp`.

When the commands file changes, rebuild the manifest and paste it into the app's **App Manifest**
page. Slack only delivers commands that the manifest lists.

The app asks Slack for `commands`, `chat:write`, `users:read` and `users:read.email` (the email is
what serve matches against swamp-club). It uses Socket Mode, so it needs no public URL and no
signing secret.

### 3. Configuration

```sh
cp .env.example .env
chmod 600 .env
```

Fill it in. Every setting is described in [`.env.example`](.env.example). Generate the store key
with `openssl rand -base64 32` and keep it: without it the store can't be read and everyone has to
link again.

`.env` is ignored by git. Never commit it, and never paste its values into Slack, an issue or a
chat.

### 4. Run it

```sh
deno task start
```

It logs one JSON line per event: event names, ids and serve's error codes, never tokens or URLs.
Check it works with `/swamp link` in Slack.

## Commands

`commands.yaml` lists the slash commands, the workflow each one runs and the form that collects its
inputs:

```yaml
ceiling: # what a person agrees the app may do for them; must fit the integration's ceiling
  - actions: [run, read, approve]
    resource: "workflow:scale-web"
commands:
  - command: /scale-web
    workflow: scale-web
    title: Scale the web tier # the form's title, at most 24 characters
    description: Change how many web servers are running
    report: channel # or dm: the run goes only to the person's DMs with the app
    fields:
      - name: count # the workflow input this fills
        label: How many web servers
        type: number # text, number or select
        min: 0
        max: 4
      - name: reason
        label: Why
        type: text
        required: false
```

The fields are declared here because serve's HTTP routes don't describe a workflow's inputs. Keep
them in step with the workflow. If they disagree, serve refuses the run and the person is told.

## The demo

`demo/` holds a worked example: the `/scale-web` command and a swamp repository,
[`demo/swamp`](demo/swamp), with the `scale-web` workflow it runs. The workflow plans a change in
the number of web servers, waits at an approval gate, then applies it. For now it **fakes AWS** and
keeps the server count in a local file, so the Slack side can be tried with no cloud account.

To try it, serve `demo/swamp` with the setup above and give yourself the grant:

```sh
swamp access grant create --subject <you> --allow run,read,approve --on workflow:scale-web
```

The workflow sets `autoResume: true`, so serve carries on by itself once the gate is approved.

## Working on Slackwater

- `deno task ci` runs formatting, lint, type checks and tests, as CI does. The tests use a mock
  serve and a fake Slack. They cover each serve outcome, and every handler test ends by checking
  that no token or credential reached Slack or the log.
- `test/live_serve_test.ts` runs the action route against a real serve. It is skipped unless
  `SLACKWATER_LIVE_SERVE_URL` and `SLACKWATER_LIVE_TOKEN_FILE` are set; see the file.
- Scan for secrets before every push. `deno task hooks` installs a pre-push hook that runs
  `deno task secrets`, which needs [gitleaks](https://github.com/gitleaks/gitleaks). CI runs the
  same scan.
- The store is one encrypted file, which suits a single copy of the app. To run several copies,
  implement the `Store` interface in [`src/store.ts`](src/store.ts) on something shared.

## Layout

| Path                  | What it is                                                     |
| --------------------- | -------------------------------------------------------------- |
| `src/serve/client.ts` | Every serve call, with its request and reply types             |
| `src/serve/secret.ts` | `Secret`, which keeps tokens out of logs, messages and errors  |
| `src/app.ts`          | What the app does for each command, form and click             |
| `src/messages.ts`     | Everything the app says in Slack, and the forms                |
| `src/tokens.ts`       | Refreshing access tokens                                       |
| `src/store.ts`        | The `Store` interface and the encrypted file store             |
| `src/commands.ts`     | Reading `commands.yaml`                                        |
| `src/main.ts`         | Connecting to Slack with Bolt                                  |
| `scripts/manifest.ts` | Building the Slack manifest from `commands.yaml`               |
| `demo/`               | The scale-the-web-tier commands, manifest and swamp repository |

See [SECURITY.md](SECURITY.md) to report a security problem.
