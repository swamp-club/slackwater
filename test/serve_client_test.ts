import { assert, assertEquals, assertRejects } from "@std/assert";
import { Secret, ServeClient, ServeError } from "../src/serve/client.ts";
import {
  ACCESS_TOKEN,
  actionOk,
  ALL_SECRETS,
  CONSENT_URL,
  CREDENTIAL,
  failure,
  MockServe,
  REDEEM_SECRET,
  REFRESH_TOKEN,
} from "./mock_serve.ts";

const EXTERNAL = {
  platform: "slack" as const,
  teamId: "T0001",
  userId: "U0001",
  display: "Pat",
  workspace: "Test workspace",
  email: "pat@example.com",
};
const CEILING = {
  version: 1 as const,
  ceiling: [{
    actions: ["run" as const, "read" as const, "approve" as const],
    resource: "workflow:*",
  }],
};

async function withServe(
  fn: (serve: MockServe, client: ServeClient) => Promise<void>,
  timeoutMs = 2_000,
) {
  const serve = new MockServe();
  const client = new ServeClient({
    baseUrl: serve.url + "/",
    credential: new Secret(CREDENTIAL),
    timeoutMs,
  });
  try {
    await fn(serve, client);
  } finally {
    await serve.close();
  }
}

function assertNoSecrets(text: string) {
  for (const secret of ALL_SECRETS) assert(!text.includes(secret), `leaked a secret in: ${text}`);
}

Deno.test("startLink sends the person in serve's field names, with the integration credential", async () => {
  await withServe(async (serve, client) => {
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
    const started = await client.startLink(EXTERNAL, CEILING);
    const [call] = serve.callsTo("/api/v1/delegations/links");
    assertEquals(call.authorization, `Bearer ${CREDENTIAL}`);
    assertEquals(call.body, {
      external: {
        platform: "slack",
        team_id: "T0001",
        user_id: "U0001",
        display: "Pat",
        workspace: "Test workspace",
        email: "pat@example.com",
      },
      ceiling: CEILING,
    });
    assertEquals(started.pendingId, "pend-1");
    assertEquals(started.consentUrl.reveal(), CONSENT_URL);
    assertEquals(started.redeemSecret.reveal(), REDEEM_SECRET);
    assertNoSecrets(JSON.stringify(started) + String(started.consentUrl) + Deno.inspect(started));
  });
});

Deno.test("startLink surfaces serve's refusal codes", async () => {
  await withServe(async (serve, client) => {
    serve.on("/api/v1/delegations/links", failure(400, "email_required"));
    const error = await assertRejects(() => client.startLink(EXTERNAL, CEILING), ServeError);
    assertEquals(error.code, "email_required");
    assertEquals(error.status, 400);
  });
});

Deno.test("redeem reads each outcome", async () => {
  await withServe(async (serve, client) => {
    const replies = [
      { status: 202, body: { status: "pending", interval: 5 } },
      { status: 200, body: { status: "refused", reason: "email_mismatch" } },
      { status: 200, body: { status: "ended", cause: "consent_timeout" } },
      {
        status: 200,
        body: {
          status: "issued",
          delegationId: "dlg-1",
          accessToken: ACCESS_TOKEN,
          accessTokenExpiresAt: "2026-11-09T21:00:00.000Z",
          refreshToken: REFRESH_TOKEN,
          expiresAt: "2026-12-09T20:00:00.000Z",
          person: { username: "pat", email: "pat@example.com" },
        },
      },
    ];
    serve.on("/api/v1/delegations/redeem", () => replies.shift()!);
    const secret = new Secret(REDEEM_SECRET);
    assertEquals(await client.redeem("pend-1", secret), { status: "pending", interval: 5 });
    assertEquals(await client.redeem("pend-1", secret), {
      status: "refused",
      reason: "email_mismatch",
    });
    assertEquals(await client.redeem("pend-1", secret), {
      status: "ended",
      cause: "consent_timeout",
    });
    const issued = await client.redeem("pend-1", secret);
    assert(issued.status === "issued");
    assertEquals(issued.tokens.accessToken.reveal(), ACCESS_TOKEN);
    assertEquals(issued.tokens.refreshToken.reveal(), REFRESH_TOKEN);
    assertEquals(issued.person.username, "pat");
    assertNoSecrets(JSON.stringify(issued) + Deno.inspect(issued));
    assertEquals(serve.callsTo("/api/v1/delegations/redeem")[0].body, {
      pendingId: "pend-1",
      redeemSecret: REDEEM_SECRET,
    });
  });
});

Deno.test("a second redeem after tokens were issued is already_redeemed", async () => {
  await withServe(async (serve, client) => {
    serve.on("/api/v1/delegations/redeem", failure(409, "already_redeemed"));
    const error = await assertRejects(
      () => client.redeem("pend-1", new Secret(REDEEM_SECRET)),
      ServeError,
    );
    assertEquals(error.code, "already_redeemed");
  });
});

Deno.test("refresh returns a new access token and keeps the refresh token", async () => {
  await withServe(async (serve, client) => {
    serve.on("/api/v1/delegations/refresh", {
      status: 200,
      body: {
        status: "refreshed",
        delegationId: "dlg-1",
        accessToken: ACCESS_TOKEN,
        accessTokenExpiresAt: "2026-11-09T22:00:00.000Z",
        expiresIn: 3600,
        expiresAt: "2026-12-09T20:00:00.000Z",
        person: {},
      },
    });
    const outcome = await client.refresh(new Secret(REFRESH_TOKEN));
    assert(outcome.status === "refreshed");
    assertEquals(outcome.accessToken.reveal(), ACCESS_TOKEN);
    assertEquals(serve.callsTo("/api/v1/delegations/refresh")[0].body, {
      refreshToken: REFRESH_TOKEN,
    });
  });
});

Deno.test("a refused refresh is returned with its reason, not thrown", async () => {
  await withServe(async (serve, client) => {
    serve.on("/api/v1/delegations/refresh", failure(401, "invalid_grant", { reason: "ended" }));
    assertEquals(await client.refresh(new Secret(REFRESH_TOKEN)), {
      status: "refused",
      reason: "ended",
    });
  });
});

Deno.test("a refresh that serve can't do yet throws, so the caller keeps the tokens", async () => {
  await withServe(async (serve, client) => {
    serve.on("/api/v1/delegations/refresh", failure(503, "team_not_ready", {}));
    const error = await assertRejects(() => client.refresh(new Secret(REFRESH_TOKEN)), ServeError);
    assertEquals(error.code, "team_not_ready");
  });
});

Deno.test("end treats an unknown token as already ended", async () => {
  await withServe(async (serve, client) => {
    serve.on("/api/v1/delegations/end", failure(401, "invalid_grant"));
    await client.end(new Secret(REFRESH_TOKEN));
    assertEquals(serve.callsTo("/api/v1/delegations/end")[0].body, { token: REFRESH_TOKEN });
  });
});

Deno.test("runWorkflow posts an action with the person's token", async () => {
  await withServe(async (serve, client) => {
    serve.on("action:workflow.run", {
      ...actionOk("workflow.run", { runId: "run-1", workflowName: "scale-web", replayed: false }),
      status: 202,
    });
    const started = await client.runWorkflow(new Secret(ACCESS_TOKEN), {
      workflowIdOrName: "scale-web",
      idempotencyKey: "slack.T0001.trig-1",
      inputs: { count: 3 },
    });
    assertEquals(started, { runId: "run-1", workflowName: "scale-web", replayed: false });
    const [call] = serve.callsTo("/api/v1/action");
    assertEquals(call.authorization, `Bearer ${ACCESS_TOKEN}`);
    assertEquals(call.body, {
      type: "workflow.run",
      payload: {
        workflowIdOrName: "scale-web",
        idempotencyKey: "slack.T0001.trig-1",
        inputs: { count: 3 },
      },
    });
  });
});

Deno.test("listApprovals returns the rows, and approve sends suspendedAt back", async () => {
  await withServe(async (serve, client) => {
    const row = {
      workflowId: "wf-1",
      workflowName: "scale-web",
      runId: "run-1",
      stepName: "approve",
      suspendedAt: "2026-11-09T20:00:00.000Z",
      prompt: "Scale web to 3?",
      inputs: {},
    };
    serve.on(
      "action:workflow.approvals",
      actionOk("workflow.approvals", { approvals: [row], expired: [] }),
    );
    serve.on(
      "action:workflow.approve",
      actionOk("workflow.approve", {
        runId: "run-1",
        workflowName: "scale-web",
        stepName: "approve",
        approved: true,
        decidedBy: "pat",
        reason: null,
      }),
    );
    const token = new Secret(ACCESS_TOKEN);
    assertEquals(await client.listApprovals(token), [row]);
    const recorded = await client.approve(token, {
      workflowIdOrName: "wf-1",
      runId: "run-1",
      stepName: "approve",
      suspendedAt: row.suspendedAt,
    });
    assertEquals(recorded.decidedBy, "pat");
    assertEquals(serve.callsTo("/api/v1/action")[1].body.payload, {
      workflowIdOrName: "wf-1",
      runId: "run-1",
      stepName: "approve",
      suspendedAt: row.suspendedAt,
    });
  });
});

Deno.test("gate refusals and permission refusals come back as codes", async () => {
  await withServe(async (serve, client) => {
    const decision = {
      workflowIdOrName: "wf-1",
      runId: "run-1",
      stepName: "approve",
      suspendedAt: "t",
    };
    for (
      const [status, code] of [[409, "already_decided"], [409, "gate_reopened"], [
        403,
        "forbidden",
      ]] as const
    ) {
      serve.on("action:workflow.reject", failure(status, code));
      const error = await assertRejects(
        () => client.reject(new Secret(ACCESS_TOKEN), decision),
        ServeError,
      );
      assertEquals(error.code, code);
      assertEquals(error.status, status);
    }
  });
});

Deno.test("rate limits carry Retry-After", async () => {
  await withServe(async (serve, client) => {
    serve.on("action:workflow.history.get", {
      ...failure(429, "rate_limited"),
      headers: { "retry-after": "7" },
    });
    const error = await assertRejects(
      () => client.getRun(new Secret(ACCESS_TOKEN), "run-1"),
      ServeError,
    );
    assertEquals(error.retryAfterSeconds, 7);
  });
});

Deno.test("every call times out", async () => {
  await withServe(async (serve, client) => {
    serve.on("action:workflow.history.get", {
      ...actionOk("workflow.history.get", {}),
      delayMs: 1_000,
    });
    const error = await assertRejects(
      () => client.getRun(new Secret(ACCESS_TOKEN), "run-1"),
      ServeError,
    );
    assertEquals(error.code, "timeout");
  }, 100);
});

Deno.test("an unreachable serve and a reply that isn't JSON are reported without detail", async () => {
  const client = new ServeClient({
    baseUrl: "http://127.0.0.1:1",
    credential: new Secret(CREDENTIAL),
    timeoutMs: 1_000,
  });
  const error = await assertRejects(() => client.refresh(new Secret(REFRESH_TOKEN)), ServeError);
  assertEquals(error.code, "unreachable");

  await withServe(async (serve, client) => {
    serve.on("/api/v1/delegations/refresh", { status: 502, raw: `<html>${REFRESH_TOKEN}</html>` });
    const error = await assertRejects(() => client.refresh(new Secret(REFRESH_TOKEN)), ServeError);
    assertEquals(error.code, "bad_reply");
    assertNoSecrets(error.message + String(error.stack) + Deno.inspect(error));
  });
});

Deno.test("errors never carry the request's secrets", async () => {
  await withServe(async (serve, client) => {
    serve.on("/api/v1/delegations/redeem", failure(400, "invalid_request"));
    const error = await assertRejects(
      () => client.redeem("pend-1", new Secret(REDEEM_SECRET)),
      ServeError,
    );
    assertNoSecrets(
      error.message + String(error.stack) + Deno.inspect(error) + JSON.stringify(error),
    );
  });
});
