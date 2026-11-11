/**
 * Everything Slackwater says in Slack: message text, Block Kit layouts and the
 * forms built from the commands file. Nothing here ever receives a token; the
 * consent URL is the one secret that is shown, and only in an ephemeral reply.
 */

import type { Command, Field } from "./commands.ts";
import type { PendingApproval, RunView } from "./serve/client.ts";
import type { Secret } from "./serve/secret.ts";

// deno-lint-ignore no-explicit-any
export type Block = Record<string, any>;
export interface Message {
  text: string;
  blocks?: Block[];
}

const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): Block => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});

/** Slack mrkdwn treats `<`, `>` and `&` as markup; escape anything from outside. */
export function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// --- Linking ---------------------------------------------------------------

export function consentPrompt(consentUrl: Secret, expiresInSeconds: number): Message {
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  return {
    text: "Link your swamp account",
    blocks: [
      section(
        "To act for you, Swamp needs you to sign in to swamp-club and agree to what it may do. " +
          `The link works for ${minutes} minutes and only you can see it.`,
      ),
      {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "Link my swamp account" },
          style: "primary",
          // The one place a secret is shown, to the one person it belongs to.
          url: consentUrl.reveal(),
          action_id: "consent_link",
        }],
      },
    ],
  };
}

export const linked = (username: string | undefined): Message => ({
  text: username
    ? `You're linked to swamp as *${
      esc(username)
    }*. Swamp will act as you, within what you agreed to.`
    : "You're linked to swamp. Swamp will act as you, within what you agreed to.",
});

export const linkedOtherAccount = (
  username: string | undefined,
  email: string,
  app: string,
): Message => ({
  text: `You're linked to swamp as *${esc(username ?? email)}* (${esc(email)}), ` +
    "which isn't the email on your Slack profile. Swamp will act as that account. " +
    `If it isn't yours, run \`${app} unlink\` now and tell your swamp admin.`,
});

export const linkRefused = (reason: string, app: string): Message => ({
  text: reason === "email_mismatch"
    ? "Linking was refused: your Slack email doesn't match your swamp-club email."
    : `Linking was refused (${esc(reason)}). Run \`${app} link\` to try again.`,
});

export const linkEnded = (app: string): Message => ({
  text: `That link request ended before it was finished. Run \`${app} link\` to start again.`,
});

export const notLinked = (app: string): Message => ({
  text: `You haven't linked your swamp account yet. Run \`${app} link\` first.`,
});

export const linkGone = (app: string): Message => ({
  text: "Your swamp link has ended, so Swamp can't act for you any more. " +
    `Run \`${app} link\` to link again.`,
});

/** Serve refused a refresh for a reason the link recovers from. */
export function paused(reason: string): Message {
  switch (reason) {
    case "suspended":
      return {
        text: "Your swamp-club account is suspended, so Swamp can't act for you. " +
          "Your link is kept, and works again if the suspension is lifted.",
      };
    case "links_unavailable":
      return {
        text: "swamp can't check your link with swamp-club right now, so Swamp can't act for " +
          "you. Your link is kept. If this lasts, tell whoever runs swamp.",
      };
    default:
      return {
        text: "swamp isn't letting you in right now, so Swamp can't act for you. " +
          "Check with your swamp admin that you're still in the collective.",
      };
  }
}

export const consentRequired = (app: string): Message => ({
  text: "You didn't agree to let Swamp do that when you linked. " +
    `Run \`${app} link\` to see what Swamp asks for now and agree again.`,
});

export const unlinked = (toldServe: boolean): Message => ({
  text: toldServe
    ? "Unlinked. Swamp can no longer act for you."
    : "Unlinked here, but serve couldn't be told. The link will stop working when it expires; " +
      "a swamp admin can end it sooner.",
});

export const otherWorkspace = (): Message => ({
  text: "Swamp only works for people in its own Slack workspace.",
});

export const help = (app: string, commands: Command[]): Message => ({
  text: [
    "*Swamp* runs swamp workflows as you.",
    `• \`${app} link\`: link your swamp account`,
    `• \`${app} status\`: show who you're linked as`,
    `• \`${app} run <workflow> [name=value …]\`: run a workflow`,
    `• \`${app} unlink\`: stop Swamp acting for you`,
    ...commands.map((c) => `• \`${c.command}\`: ${esc(c.description)}`),
  ].join("\n"),
});

// --- Runs ------------------------------------------------------------------

export interface GateButtonValue {
  w: string; // workflow id
  r: string; // run id
  s: string; // step name
  t: string; // suspendedAt
}

const STATUS_WORDS: Record<string, string> = {
  pending: "waiting to start",
  running: "running",
  suspended: "waiting for approval",
  succeeded: "finished",
  completed: "finished",
  failed: "failed",
  cancelled: "cancelled",
};

const STEP_MARKS: Record<string, string> = {
  succeeded: "✅",
  completed: "✅",
  failed: "❌",
  running: "⏳",
  waiting_approval: "✋",
  skipped: "➖",
  cancelled: "⛔",
};

export function isFinished(status: string): boolean {
  return ["succeeded", "completed", "failed", "cancelled"].includes(status);
}

export function runMessage(
  title: string,
  startedBy: string,
  run: RunView | undefined,
  gates: PendingApproval[],
  note?: string,
): Message {
  const status = run?.status ?? "pending";
  const word = STATUS_WORDS[status] ?? status;
  const blocks: Block[] = [section(`*${esc(title)}*: ${word}`)];
  const steps = run?.jobs.flatMap((j) => j.steps) ?? [];
  if (steps.length > 0) {
    blocks.push(section(
      steps.map((s) => {
        const line = `${STEP_MARKS[s.status] ?? "•"} ${esc(s.name)}`;
        return s.error && s.status === "failed" ? `${line}: ${esc(s.error.slice(0, 300))}` : line;
      }).join("\n"),
    ));
  }
  for (const gate of gates) {
    if (gate.prompt) blocks.push(section(`> ${esc(gate.prompt).replaceAll("\n", "\n> ")}`));
    if (!gate.suspendedAt) continue;
    const value: GateButtonValue = {
      w: gate.workflowId,
      r: gate.runId,
      s: gate.stepName,
      t: gate.suspendedAt,
    };
    blocks.push({
      type: "actions",
      block_id: `gate:${gate.runId}:${gate.stepName}`,
      elements: [
        {
          type: "button",
          action_id: "gate_approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: JSON.stringify(value),
        },
        {
          type: "button",
          action_id: "gate_reject",
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
          value: JSON.stringify(value),
        },
      ],
    });
  }
  const footer = [`Started by <@${startedBy}>`];
  if (run) footer.push(`run \`${run.id}\``);
  if (note) footer.push(note);
  blocks.push(context(footer.join(" · ")));
  return { text: `${title}: ${word}`, blocks };
}

/** A short fingerprint of what the message shows, so it's only updated on change. */
export function shownKey(run: RunView | undefined, gates: PendingApproval[]): string {
  const steps = run?.jobs.flatMap((j) => j.steps.map((s) => `${s.name}=${s.status}`)) ?? [];
  return [run?.status ?? "pending", ...steps, ...gates.map((g) => `${g.stepName}@${g.suspendedAt}`)]
    .join("|");
}

export const decided = (approved: boolean, who: string, step: string): Message => ({
  text: `${approved ? "Approved" : "Rejected"} *${esc(step)}* as ${esc(who)}.`,
});

/** What to tell someone when serve refused or failed, by serve's code. */
export function explain(code: string): string {
  switch (code) {
    case "forbidden":
      return "swamp refused: you don't have permission to do that.";
    case "already_decided":
      return "Someone has already decided that gate.";
    case "gate_reopened":
      return "That gate has been reopened since this message was posted. Use the newest buttons.";
    case "gate_closed":
    case "gate_not_open":
      return "That gate is no longer waiting for a decision.";
    case "not_found":
      return "swamp couldn't find that workflow or run.";
    case "invalid_request":
      return "swamp didn't accept the request. Check the workflow name and inputs.";
    case "idempotency_conflict":
      return "That request was already used for something different.";
    case "too_many_runs":
    case "rate_limited":
    case "busy":
      return "swamp is busy. Try again in a moment.";
    case "still_working":
    case "outcome_unknown":
      return "swamp didn't confirm in time. It may still happen; check the run before trying again.";
    case "timeout":
    case "unreachable":
      return "swamp didn't answer. Try again in a moment.";
    case "ceiling_too_wide":
    case "invalid_ceiling":
    case "invalid_client":
      return "Swamp isn't set up correctly to link accounts. Tell whoever runs it.";
    case "email_required":
      return "Swamp needs your email to link you, and Slack didn't give it. " +
        "Ask whoever runs Swamp to check its users:read.email permission.";
    case "links_require_plan":
      return "Linking needs your Swamp collective to be on a trial or a paid plan. " +
        "Tell whoever runs Swamp.";
    case "links_require_collective_client":
      return "This Swamp can't link accounts until it's set up with a collective API key. " +
        "Tell whoever runs it.";
    case "links_not_enabled":
    case "links_unavailable":
    case "no_instance":
      return "This swamp isn't accepting links yet. Tell whoever runs it.";
    default:
      return `swamp couldn't do that (${esc(code)}).`;
  }
}

// --- Forms -----------------------------------------------------------------

export interface FormMetadata {
  command: string;
  channel: string;
}

export function form(command: Command, metadata: FormMetadata): Block {
  return {
    type: "modal",
    callback_id: "run_form",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: command.title },
    submit: { type: "plain_text", text: "Run" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      context(`Runs the swamp workflow \`${esc(command.workflow)}\` as you.`),
      ...command.fields.map(fieldBlock),
    ],
  };
}

function fieldBlock(field: Field): Block {
  const block: Block = {
    type: "input",
    block_id: field.name,
    optional: !field.required,
    label: { type: "plain_text", text: field.label },
  };
  if (field.hint) block.hint = { type: "plain_text", text: field.hint };
  const placeholder = field.placeholder
    ? { placeholder: { type: "plain_text", text: field.placeholder } }
    : {};
  switch (field.type) {
    case "number":
      block.element = {
        type: "number_input",
        action_id: "value",
        is_decimal_allowed: false,
        ...(field.min !== undefined ? { min_value: String(field.min) } : {}),
        ...(field.max !== undefined ? { max_value: String(field.max) } : {}),
        ...(field.initial !== undefined ? { initial_value: String(field.initial) } : {}),
        ...placeholder,
      };
      break;
    case "select": {
      const options = field.options!.map((o) => ({
        text: { type: "plain_text", text: o.label },
        value: o.value,
      }));
      const initial = options.find((o) => o.value === String(field.initial));
      block.element = {
        type: "static_select",
        action_id: "value",
        options,
        ...(initial ? { initial_option: initial } : {}),
        ...placeholder,
      };
      break;
    }
    default:
      block.element = {
        type: "plain_text_input",
        action_id: "value",
        multiline: field.multiline ?? false,
        ...(field.initial !== undefined ? { initial_value: String(field.initial) } : {}),
        ...placeholder,
      };
  }
  return block;
}

/** Read the submitted form into workflow inputs, or say what's wrong. */
export function readForm(
  command: Command,
  // deno-lint-ignore no-explicit-any
  values: Record<string, Record<string, any>>,
): { inputs: Record<string, unknown> } | { errors: Record<string, string> } {
  const inputs: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of command.fields) {
    const element = values[field.name]?.value;
    const raw = field.type === "select" ? element?.selected_option?.value : element?.value;
    if (raw === undefined || raw === null || raw === "") {
      if (field.required) errors[field.name] = "Required";
      continue;
    }
    if (field.type === "number") {
      const n = Number(raw);
      if (!Number.isInteger(n)) errors[field.name] = "Enter a whole number";
      else if (field.min !== undefined && n < field.min) {
        errors[field.name] = `At least ${field.min}`;
      } else if (field.max !== undefined && n > field.max) {
        errors[field.name] = `At most ${field.max}`;
      } else inputs[field.name] = n;
    } else if (field.type === "select") {
      if (!field.options!.some((o) => o.value === raw)) errors[field.name] = "Pick an option";
      else inputs[field.name] = raw;
    } else {
      inputs[field.name] = String(raw);
    }
  }
  return Object.keys(errors).length > 0 ? { errors } : { inputs };
}

/** Parse `name=value` words from `<app command> run`. Values that look like numbers stay strings. */
export function parseInputs(words: string[]): Record<string, string> | string {
  const inputs: Record<string, string> = {};
  for (const word of words) {
    const at = word.indexOf("=");
    if (at <= 0) return `"${word}" isn't name=value`;
    inputs[word.slice(0, at)] = word.slice(at + 1);
  }
  return inputs;
}
