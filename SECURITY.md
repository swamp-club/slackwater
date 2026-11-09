# Security policy

Slackwater is swamp's reference Slack app. Report security problems in it the same way as for swamp
itself.

## Reporting a vulnerability

If the problem involves **secret or credential exposure, acting as someone else, data exfiltration,
or anything where public disclosure could put people at risk**, email
[security@swamp-club.com](mailto:security@swamp-club.com). Don't open a public issue.

For other bugs, file an issue in the [swamp Lab](https://swamp-club.com/lab).

Please include:

- a short description of the problem
- what an attacker could do with it
- steps to reproduce
- the Slackwater commit and swamp version you used

We acknowledge reports within 72 hours.

## Examples of what to report privately

- A token, credential or consent URL that appears in a log, a Slack message or error text
- A way for one Slack user to act as another, or to decide a gate as someone else
- A way to get past serve's refusal through the app
