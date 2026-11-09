# Slackwater

Slackwater is swamp's reference Slack app. It links a Slack user to their swamp account and then
runs and approves workflows for them through serve's HTTP routes. Serve decides what each person may
do, and records who did it.

This repository is being set up. The app, its setup guide and its tests arrive in the first pull
request.

## Working in this repository

- [Deno](https://deno.com) 2.x.
- `deno task ci` runs formatting, lint, type checks and tests, as CI does.
- Scan for secrets before every push. `deno task hooks` installs a pre-push hook that runs
  `deno task secrets`, which needs [gitleaks](https://github.com/gitleaks/gitleaks) on your `PATH`.
  CI runs the same scan.
- Configuration comes from the environment. Only `.env.example` is committed.

See [SECURITY.md](SECURITY.md) to report a security problem.
