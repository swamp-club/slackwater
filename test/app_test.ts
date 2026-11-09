import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type SlackApi, Slackwater } from "../src/app.ts";
import { parseCommands } from "../src/commands.ts";
import type { Message } from "../src/messages.ts";
import { Secret, ServeClient } from "../src/serve/client.ts";
import { type LinkRecord, MemoryStore } from "../src/store.ts";
import { TokenKeeper } from "../src/tokens.ts";
import {
  ACCESS_TOKEN,
  ACCESS_TOKEN_2,
  actionOk,
  ALL_SECRETS,
  CONSENT_URL,
  CREDENTIAL,
  failure,
  MockServe,
  REDEEM_SECRET,
  REFRESH_TOKEN,
} from "./mock_serve.ts";

const TEAM = "T0001";
const PAT = { teamId: TEAM, userId: "U0001" };
const NOW = Date.parse("2026-11-09T20:00:00.000Z");

const COMMANDS = parseCommands(`
ceiling:
  - actions: [run, read, approve]
    resource: "workflow:scale-web"
commands:
  - command: /scale-web
    workflow: scale-web
    title: Scale the web tier
    description: Change how many web servers are running
    fields:
      - name: environment
        label: Environment
        type: select
        options: [staging, production]
      - name: count
        label: How many servers
        type: number
        min: 1
        max: 6
      - name: reason
        label: Why
        required: false
  - command: /quiet-thing
    workflow: quiet-thing
    description: Something only the starter should see
    report: dm
`);

interface Sent {
  kind: "post" | "update" | "ephemeral" | "respond" | "view";
  channel?: string;
  user?: string;
  message: Message | Record<string, unknown>;
}

class FakeSlack implements SlackApi {
  sent: Sent[] = [];
  failPostIn = new Set<string>();
  #ts = 0;
  postMessage(channel: string, message: Message) {
    if (this.failPostIn.has(channel)) return Promise.reject(new Error("not_in_channel"));
    this.sent.push({ kind: "post", channel, message });
    return Promise.resolve({
      channel: channel.startsWith("U") ? "D0001" : channel,
      ts: `${++this.#ts}`,
    });
  }
  update(channel: string, _ts: string, message: Message) {
    this.sent.push({ kind: "update", channel, message });
    return Promise.resolve();
  }
  postEphemeral(channel: string, user: string, message: Message) {
    this.sent.push({ kind: "ephemeral", channel, user, message });
    return Promise.resolve();
  }
  openView(_triggerId: string, view: Record<string, unknown>) {
    this.sent.push({ kind: "view", message: view });
    return Promise.resolve();
  }
  userInfo(_userId: string) {
    return Promise.resolve({ display: "Pat", email: "pat@example.com", isBot: false });
  }
  of(kind: Sent["kind"]) {
    return this.sent.filter((s) => s.kind === kind);
  }
  texts(kind?: Sent["kind"]) {
    return this.sent.filter((s) => !kind || s.kind === kind).map((s) => JSON.stringify(s.message));
  }
}

async function harness(
  fn: (h: {
    serve: MockServe;
    slack: FakeSlack;
    store: MemoryStore;
    app: Slackwater;
    logs: string[];
    clock: { now: number };
    respond: (m: Message) => Promise<void>;
    responses: Message[];
  }) => Promise<void>,
) {
  const serve = new MockServe();
  const slack = new FakeSlack();
  const store = new MemoryStore();
  const logs: string[] = [];
  const clock = { now: NOW };
  const client = new ServeClient({
    baseUrl: serve.url,
    credential: new Secret(CREDENTIAL),
    timeoutMs: 1_000,
  });
  const app = new Slackwater({
    slack,
    serve: client,
    store,
    tokens: new TokenKeeper(client, store, () => clock.now),
    commands: COMMANDS,
    teamId: TEAM,
    workspaceName: "Test workspace",
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    now: () => clock.now,
  });
  const responses: Message[] = [];
  const respond = (m: Message) => {
    responses.push(m);
    slack.sent.push({ kind: "respond", message: m });
    return Promise.resolve();
  };
  try {
    await fn({ serve, slack, store, app, logs, clock, respond, responses });
    // Every test ends with the leak check: no secret in anything said or logged,
    // except the consent URL in the ephemeral reply to the person linking.
    const everything = [...slack.texts(), ...logs];
    for (const secret of ALL_SECRETS) {
      const where = everything.filter((t) => t.includes(secret));
      if (secret === CONSENT_URL) {
        assert(
          where.every((t) => slack.texts("respond").includes(t)),
          "consent URL went somewhere other than the ephemeral reply",
        );
      } else {
        assertEquals(where, [], `a secret leaked`);
      }
    }
  } finally {
    await serve.close();
  }
}

const ack = () => Promise.resolve();
let triggers = 0;
const cmd = (command: string, text = "", who = PAT, channelId = "C0001") => ({
  command,
  text,
  teamId: who.teamId,
  userId: who.userId,
  channelId,
  triggerId: `trig-${++triggers}`,
});

function linkFor(who = PAT, expiresAt = "2026-11-09T21:00:00.000Z"): LinkRecord {
  return {
    ...who,
    delegationId: "dlg-1",
    accessToken: new Secret(ACCESS_TOKEN),
    accessTokenExpiresAt: expiresAt,
    refreshToken: new Secret(REFRESH_TOKEN),
    expiresAt: "2026-12-09T20:00:00.000Z",
    username: "pat",
    linkedAt: "2026-11-09T19:00:00.000Z",
  };
}

const gateRow = (suspendedAt = "2026-11-09T20:00:05.000Z") => ({
  workflowId: "wf-1",
  workflowName: "scale-web",
  runId: "run-1",
  stepName: "approve",
  suspendedAt,
  prompt: "Scale web from 2 to 4 servers?",
  inputs: {},
});

function gateClick(
  action: "gate_approve" | "gate_reject",
  suspendedAt = "2026-11-09T20:00:05.000Z",
  who = PAT,
) {
  return {
    actionId: action,
    value: JSON.stringify({ w: "wf-1", r: "run-1", s: "approve", t: suspendedAt }),
    teamId: who.teamId,
    userId: who.userId,
    channelId: "C0001",
    actionTs: `${Math.random()}`,
  };
}

// --- Linking -----------------------------------------------------------------

Deno.test("link: consent URL goes only to the person, then the poll stores tokens and says so", async () => {
  await harness(async ({ serve, slack, store, app, respond, responses, clock }) => {
    serve.on("/api/v1/delegations/links", {
      status: 201,
      body: {
        pendingId: "pend-1",
        redeemSecret: REDEEM_SECRET,
        consentUrl: CONSENT_URL,
        expiresIn: 900,
        interval: 5,
      },
    });
    const redeems = [
      { status: 202, body: { status: "pending", interval: 5 } },
      {
        status: 200,
        body: {
          status: "issued",
          delegationId: "dlg-1",
          accessToken: ACCESS_TOKEN,
          accessTokenExpiresAt: "2026-11-09T21:00:00.000Z",
          refreshToken: REFRESH_TOKEN,
          expiresAt: "2026-12-09T20:00:00.000Z",
          person: { username: "pat" },
        },
      },
    ];
    serve.on("/api/v1/delegations/redeem", () => redeems.shift()!);

    await app.onCommand(cmd("/slackwater", "link"), ack, respond);
    assertStringIncludes(JSON.stringify(responses[0]), CONSENT_URL);
    const sentLink = serve.callsTo("/api/v1/delegations/links")[0].body;
    assertEquals((sentLink.external as Record<string, unknown>).email, "pat@example.com");
    assertEquals(sentLink.ceiling, COMMANDS.ceiling);

    clock.now += 5_000;
    await app.tick();
    assertEquals(await store.getLink(PAT), undefined);
    clock.now += 5_000;
    await app.tick();
    assertEquals((await store.getLink(PAT))?.accessToken.reveal(), ACCESS_TOKEN);
    assertEquals(await store.getPending(PAT), undefined);
    assertStringIncludes(slack.texts("post").join(), "linked to swamp as *pat*");
  });
});

Deno.test("link: a refused link tells the person why", async () => {
  await harness(async ({ serve, slack, store, app, respond, clock }) => {
    serve.on("/api/v1/delegations/links", {
      status: 201,
      body: {
        pendingId: "pend-1",
        redeemSecret: REDEEM_SECRET,
        consentUrl: CONSENT_URL,
        expiresIn: 900,
        interval: 5,
      },
    });
    serve.on("/api/v1/delegations/redeem", {
      status: 200,
      body: { status: "refused", reason: "email_mismatch" },
    });
    await app.onCommand(cmd("/slackwater", "link"), ack, respond);
    clock.now += 5_000;
    await app.tick();
    assertEquals(await store.getPending(PAT), undefined);
    assertStringIncludes(slack.texts("post").join(), "doesn't match your swamp-club email");
  });
});

Deno.test("link: serve's refusal to start is explained without detail", async () => {
  await harness(async ({ serve, app, respond, responses }) => {
    serve.on("/api/v1/delegations/links", failure(400, "ceiling_too_wide"));
    await app.onCommand(cmd("/slackwater", "link"), ack, respond);
    assertStringIncludes(responses[0].text, "isn't set up correctly");
  });
});

Deno.test("unlink ends the link at serve and forgets the tokens", async () => {
  await harness(async ({ serve, store, app, respond, responses }) => {
    await store.putLink(linkFor());
    serve.on("/api/v1/delegations/end", { status: 200, body: { ended: true } });
    await app.onCommand(cmd("/slackwater", "unlink"), ack, respond);
    assertEquals(serve.callsTo("/api/v1/delegations/end")[0].body, { token: REFRESH_TOKEN });
    assertEquals(await store.getLink(PAT), undefined);
    assertStringIncludes(responses[0].text, "Unlinked");
  });
});

// --- Who may use it ------------------------------------------------------------

Deno.test("an unlinked person gets the not-linked reply, and serve is never called", async () => {
  await harness(async ({ serve, slack, app, respond, responses }) => {
    await app.onCommand(cmd("/scale-web"), ack, respond);
    await app.onCommand(cmd("/slackwater", "run scale-web count=3"), ack, respond);
    assertEquals(responses.map((r) => r.text), [
      "You haven't linked your swamp account yet. Run `/slackwater link` first.",
      "You haven't linked your swamp account yet. Run `/slackwater link` first.",
    ]);
    await app.onButton(gateClick("gate_approve"), ack);
    assertStringIncludes(slack.texts("ephemeral").join(), "haven't linked");
    assertEquals(serve.calls, []);
  });
});

Deno.test("someone from another workspace is refused", async () => {
  await harness(async ({ serve, store, app, respond, responses }) => {
    const stranger = { teamId: "T9999", userId: "U0001" };
    await store.putLink(linkFor(stranger));
    await app.onCommand(cmd("/slackwater", "run scale-web", stranger), ack, respond);
    assertStringIncludes(responses[0].text, "own Slack workspace");
    assertEquals(serve.calls, []);
  });
});

// --- Forms and runs --------------------------------------------------------------

Deno.test("a custom command opens its form; the submission runs the workflow as the person", async () => {
  await harness(async ({ serve, slack, store, app, respond, clock }) => {
    await store.putLink(linkFor());
    await app.onCommand(cmd("/scale-web"), ack, respond);
    const view = slack.of("view")[0].message as Record<string, unknown>;
    assertEquals(view.callback_id, "run_form");

    let ackedWith: unknown = "not acked";
    const values = {
      environment: { value: { selected_option: { value: "staging" } } },
      count: { value: { value: "9" } },
      reason: { value: { value: null } },
    };
    await app.onSubmission(
      {
        viewId: "V1",
        teamId: TEAM,
        userId: PAT.userId,
        privateMetadata: view.private_metadata as string,
        values,
      },
      (r) => {
        ackedWith = r;
        return Promise.resolve();
      },
    );
    assertEquals(ackedWith, { response_action: "errors", errors: { count: "At most 6" } });
    assertEquals(serve.calls, []);

    serve.on(
      "action:workflow.run",
      actionOk("workflow.run", { runId: "run-1", workflowName: "scale-web", replayed: false }),
    );
    values.count.value.value = "4";
    await app.onSubmission(
      {
        viewId: "V1",
        teamId: TEAM,
        userId: PAT.userId,
        privateMetadata: view.private_metadata as string,
        values,
      },
      ack,
    );
    const [run] = serve.callsTo("/api/v1/action");
    assertEquals(run.authorization, `Bearer ${ACCESS_TOKEN}`);
    assertEquals(run.body.payload, {
      workflowIdOrName: "scale-web",
      idempotencyKey: `slack.${TEAM}.V1`,
      inputs: { environment: "staging", count: 4 },
    });
    assertEquals(slack.of("post")[0].channel, "C0001");
    assertEquals((await store.listRuns()).length, 1);
    void clock;
  });
});

Deno.test("Slack resending a command starts one run, not two", async () => {
  await harness(async ({ serve, store, app, respond }) => {
    await store.putLink(linkFor());
    serve.on(
      "action:workflow.run",
      actionOk("workflow.run", { runId: "run-1", workflowName: "x", replayed: false }),
    );
    const c = cmd("/slackwater", "run x");
    await app.onCommand(c, ack, respond);
    await app.onCommand(c, ack, respond);
    assertEquals(serve.callsTo("/api/v1/action").length, 1);
  });
});

Deno.test("a retry that serve replays doesn't post a second message", async () => {
  await harness(async ({ serve, slack, store, app, respond }) => {
    await store.putLink(linkFor());
    serve.on(
      "action:workflow.run",
      actionOk("workflow.run", { runId: "run-1", workflowName: "x", replayed: true }),
    );
    await app.onCommand(cmd("/slackwater", "run x"), ack, respond);
    assertEquals(slack.of("post"), []);
  });
});

Deno.test("serve's refusal is reported in serve's terms", async () => {
  await harness(async ({ serve, store, app, respond, responses }) => {
    await store.putLink(linkFor());
    serve.on("action:workflow.run", failure(403, "forbidden"));
    await app.onCommand(cmd("/slackwater", "run not-in-ceiling"), ack, respond);
    assertEquals(responses[0].text, "swamp refused: you don't have permission to do that.");
  });
});

Deno.test("a run in a channel the app isn't in goes to the person's DMs", async () => {
  await harness(async ({ serve, slack, store, app, respond, responses }) => {
    await store.putLink(linkFor());
    slack.failPostIn.add("C0001");
    serve.on(
      "action:workflow.run",
      actionOk("workflow.run", { runId: "run-1", workflowName: "x", replayed: false }),
    );
    await app.onCommand(cmd("/slackwater", "run x"), ack, respond);
    assertEquals(slack.of("post")[0].channel, PAT.userId);
    assertStringIncludes(responses[0].text, "Invite me to the channel");
    assertEquals((await store.listRuns())[0].channel, "D0001");
  });
});

Deno.test("a dm command reports only to the starter", async () => {
  await harness(async ({ serve, slack, store, app, respond }) => {
    await store.putLink(linkFor());
    serve.on(
      "action:workflow.run",
      actionOk("workflow.run", { runId: "run-1", workflowName: "quiet-thing", replayed: false }),
    );
    await app.onCommand(cmd("/quiet-thing"), ack, respond);
    assertEquals(slack.of("post")[0].channel, PAT.userId);
  });
});

// --- Following a run and its gate ---------------------------------------------------

async function startedRun(
  h: {
    serve: MockServe;
    store: MemoryStore;
    app: Slackwater;
    respond: (m: Message) => Promise<void>;
  },
) {
  await h.store.putLink(linkFor());
  h.serve.on(
    "action:workflow.run",
    actionOk("workflow.run", { runId: "run-1", workflowName: "scale-web", replayed: false }),
  );
  await h.app.onCommand(cmd("/slackwater", "run scale-web"), ack, h.respond);
}

const runView = (status: string, gate: string) => ({
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "scale-web",
  status,
  jobs: [{
    name: "main",
    status,
    steps: [{ name: "plan", status: "succeeded" }, { name: "approve", status: gate }, {
      name: "apply",
      status: "pending",
    }],
  }],
});

Deno.test("following a run shows the gate's buttons, and updates only on change", async () => {
  await harness(async (h) => {
    await startedRun(h);
    h.serve.on(
      "action:workflow.history.get",
      actionOk("workflow.history.get", runView("suspended", "waiting_approval")),
    );
    h.serve.on(
      "action:workflow.approvals",
      actionOk("workflow.approvals", { approvals: [gateRow()], expired: [] }),
    );
    await h.app.tick();
    const updates = h.slack.of("update");
    assertEquals(updates.length, 1);
    const shown = JSON.stringify(updates[0].message);
    assertStringIncludes(shown, "gate_approve");
    assertStringIncludes(shown, "Scale web from 2 to 4 servers?");
    h.clock.now += 3_000;
    await h.app.tick();
    assertEquals(h.slack.of("update").length, 1, "nothing changed, so no update");

    h.serve.on(
      "action:workflow.history.get",
      actionOk("workflow.history.get", runView("succeeded", "succeeded")),
    );
    h.clock.now += 3_000;
    await h.app.tick();
    assertEquals(h.slack.of("update").length, 2);
    assertEquals(await h.store.listRuns(), []);
  });
});

Deno.test("approve decides the gate as the clicker, with the gate's suspendedAt", async () => {
  await harness(async (h) => {
    await h.store.putLink(linkFor());
    h.serve.on(
      "action:workflow.approve",
      actionOk("workflow.approve", {
        runId: "run-1",
        workflowName: "scale-web",
        stepName: "approve",
        approved: true,
        decidedBy: "pat",
        reason: "Approved in Slack",
      }),
    );
    await h.app.onButton(gateClick("gate_approve"), ack);
    const [call] = h.serve.callsTo("/api/v1/action");
    assertEquals(call.body, {
      type: "workflow.approve",
      payload: {
        workflowIdOrName: "wf-1",
        runId: "run-1",
        stepName: "approve",
        suspendedAt: "2026-11-09T20:00:05.000Z",
        reason: "Approved in Slack",
      },
    });
    assertStringIncludes(h.slack.texts("ephemeral").join(), "Approved *approve* as pat");
  });
});

Deno.test("a stale button and an already-decided gate are explained, not retried", async () => {
  await harness(async (h) => {
    await h.store.putLink(linkFor());
    h.serve.on("action:workflow.approve", failure(409, "gate_reopened"));
    await h.app.onButton(gateClick("gate_approve", "2026-11-09T19:00:00.000Z"), ack);
    h.serve.on("action:workflow.reject", failure(409, "already_decided"));
    await h.app.onButton(gateClick("gate_reject"), ack);
    const said = h.slack.texts("ephemeral").join();
    assertStringIncludes(said, "reopened since this message was posted");
    assertStringIncludes(said, "already decided");
    assertEquals(h.serve.callsTo("/api/v1/action").length, 2);
  });
});

Deno.test("a double click on a button decides once", async () => {
  await harness(async (h) => {
    await h.store.putLink(linkFor());
    h.serve.on("action:workflow.reject", failure(409, "already_decided"));
    const click = gateClick("gate_reject");
    await h.app.onButton(click, ack);
    await h.app.onButton(click, ack);
    assertEquals(h.serve.callsTo("/api/v1/action").length, 1);
  });
});

// --- Tokens ---------------------------------------------------------------------------

Deno.test("a token near its end is refreshed before use", async () => {
  await harness(async (h) => {
    await h.store.putLink(linkFor(PAT, "2026-11-09T20:03:00.000Z"));
    h.serve.on("/api/v1/delegations/refresh", {
      status: 200,
      body: {
        status: "refreshed",
        delegationId: "dlg-1",
        accessToken: ACCESS_TOKEN_2,
        accessTokenExpiresAt: "2026-11-09T21:00:00.000Z",
        expiresIn: 3600,
        person: {},
      },
    });
    h.serve.on(
      "action:workflow.run",
      actionOk("workflow.run", { runId: "run-1", workflowName: "x", replayed: false }),
    );
    await h.app.onCommand(cmd("/slackwater", "run x"), ack, h.respond);
    assertEquals(h.serve.callsTo("/api/v1/action")[0].authorization, `Bearer ${ACCESS_TOKEN_2}`);
    assertEquals((await h.store.getLink(PAT))?.refreshToken.reveal(), REFRESH_TOKEN);
  });
});

Deno.test("a refused refresh ends the link and tells the person to link again", async () => {
  await harness(async (h) => {
    await h.store.putLink(linkFor(PAT, "2026-11-09T20:03:00.000Z"));
    h.serve.on("/api/v1/delegations/refresh", failure(401, "invalid_grant", { reason: "ended" }));
    await h.app.onCommand(cmd("/slackwater", "run x"), ack, h.respond);
    assertStringIncludes(h.responses[0].text, "Your swamp link has ended");
    assertEquals(await h.store.getLink(PAT), undefined);
    assertEquals(h.serve.callsTo("/api/v1/action"), []);
  });
});

Deno.test("a not_admitted refusal keeps the link", async () => {
  await harness(async (h) => {
    await h.store.putLink(linkFor(PAT, "2026-11-09T20:03:00.000Z"));
    h.serve.on(
      "/api/v1/delegations/refresh",
      failure(401, "invalid_grant", { reason: "not_admitted" }),
    );
    await h.app.onCommand(cmd("/slackwater", "run x"), ack, h.respond);
    assertStringIncludes(h.responses[0].text, "isn't letting you in right now");
    assert(await h.store.getLink(PAT));
  });
});

Deno.test("serve saying unauthorized gets one refresh and one retry", async () => {
  await harness(async (h) => {
    await h.store.putLink(linkFor());
    h.serve.on("/api/v1/delegations/refresh", {
      status: 200,
      body: {
        status: "refreshed",
        delegationId: "dlg-1",
        accessToken: ACCESS_TOKEN_2,
        accessTokenExpiresAt: "2026-11-09T21:00:00.000Z",
        expiresIn: 3600,
        person: {},
      },
    });
    h.serve.on(
      "action:workflow.run",
      (call) =>
        call.authorization === `Bearer ${ACCESS_TOKEN}`
          ? failure(401, "unauthorized")
          : actionOk("workflow.run", { runId: "run-1", workflowName: "x", replayed: false }),
    );
    await h.app.onCommand(cmd("/slackwater", "run x"), ack, h.respond);
    const runs = h.serve.callsTo("/api/v1/action");
    assertEquals(runs.length, 2);
    assertEquals(runs[0].body.payload, runs[1].body.payload, "same idempotency key on the retry");
  });
});

Deno.test("serve not answering is reported plainly", async () => {
  await harness(async (h) => {
    await h.store.putLink(linkFor());
    h.serve.on("action:workflow.run", { ...failure(500, "x"), delayMs: 3_000 });
    await h.app.onCommand(cmd("/slackwater", "run x"), ack, h.respond);
    assertEquals(h.responses[0].text, "swamp didn't answer. Try again in a moment.");
  });
});
