/**
 * The whole of Slackwater's conversation with swamp serve, in one module.
 *
 * Read this file as documentation of serve's protocol for integrations. Every
 * request and reply the app relies on is typed here, and nothing else in the
 * app makes HTTP calls to serve.
 *
 * Serve has two kinds of route for an integration:
 *
 * 1. **Delegation routes**, under `/api/v1/delegations/`. The app calls these
 *    with its own integration credential (`swi1.…`), which an operator printed
 *    once with `swamp access integration register`. They link a person, hand
 *    over that person's tokens, refresh them and end the link.
 *
 * 2. **The action route**, `POST /api/v1/action`. The app calls this with one
 *    person's access token (`swda1.…`), so serve acts as that person: it checks
 *    their grants, the ceiling they agreed to, and records them as the actor in
 *    the audit trail. The app never decides what a person may do.
 *
 * All requests are `POST` with a JSON body and `Authorization: Bearer …`.
 * Errors come back as `{ code, message }` (plus `reason` on a refused refresh).
 * Every call has a timeout, and this module never retries on its own: whether
 * a call is safe to send twice is noted on each method, and the caller decides.
 */

import { Secret } from "./secret.ts";

export { Secret };

export const DELEGATIONS_PATH = "/api/v1/delegations";
export const ACTION_PATH = "/api/v1/action";

const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Wire types: delegation routes
// ---------------------------------------------------------------------------

/** Who the person is on the chat platform. Serve shows this on the consent page. */
export interface ExternalIdentity {
  platform: "slack";
  /** the Slack workspace id, `T…` */
  teamId: string;
  /** the Slack user id, `U…` */
  userId: string;
  /** the person's name as Slack shows it */
  display: string;
  /** the workspace's name */
  workspace: string;
  /**
   * The person's Slack email. Serve requires it when the integration was
   * registered with `--require-email-match`, and refuses the link unless it
   * matches the swamp-club account that consents.
   */
  email?: string;
}

/**
 * The most a link may ever do, which the person sees and agrees to. Serve
 * refuses a ceiling wider than the one the integration was registered with
 * (`ceiling_too_wide`). The person's own grants still apply under it.
 */
export interface Ceiling {
  version: 1;
  ceiling: { actions: Array<"run" | "read" | "approve" | "signal">; resource: string }[];
}

/** What `/links` gives back. `consentUrl` goes only to the person. */
export interface LinkStarted {
  pendingId: string;
  /** proves this app started the link. Kept until redeem succeeds. */
  redeemSecret: Secret;
  /** the page where the person signs in to swamp-club and agrees */
  consentUrl: Secret;
  /** seconds until the link stops waiting for consent */
  expiresIn: number;
  /** seconds to wait between redeem polls */
  interval: number;
}

/** Who consented, as swamp-club knows them. */
export interface LinkedPerson {
  username?: string;
  email?: string;
}

export interface Tokens {
  delegationId: string;
  /** acts as the person on the action route. Lives one hour. */
  accessToken: Secret;
  /** serve's clock */
  accessTokenExpiresAt: string;
  /** gets a new access token. Doesn't change on refresh. */
  refreshToken: Secret;
  /** the link ends here, 30 days after consent, whatever happens */
  expiresAt?: string;
}

export type RedeemOutcome =
  /** the person hasn't answered yet: ask again after `interval` seconds */
  | { status: "pending"; interval: number }
  /** the person agreed. Serve hands tokens over exactly once. */
  | { status: "issued"; tokens: Tokens; person: LinkedPerson }
  /** the person declined, or swamp-club refused (for example an email mismatch) */
  | { status: "refused"; reason: string }
  /** the link ended before tokens were taken, for example it timed out */
  | { status: "ended"; cause: string };

/**
 * Why serve refused a refresh. Three reasons can recover, so the app keeps the
 * tokens and tries again later:
 *
 * - `not_admitted`: the person isn't currently admitted to the serve's
 *   collective, and may be again.
 * - `suspended`: swamp-club has suspended the person's account.
 * - `links_unavailable`: serve has paused the link for another reason, for
 *   example swamp-club refusing serve's own client or not knowing the link.
 *
 * Every other reason means the link is over and the person has to link again.
 */
export type RefreshRefusalReason =
  | "mismatch"
  | "unknown"
  | "not_issued"
  | "not_admitted"
  | "suspended"
  | "links_unavailable"
  | "ended"
  | "expired"
  | "superseded"
  | "unreadable";

/** The refresh refusals a link recovers from. */
export const RECOVERABLE_REFRESH_REASONS: ReadonlySet<string> = new Set([
  "not_admitted",
  "suspended",
  "links_unavailable",
]);

export type RefreshOutcome =
  | { status: "refreshed"; accessToken: Secret; accessTokenExpiresAt: string; expiresAt?: string }
  | { status: "refused"; reason: RefreshRefusalReason };

// ---------------------------------------------------------------------------
// Wire types: action route
// ---------------------------------------------------------------------------

export interface RunStarted {
  runId: string;
  workflowName: string;
  /** true when serve recognised the idempotency key and returned the earlier run */
  replayed: boolean;
}

/** A workflow run as `workflow.history.get` reports it. */
export interface RunView {
  id: string;
  workflowId: string;
  workflowName: string;
  /** for example `running`, `suspended`, `succeeded`, `failed`, `cancelled` */
  status: string;
  jobs: Array<{
    name: string;
    status: string;
    /** a step waiting at a gate has status `waiting_approval` */
    steps: Array<{ name: string; status: string; error?: string; duration?: number }>;
    duration?: number;
  }>;
  duration?: number;
}

/** A gate waiting for a decision, as `workflow.approvals` lists it. */
export interface PendingApproval {
  workflowId: string;
  workflowName: string;
  runId: string;
  stepName: string;
  /**
   * When this attempt at the gate opened. A decision must send it back, so a
   * click on an old message can't decide a gate that has since reopened.
   */
  suspendedAt?: string;
  prompt?: string;
  inputs: Record<string, unknown>;
  initiatedBy?: string;
  /** serve's view of whether this person may decide it */
  canDecide?: boolean;
}

export interface Decision {
  workflowIdOrName: string;
  runId: string;
  stepName: string;
  suspendedAt: string;
  reason?: string;
}

export interface DecisionRecorded {
  runId: string;
  workflowName: string;
  stepName: string;
  approved: boolean;
  /** who serve recorded as deciding: the linked person, not the app */
  decidedBy: string;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Serve answered with an error, or didn't answer.
 *
 * `code` is serve's code, or one of this module's own: `timeout` (no answer
 * in time), `unreachable` (no connection) and `bad_reply` (an answer this
 * module doesn't understand). The message holds the code and status only,
 * never a request or reply body, so it is safe to log.
 *
 * Codes the app acts on:
 * - delegation routes: `invalid_client` (bad integration credential),
 *   `email_required`, `ceiling_too_wide`, `too_many_pending`,
 *   `already_redeemed`, `invalid_grant` (a dead token, with `reason`),
 *   `team_not_ready` (try the same call again), `rate_limited`
 * - action route: `unauthorized` (the access token is dead), `forbidden`
 *   (serve refused this person), `consent_required` (the person's grants
 *   allow it, but they didn't agree to it when linking), and for gates `already_decided`,
 *   `gate_reopened`, `gate_closed`, `gate_not_open`
 */
export class ServeError extends Error {
  override readonly name = "ServeError";

  constructor(
    readonly code: string,
    readonly status: number,
    /** `reason` from a refused refresh or end */
    readonly reason?: string,
    /** from `Retry-After` on a 429 or 503 */
    readonly retryAfterSeconds?: number,
  ) {
    super(status ? `serve answered ${status} ${code}` : `serve call failed: ${code}`);
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface ServeClientOptions {
  /** serve's address, for example `https://serve.example.internal:9090` */
  baseUrl: string;
  /** the integration credential, `swi1.<integrationId>.<secret>` */
  credential: Secret;
  /** how long to wait for any one call. Default 10 seconds. */
  timeoutMs?: number;
  /** for tests */
  fetch?: typeof fetch;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export class ServeClient {
  readonly #baseUrl: string;
  readonly #credential: Secret;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ServeClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#credential = options.credential;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
  }

  // --- Delegation routes (integration credential) ---------------------------

  /**
   * `POST /api/v1/delegations/links`: start linking a person. Serve answers 201.
   *
   * Starting again for the same person replaces the pending link, so this is
   * safe to repeat. Show `consentUrl` only to that person.
   */
  async startLink(
    external: ExternalIdentity,
    ceiling: Ceiling,
    options?: CallOptions,
  ): Promise<LinkStarted> {
    const body = await this.#call(`${DELEGATIONS_PATH}/links`, this.#credential, {
      external: {
        platform: external.platform,
        team_id: external.teamId,
        user_id: external.userId,
        display: external.display,
        workspace: external.workspace,
        ...(external.email ? { email: external.email } : {}),
      },
      ceiling,
    }, options);
    return {
      pendingId: str(body, "pendingId"),
      redeemSecret: new Secret(str(body, "redeemSecret")),
      consentUrl: new Secret(str(body, "consentUrl")),
      expiresIn: num(body, "expiresIn"),
      interval: num(body, "interval"),
    };
  }

  /**
   * `POST /api/v1/delegations/redeem`: ask whether the person has answered.
   *
   * Pending is a 202; the other outcomes are 200. Tokens are handed over once:
   * a redeem after `issued` gets `ServeError("already_redeemed")`. So if this
   * call times out, don't assume it failed — the tokens may have been issued
   * and lost, and the person will need to link again.
   */
  async redeem(
    pendingId: string,
    redeemSecret: Secret,
    options?: CallOptions,
  ): Promise<RedeemOutcome> {
    const body = await this.#call(`${DELEGATIONS_PATH}/redeem`, this.#credential, {
      pendingId,
      redeemSecret: redeemSecret.reveal(),
    }, options);
    switch (body.status) {
      case "pending":
        return { status: "pending", interval: num(body, "interval") };
      case "refused":
        return { status: "refused", reason: str(body, "reason") };
      case "ended":
        return { status: "ended", cause: str(body, "cause") };
      case "issued":
        return {
          status: "issued",
          tokens: {
            delegationId: str(body, "delegationId"),
            accessToken: new Secret(str(body, "accessToken")),
            accessTokenExpiresAt: str(body, "accessTokenExpiresAt"),
            refreshToken: new Secret(str(body, "refreshToken")),
            expiresAt: optStr(body, "expiresAt"),
          },
          person: person(body.person),
        };
      default:
        throw new ServeError("bad_reply", 200);
    }
  }

  /**
   * `POST /api/v1/delegations/refresh`: get a new access token.
   *
   * The refresh token stays the same, and serve keeps the two previous access
   * tokens valid, so two refreshes racing each other do no harm and this is
   * safe to repeat. A refusal is a 401 `invalid_grant` with a `reason`, which
   * this method returns rather than throws. `team_not_ready` (503) means try
   * again with the same token.
   */
  async refresh(refreshToken: Secret, options?: CallOptions): Promise<RefreshOutcome> {
    try {
      const body = await this.#call(`${DELEGATIONS_PATH}/refresh`, this.#credential, {
        refreshToken: refreshToken.reveal(),
      }, options);
      return {
        status: "refreshed",
        accessToken: new Secret(str(body, "accessToken")),
        accessTokenExpiresAt: str(body, "accessTokenExpiresAt"),
        expiresAt: optStr(body, "expiresAt"),
      };
    } catch (error) {
      if (error instanceof ServeError && error.code === "invalid_grant") {
        return { status: "refused", reason: (error.reason ?? "unknown") as RefreshRefusalReason };
      }
      throw error;
    }
  }

  /**
   * `POST /api/v1/delegations/end`: end the link, with either of its tokens.
   *
   * A token serve no longer knows gets 401 `invalid_grant`; the link is
   * already over, so this method treats that as done. Safe to repeat.
   */
  async end(token: Secret, options?: CallOptions): Promise<void> {
    try {
      await this.#call(`${DELEGATIONS_PATH}/end`, this.#credential, {
        token: token.reveal(),
      }, options);
    } catch (error) {
      if (error instanceof ServeError && error.code === "invalid_grant") return;
      throw error;
    }
  }

  // --- Action route (the person's access token) -----------------------------

  /**
   * `workflow.run`: start a workflow as the person. Serve answers 202.
   *
   * The idempotency key names one user action (Slackwater uses the Slack
   * `trigger_id` or form id). Sending the same key again returns the same run
   * with `replayed: true` instead of starting another, so this is safe to
   * repeat on one serve. Serve doesn't promise replay across several serves
   * that share a remote datastore.
   */
  runWorkflow(
    accessToken: Secret,
    input: {
      workflowIdOrName: string;
      /** letters, digits and `._:-`, at most 128 characters */
      idempotencyKey: string;
      inputs?: Record<string, unknown>;
    },
    options?: CallOptions,
  ): Promise<RunStarted> {
    return this.action<RunStarted>(accessToken, "workflow.run", input, options);
  }

  /** `workflow.history.get`: one run's status, by job and step. Safe to repeat. */
  getRun(accessToken: Secret, runId: string, options?: CallOptions): Promise<RunView> {
    return this.action<RunView>(accessToken, "workflow.history.get", { runId }, options);
  }

  /**
   * `workflow.approvals`: the gates waiting for a decision that this person
   * can see. Safe to repeat. This is the only place `suspendedAt` comes from.
   */
  async listApprovals(accessToken: Secret, options?: CallOptions): Promise<PendingApproval[]> {
    const data = await this.action<{ approvals?: PendingApproval[] }>(
      accessToken,
      "workflow.approvals",
      {},
      options,
    );
    return data.approvals ?? [];
  }

  /**
   * `workflow.approve`: approve a gate as the person. Safe to repeat: a second
   * decision gets `already_decided`, and one for an attempt that has passed
   * gets `gate_reopened` or `gate_closed`, and records nothing.
   */
  approve(accessToken: Secret, decision: Decision, options?: CallOptions) {
    return this.action<DecisionRecorded>(accessToken, "workflow.approve", decision, options);
  }

  /** `workflow.reject`: reject a gate as the person. Same rules as `approve`. */
  reject(accessToken: Secret, decision: Decision, options?: CallOptions) {
    return this.action<DecisionRecorded>(accessToken, "workflow.reject", decision, options);
  }

  /**
   * `POST /api/v1/action` with `{ type, payload }`. Success is
   * `{ requestId, type, data }`; this returns `data`. Serve rejects a payload
   * with fields it doesn't expect, so send exactly what the type needs.
   */
  async action<T>(
    accessToken: Secret,
    type: string,
    payload: unknown,
    options?: CallOptions,
  ): Promise<T> {
    const body = await this.#call(ACTION_PATH, accessToken, { type, payload }, options);
    if (!("data" in body)) throw new ServeError("bad_reply", 200);
    return body.data as T;
  }

  // --- Transport ------------------------------------------------------------

  async #call(
    path: string,
    bearer: Secret,
    payload: unknown,
    options?: CallOptions,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${bearer.reveal()}`,
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (timeout.aborted) throw new ServeError("timeout", 0);
      if (options?.signal?.aborted) throw error;
      throw new ServeError("unreachable", 0);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (timeout.aborted) throw new ServeError("timeout", 0);
      throw new ServeError("bad_reply", response.status);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ServeError("bad_reply", response.status);
    }
    const record = body as Record<string, unknown>;

    if (!response.ok) {
      const code = typeof record.code === "string" ? record.code : "bad_reply";
      const reason = typeof record.reason === "string" ? record.reason : undefined;
      throw new ServeError(code, response.status, reason, retryAfter(response));
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// Reading replies
// ---------------------------------------------------------------------------

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new ServeError("bad_reply", 200);
  return value;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function num(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number") throw new ServeError("bad_reply", 200);
  return value;
}

function person(value: unknown): LinkedPerson {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  return { username: optStr(record, "username"), email: optStr(record, "email") };
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
