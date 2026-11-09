/**
 * The action route against a real swamp serve, with demo/swamp's fake
 * scale-web workflow. Skipped unless pointed at a serve:
 *
 *   SLACKWATER_LIVE_SERVE_URL=http://127.0.0.1:9191 \
 *   SLACKWATER_LIVE_TOKEN_FILE=path/to/token \
 *   deno task test test/live_serve_test.ts
 *
 * The token is any bearer token serve accepts on the action route for a person
 * with run, read and approve on workflow:scale-web: a delegated access token,
 * or in token mode a server access token from `swamp access token mint`.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Secret, ServeClient, ServeError } from "../src/serve/client.ts";

const url = Deno.env.get("SLACKWATER_LIVE_SERVE_URL");
const tokenFile = Deno.env.get("SLACKWATER_LIVE_TOKEN_FILE");
const ignore = !url || !tokenFile;

async function setup() {
  const token = new Secret((await Deno.readTextFile(tokenFile!)).trim());
  const serve = new ServeClient({
    baseUrl: url!,
    credential: new Secret("swi1.unused.0"),
    timeoutMs: 30_000,
  });
  return { serve, token };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`gave up waiting for ${what}`);
}

Deno.test({
  name: "live: run, find the gate, refuse a stale decision, approve, finish",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { serve, token } = await setup();
    const key = `slack.live.${crypto.randomUUID()}`;
    const started = await serve.runWorkflow(token, {
      workflowIdOrName: "scale-web",
      idempotencyKey: key,
      inputs: { count: 3, reason: "live test" },
    });
    assertEquals(started.replayed, false);

    // The same key again is the same run.
    const again = await serve.runWorkflow(token, {
      workflowIdOrName: "scale-web",
      idempotencyKey: key,
      inputs: { count: 3, reason: "live test" },
    });
    assertEquals(again, { ...started, replayed: true });

    const gate = await waitFor("the gate", async () => {
      const rows = await serve.listApprovals(token);
      return rows.find((r) => r.runId === started.runId);
    });
    assertEquals(gate.stepName, "approve");
    assert(gate.suspendedAt, "approvals rows carry suspendedAt");
    const view = await serve.getRun(token, started.runId);
    const steps = Object.fromEntries(view.jobs[0].steps.map((s) => [s.name, s.status]));
    console.log("status at the gate:", view.status, JSON.stringify(steps));

    const decision = {
      workflowIdOrName: gate.workflowId,
      runId: gate.runId,
      stepName: gate.stepName,
    };
    const stale = await assertRejects(
      () => serve.approve(token, { ...decision, suspendedAt: "2020-01-01T00:00:00.000Z" }),
      ServeError,
    );
    console.log("stale decision:", stale.status, stale.code);

    const recorded = await serve.approve(token, { ...decision, suspendedAt: gate.suspendedAt! });
    console.log("approved, decidedBy:", recorded.decidedBy);

    const twice = await assertRejects(
      () => serve.approve(token, { ...decision, suspendedAt: gate.suspendedAt! }),
      ServeError,
    );
    console.log("second decision:", twice.status, twice.code);

    const done = await waitFor("the run to finish", async () => {
      const v = await serve.getRun(token, started.runId);
      return ["succeeded", "completed", "failed", "cancelled"].includes(v.status) ? v : undefined;
    });
    console.log("finished:", done.status);
    assert(["succeeded", "completed"].includes(done.status), done.status);
  },
});

Deno.test({
  name: "live: a workflow outside the person's grants is refused",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { serve, token } = await setup();
    const error = await assertRejects(
      () =>
        serve.runWorkflow(token, {
          workflowIdOrName: "not-granted",
          idempotencyKey: `slack.live.${crypto.randomUUID()}`,
        }),
      ServeError,
    );
    console.log("outside grants:", error.status, error.code);
    assert(["forbidden", "not_found"].includes(error.code), error.code);
  },
});
