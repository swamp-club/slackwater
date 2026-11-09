/**
 * Slackwater's behaviour, apart from Slack's SDK so it can be tested with a
 * fake Slack. `main.ts` connects it to Bolt.
 *
 * The rules it keeps:
 * - Answer Slack within 3 seconds: every handler acknowledges first and does
 *   the slow part afterwards.
 * - Serve decides what a person may do. The app sends each request with the
 *   token of the person who asked, and reports what serve said.
 * - Only people in the app's own workspace are served.
 * - No token or consent URL is ever logged or put in a message, except the
 *   consent URL in the ephemeral reply to the person linking.
 */

import type { Command, CommandsFile } from "./commands.ts";
import * as msg from "./messages.ts";
import type { Message } from "./messages.ts";
import {
  type PendingApproval,
  type RunView,
  type ServeClient,
  ServeError,
} from "./serve/client.ts";
import type { Secret } from "./serve/secret.ts";
import type { PersonKey, Store, WatchedRunRecord } from "./store.ts";
import type { TokenKeeper, TokenResult } from "./tokens.ts";

/** The few Slack Web API calls the app makes. */
export interface SlackApi {
  postMessage(channel: string, message: Message): Promise<{ channel: string; ts: string }>;
  update(channel: string, ts: string, message: Message): Promise<void>;
  postEphemeral(channel: string, user: string, message: Message): Promise<void>;
  openView(triggerId: string, view: msg.Block): Promise<void>;
  userInfo(userId: string): Promise<{ display: string; email?: string; isBot: boolean }>;
}

/** Reply only the person who typed the command can see (the command's response_url). */
export type Respond = (message: Message) => Promise<void>;
export type Ack = (response?: Record<string, unknown>) => Promise<void>;

export interface SlashCommand {
  command: string;
  text: string;
  teamId: string;
  userId: string;
  channelId: string;
  triggerId: string;
}

export interface ButtonClick {
  actionId: string;
  value: string;
  teamId: string;
  userId: string;
  channelId: string;
  actionTs: string;
}

export interface FormSubmission {
  viewId: string;
  teamId: string;
  userId: string;
  privateMetadata: string;
  // deno-lint-ignore no-explicit-any
  values: Record<string, Record<string, any>>;
}

/** Log lines carry event names, ids and serve's codes: never tokens, URLs or bodies. */
export type Log = (event: string, fields?: Record<string, string | number | boolean>) => void;

export interface AppDeps {
  slack: SlackApi;
  serve: ServeClient;
  store: Store;
  tokens: TokenKeeper;
  commands: CommandsFile;
  /** the workspace the app is installed in, from `auth.test` */
  teamId: string;
  workspaceName: string;
  log: Log;
  now?: () => number;
}

// How often to look at a run: every 3 s for the first 30 s, every 15 s up to
// 10 minutes, then every minute. Stop following after a day.
const POLL_STEPS: [untilMs: number, everyMs: number][] = [
  [30_000, 3_000],
  [10 * 60_000, 15_000],
  [24 * 60 * 60_000, 60_000],
];
const FOLLOW_FOR_MS = 24 * 60 * 60_000;

export class Slackwater {
  readonly #d: AppDeps;
  readonly #now: () => number;
  readonly #seen = new Seen(2_000);
  readonly #runNext = new Map<string, number>();
  readonly #linkNext = new Map<string, number>();
  readonly #byCommand: Map<string, Command>;
  #ticking = false;

  constructor(deps: AppDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#byCommand = new Map(deps.commands.commands.map((c) => [c.command, c]));
  }

  // --- Slash commands ---------------------------------------------------------

  async onCommand(cmd: SlashCommand, ack: Ack, respond: Respond): Promise<void> {
    await ack();
    // Slack resends a command it thinks wasn't acknowledged. Do each one once.
    if (!this.#seen.first(`cmd:${cmd.triggerId}`)) return;
    if (cmd.teamId !== this.#d.teamId) return respond(msg.otherWorkspace());
    const person = { teamId: cmd.teamId, userId: cmd.userId };

    const custom = this.#byCommand.get(cmd.command);
    if (custom) return this.#onCustomCommand(custom, cmd, person, respond);

    const [sub = "help", ...rest] = cmd.text.trim().split(/\s+/).filter(Boolean);
    switch (sub.toLowerCase()) {
      case "link":
        return this.#link(person, respond);
      case "unlink":
        return this.#unlink(person, respond);
      case "status":
        return this.#status(person, respond);
      case "run":
        return this.#genericRun(cmd, person, rest, respond);
      default:
        return respond(msg.help(this.#d.commands.commands));
    }
  }

  async #onCustomCommand(
    command: Command,
    cmd: SlashCommand,
    person: PersonKey,
    respond: Respond,
  ): Promise<void> {
    // Check the link locally only: the form must open while the trigger is
    // fresh, so there's no time for a serve call here.
    if (!(await this.#d.store.getLink(person))) return respond(msg.notLinked());
    const channel = command.report === "dm" ? cmd.userId : cmd.channelId;
    if (command.fields.length === 0) {
      return this.#startRun(person, command.workflow, {}, `slack.${cmd.teamId}.${cmd.triggerId}`, {
        title: command.description,
        channel,
        tell: respond,
      });
    }
    try {
      await this.#d.slack.openView(
        cmd.triggerId,
        msg.form(command, { command: command.command, channel }),
      );
    } catch {
      this.#d.log("form_open_failed", { command: command.command });
      await respond({ text: "Slack wouldn't open the form. Try the command again." });
    }
  }

  async #genericRun(cmd: SlashCommand, person: PersonKey, words: string[], respond: Respond) {
    const [workflow, ...pairs] = words;
    if (!workflow) return respond({ text: "Usage: `/swamp run <workflow> [name=value …]`" });
    const inputs = msg.parseInputs(pairs);
    if (typeof inputs === "string") {
      return respond({ text: `${inputs}. Usage: \`/swamp run <workflow> [name=value …]\`` });
    }
    await this.#startRun(person, workflow, inputs, `slack.${cmd.teamId}.${cmd.triggerId}`, {
      title: workflow,
      channel: cmd.channelId,
      tell: respond,
    });
  }

  // --- Forms ------------------------------------------------------------------

  async onSubmission(sub: FormSubmission, ack: Ack): Promise<void> {
    let meta: msg.FormMetadata;
    try {
      meta = JSON.parse(sub.privateMetadata);
    } catch {
      return ack();
    }
    const command = this.#byCommand.get(meta.command);
    if (!command || sub.teamId !== this.#d.teamId) return ack();
    const read = msg.readForm(command, sub.values);
    if ("errors" in read) return ack({ response_action: "errors", errors: read.errors });
    await ack();
    if (!this.#seen.first(`view:${sub.viewId}`)) return;
    const person = { teamId: sub.teamId, userId: sub.userId };
    await this.#startRun(
      person,
      command.workflow,
      read.inputs,
      `slack.${sub.teamId}.${sub.viewId}`,
      {
        title: command.description,
        channel: meta.channel,
        tell: (m) => this.#tell(person, meta.channel, m),
      },
    );
  }

  // --- Runs -------------------------------------------------------------------

  async #startRun(
    person: PersonKey,
    workflow: string,
    inputs: Record<string, unknown>,
    idempotencyKey: string,
    where: { title: string; channel: string; tell: Respond },
  ): Promise<void> {
    const started = await this.#asPerson(
      person,
      where.tell,
      (token) =>
        this.#d.serve.runWorkflow(token, { workflowIdOrName: workflow, idempotencyKey, inputs }),
    );
    if (!started) return;
    this.#d.log("run_started", { runId: started.runId, replayed: started.replayed });
    if (started.replayed) return; // this was a retry; the first attempt posted the message

    const first = msg.runMessage(where.title, person.userId, undefined, []);
    let posted: { channel: string; ts: string };
    try {
      posted = await this.#d.slack.postMessage(where.channel, first);
    } catch {
      // Usually the app isn't in that channel. Post the run to the person instead.
      posted = await this.#d.slack.postMessage(person.userId, first);
      await where.tell({
        text: "I can't post in that channel, so I've put the run in our direct messages. " +
          "Invite me with `/invite @Swamp` to post runs there.",
      });
    }
    await this.#d.store.putRun({
      runId: started.runId,
      workflowName: started.workflowName,
      starter: person,
      channel: posted.channel,
      ts: posted.ts,
      lastShown: "",
      startedAt: this.#now(),
      title: where.title,
    });
    this.#runNext.set(started.runId, 0);
  }

  async #followRun(run: WatchedRunRecord): Promise<void> {
    const age = this.#now() - run.startedAt;
    if (age > FOLLOW_FOR_MS) {
      await this.#d.store.deleteRun(run.runId);
      await this.#d.slack.update(
        run.channel,
        run.ts,
        msg.runMessage(
          run.title,
          run.starter.userId,
          undefined,
          [],
          "Swamp stopped following this run after a day. Check it in swamp.",
        ),
      ).catch(() => {});
      return;
    }
    const token = await this.#d.tokens.accessToken(run.starter);
    if (!token.ok) {
      if (token.why === "serve_unavailable") return;
      await this.#d.store.deleteRun(run.runId);
      await this.#d.slack.update(
        run.channel,
        run.ts,
        msg.runMessage(
          run.title,
          run.starter.userId,
          undefined,
          [],
          "Swamp can't follow this run any more because the starter's link has ended.",
        ),
      ).catch(() => {});
      return;
    }
    let view: RunView;
    let gates: PendingApproval[] = [];
    try {
      view = await this.#d.serve.getRun(token.accessToken, run.runId);
      const waiting = view.status === "suspended" ||
        view.jobs.some((j) => j.steps.some((s) => s.status === "waiting_approval"));
      if (waiting) {
        gates = (await this.#d.serve.listApprovals(token.accessToken))
          .filter((g) => g.runId === run.runId);
      }
    } catch (error) {
      if (error instanceof ServeError && error.code === "unauthorized") {
        await this.#d.tokens.forceRefresh(run.starter);
      }
      if (!(error instanceof ServeError)) throw error;
      this.#d.log("run_poll_failed", { runId: run.runId, code: error.code });
      return;
    }
    const shown = msg.shownKey(view, gates);
    const finished = msg.isFinished(view.status);
    if (shown !== run.lastShown) {
      try {
        await this.#d.slack.update(
          run.channel,
          run.ts,
          msg.runMessage(run.title, run.starter.userId, view, gates),
        );
        if (!finished) await this.#d.store.putRun({ ...run, lastShown: shown });
      } catch {
        this.#d.log("message_update_failed", { runId: run.runId });
      }
    }
    if (finished) {
      await this.#d.store.deleteRun(run.runId);
      this.#runNext.delete(run.runId);
      this.#d.log("run_finished", { runId: run.runId, status: view.status });
    }
  }

  // --- Gate buttons -----------------------------------------------------------

  async onButton(click: ButtonClick, ack: Ack): Promise<void> {
    await ack();
    if (click.actionId !== "gate_approve" && click.actionId !== "gate_reject") return;
    if (!this.#seen.first(`click:${click.userId}:${click.actionTs}`)) return;
    const person = { teamId: click.teamId, userId: click.userId };
    const tell = (m: Message) => this.#tell(person, click.channelId, m);
    if (click.teamId !== this.#d.teamId) return tell(msg.otherWorkspace());

    let gate: msg.GateButtonValue;
    try {
      gate = JSON.parse(click.value);
    } catch {
      return;
    }
    const approve = click.actionId === "gate_approve";
    const decision = {
      workflowIdOrName: gate.w,
      runId: gate.r,
      stepName: gate.s,
      suspendedAt: gate.t,
      reason: `${approve ? "Approved" : "Rejected"} in Slack`,
    };
    const recorded = await this.#asPerson(
      person,
      tell,
      (token) =>
        approve ? this.#d.serve.approve(token, decision) : this.#d.serve.reject(token, decision),
    );
    // Look at the run again now rather than at the next poll.
    this.#runNext.set(gate.r, 0);
    if (!recorded) return;
    this.#d.log("gate_decided", { runId: gate.r, approved: approve });
    await tell(msg.decided(approve, recorded.decidedBy, recorded.stepName));
  }

  // --- Linking ----------------------------------------------------------------

  async #link(person: PersonKey, respond: Respond): Promise<void> {
    let profile;
    try {
      profile = await this.#d.slack.userInfo(person.userId);
    } catch {
      return respond({ text: "Slack wouldn't tell me who you are. Try again in a moment." });
    }
    if (profile.isBot) return respond(msg.otherWorkspace());
    try {
      const started = await this.#d.serve.startLink({
        platform: "slack",
        teamId: person.teamId,
        userId: person.userId,
        display: profile.display,
        workspace: this.#d.workspaceName,
        email: profile.email,
      }, this.#d.commands.ceiling);
      await this.#d.store.putPending({
        ...person,
        pendingId: started.pendingId,
        redeemSecret: started.redeemSecret,
        giveUpAt: this.#now() + started.expiresIn * 1000 + 60_000,
        interval: started.interval,
      });
      this.#linkNext.set(key(person), this.#now() + started.interval * 1000);
      this.#d.log("link_started", { pendingId: started.pendingId });
      await respond(msg.consentPrompt(started.consentUrl, started.expiresIn));
    } catch (error) {
      if (!(error instanceof ServeError)) throw error;
      this.#d.log("link_start_failed", { code: error.code });
      await respond({ text: msg.explain(error.code) });
    }
  }

  async #pollLink(personKey: PersonKey): Promise<void> {
    const pending = await this.#d.store.getPending(personKey);
    if (!pending) return void this.#linkNext.delete(key(personKey));
    const person = { teamId: pending.teamId, userId: pending.userId };
    const done = async (message: Message) => {
      await this.#d.store.deletePending(person);
      this.#linkNext.delete(key(person));
      await this.#dm(person, message);
    };
    if (this.#now() > pending.giveUpAt) return done(msg.linkEnded());
    try {
      const outcome = await this.#d.serve.redeem(pending.pendingId, pending.redeemSecret);
      switch (outcome.status) {
        case "pending":
          this.#linkNext.set(key(person), this.#now() + outcome.interval * 1000);
          return;
        case "issued":
          await this.#d.store.putLink({
            ...person,
            ...outcome.tokens,
            username: outcome.person.username,
            linkedAt: new Date(this.#now()).toISOString(),
          });
          this.#d.log("linked", { delegationId: outcome.tokens.delegationId });
          return done(msg.linked(outcome.person.username));
        case "refused":
          this.#d.log("link_refused", { reason: outcome.reason });
          return done(msg.linkRefused(outcome.reason));
        case "ended":
          this.#d.log("link_ended", { cause: outcome.cause });
          return done(msg.linkEnded());
      }
    } catch (error) {
      if (!(error instanceof ServeError)) throw error;
      this.#d.log("redeem_failed", { code: error.code });
      if (error.code === "already_redeemed") {
        // Tokens were handed out but the reply never arrived. They're lost.
        return done({ text: "Linking didn't finish properly. Run `/swamp link` to try again." });
      }
      const wait = (error.retryAfterSeconds ?? pending.interval) * 1000;
      this.#linkNext.set(key(person), this.#now() + wait);
    }
  }

  async #unlink(person: PersonKey, respond: Respond): Promise<void> {
    await this.#d.store.deletePending(person);
    const link = await this.#d.store.getLink(person);
    if (!link) return respond({ text: "You weren't linked." });
    let toldServe = true;
    try {
      await this.#d.serve.end(link.refreshToken);
    } catch (error) {
      if (!(error instanceof ServeError)) throw error;
      this.#d.log("end_failed", { code: error.code });
      toldServe = false;
    }
    await this.#d.store.deleteLink(person);
    this.#d.log("unlinked", { delegationId: link.delegationId, toldServe });
    await respond(msg.unlinked(toldServe));
  }

  async #status(person: PersonKey, respond: Respond): Promise<void> {
    const link = await this.#d.store.getLink(person);
    if (link) {
      const who = link.username ? ` as *${msg.esc(link.username)}*` : "";
      const until = link.expiresAt ? ` until ${link.expiresAt.slice(0, 10)}` : "";
      return respond({ text: `You're linked to swamp${who}${until}.` });
    }
    if (await this.#d.store.getPending(person)) {
      return respond({ text: "Swamp is waiting for you to finish linking in swamp-club." });
    }
    return respond(msg.notLinked());
  }

  // --- Background work --------------------------------------------------------

  /** Load what the store remembers, after a restart. */
  async resume(): Promise<void> {
    for (const run of await this.#d.store.listRuns()) this.#runNext.set(run.runId, 0);
    for (const p of await this.#d.store.listPending()) this.#linkNext.set(key(p), 0);
  }

  /** Call about once a second. Polls whatever is due, one serve call at a time. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const pending of await this.#d.store.listPending()) {
        const next = this.#linkNext.get(key(pending)) ?? 0;
        if (next <= now) await this.#guard(() => this.#pollLink(pending));
      }
      for (const run of await this.#d.store.listRuns()) {
        const next = this.#runNext.get(run.runId) ?? 0;
        if (next > now) continue;
        this.#runNext.set(run.runId, now + pollEvery(now - run.startedAt));
        await this.#guard(() => this.#followRun(run));
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #guard(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (error) {
      // Only the error's name: an unexpected error's message isn't known to be safe.
      this.#d.log("background_error", { error: (error as Error)?.name ?? "unknown" });
    }
  }

  // --- Helpers ----------------------------------------------------------------

  /**
   * Call serve as `person`, telling them in Slack if it can't be done. Retries
   * once with a fresh token if serve says the token is no good; every call
   * passed here is safe to send twice.
   */
  async #asPerson<T>(
    person: PersonKey,
    tell: Respond,
    call: (token: Secret) => Promise<T>,
  ): Promise<T | undefined> {
    let token = await this.#d.tokens.accessToken(person);
    for (let attempt = 0;; attempt++) {
      if (!token.ok) {
        await tell(tokenProblem(token));
        return undefined;
      }
      try {
        return await call(token.accessToken);
      } catch (error) {
        if (!(error instanceof ServeError)) throw error;
        if (error.code === "unauthorized" && attempt === 0) {
          token = await this.#d.tokens.forceRefresh(person);
          continue;
        }
        this.#d.log("serve_refused", { code: error.code, status: error.status });
        await tell({ text: msg.explain(error.code) });
        return undefined;
      }
    }
  }

  async #tell(person: PersonKey, channel: string, message: Message) {
    try {
      await this.#d.slack.postEphemeral(channel, person.userId, message);
    } catch {
      await this.#dm(person, message);
    }
  }

  async #dm(person: PersonKey, message: Message) {
    try {
      await this.#d.slack.postMessage(person.userId, message);
    } catch {
      this.#d.log("dm_failed", {});
    }
  }
}

function tokenProblem(token: Exclude<TokenResult, { ok: true }>): Message {
  switch (token.why) {
    case "not_linked":
      return msg.notLinked();
    case "link_ended":
      return msg.linkGone();
    case "not_admitted":
      return msg.notAdmitted();
    case "serve_unavailable":
      return { text: msg.explain("unreachable") };
  }
}

function pollEvery(ageMs: number): number {
  for (const [until, every] of POLL_STEPS) if (ageMs < until) return every;
  return POLL_STEPS[POLL_STEPS.length - 1][1];
}

const key = (p: PersonKey) => `${p.teamId}/${p.userId}`;

/** Remembers the last few ids, to drop Slack's resends. */
class Seen {
  readonly #ids = new Set<string>();
  constructor(private readonly size: number) {}
  first(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    if (this.#ids.size > this.size) this.#ids.delete(this.#ids.values().next().value!);
    return true;
  }
}
