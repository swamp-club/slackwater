/**
 * The commands file: which slash commands the app answers, which workflow each
 * one runs, and the form that collects the workflow's inputs.
 *
 * Slack only delivers slash commands listed in the app's manifest, so
 * `deno task manifest` builds the manifest from this same file. See
 * `demo/commands.yaml` for a worked example.
 *
 * ```yaml
 * ceiling:                       # what a person agrees the app may do for them
 *   - actions: [run, read, approve]
 *     resource: "workflow:scale-web"
 * commands:
 *   - command: /scale-web
 *     workflow: scale-web
 *     description: Change how many web servers are running
 *     report: channel            # or dm: only the person who ran it sees the run
 *     fields:
 *       - name: count            # the workflow input this fills
 *         label: How many servers
 *         type: number           # text | number | select
 *         min: 1
 *         max: 6
 * ```
 */

import { parse } from "@std/yaml";
import type { Ceiling } from "./serve/client.ts";
import { SetupError } from "./setup_error.ts";

export type FieldType = "text" | "number" | "select";

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  hint?: string;
  placeholder?: string;
  initial?: string | number;
  /** for `number` */
  min?: number;
  max?: number;
  /** for `select` */
  options?: { value: string; label: string }[];
  /** for `text`: a multi-line box */
  multiline?: boolean;
}

export interface Command {
  /** with its slash, `/scale-web` */
  command: string;
  workflow: string;
  description: string;
  /** the form's title, at most 24 characters */
  title: string;
  usageHint?: string;
  report: "channel" | "dm";
  fields: Field[];
}

export interface CommandsFile {
  /** the app's own command, `/slackwater` unless the file says otherwise */
  appCommand: string;
  ceiling: Ceiling;
  commands: Command[];
}

/**
 * The app's own command, for linking, status and the generic run. Change it
 * here, or set `appCommand` in the commands file.
 */
export const DEFAULT_APP_COMMAND = "/slackwater";

export async function loadCommands(path: string): Promise<CommandsFile> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    throw new SetupError(`can't read the commands file ${path}: ${(error as Error).message}`);
  }
  return parseCommands(text, path);
}

export function parseCommands(text: string, where = "commands file"): CommandsFile {
  const problems: string[] = [];
  const doc = parse(text) as Record<string, unknown> | null;
  if (!isRecord(doc)) {
    throw new SetupError(`${where}: expected a mapping with ceiling and commands`);
  }

  const ceilingRows = Array.isArray(doc.ceiling) ? doc.ceiling : [];
  if (ceilingRows.length === 0) problems.push("ceiling: list at least one entry");
  const ceiling: Ceiling = {
    version: 1,
    ceiling: ceilingRows.map((row, i) => {
      const at = `ceiling[${i}]`;
      const actions = isRecord(row) && Array.isArray(row.actions) ? row.actions : [];
      for (const a of actions) {
        if (!["run", "read", "approve", "signal"].includes(a)) {
          problems.push(`${at}: unknown action ${JSON.stringify(a)}`);
        }
      }
      if (actions.length === 0) problems.push(`${at}: actions is empty`);
      const resource = isRecord(row) ? row.resource : undefined;
      if (typeof resource !== "string" || !resource.startsWith("workflow:")) {
        problems.push(`${at}: resource must look like workflow:<name> or workflow:@scope/*`);
      }
      return { actions, resource: String(resource) };
    }),
  };

  const commandRows = Array.isArray(doc.commands) ? doc.commands : [];
  const appCommand = typeof doc.appCommand === "string" ? doc.appCommand : DEFAULT_APP_COMMAND;
  if (!COMMAND_NAME.test(appCommand)) {
    problems.push("appCommand must be a slash and up to 31 lowercase letters, digits, - or _");
  }
  const seen = new Set<string>([appCommand]);
  const commands = commandRows.map((row, i): Command => {
    const at = `commands[${i}]`;
    const r = isRecord(row) ? row : {};
    const command = String(r.command ?? "");
    if (!COMMAND_NAME.test(command)) {
      problems.push(
        `${at}: command must be a slash and up to 31 lowercase letters, digits, - or _`,
      );
    } else if (seen.has(command)) {
      problems.push(`${at}: ${command} is listed twice, or clashes with ${appCommand}`);
    }
    seen.add(command);
    if (typeof r.workflow !== "string" || !r.workflow) problems.push(`${at}: workflow is required`);
    if (typeof r.description !== "string" || !r.description) {
      problems.push(`${at}: description is required`);
    }
    const title = typeof r.title === "string" ? r.title : command.slice(1);
    if (title.length > 24) problems.push(`${at}: title must be at most 24 characters`);
    const report = r.report ?? "channel";
    if (report !== "channel" && report !== "dm") problems.push(`${at}: report is channel or dm`);
    const fields = (Array.isArray(r.fields) ? r.fields : []).map((f, j) =>
      parseField(f, `${at}.fields[${j}]`, problems)
    );
    const names = new Set<string>();
    for (const f of fields) {
      if (names.has(f.name)) problems.push(`${at}: field ${f.name} is listed twice`);
      names.add(f.name);
    }
    return {
      command,
      workflow: String(r.workflow ?? ""),
      description: String(r.description ?? ""),
      title,
      usageHint: typeof r.usageHint === "string" ? r.usageHint : undefined,
      report,
      fields,
    } as Command;
  });

  if (problems.length > 0) {
    throw new SetupError(`${where} has problems:\n  - ${problems.join("\n  - ")}`);
  }
  return { appCommand, ceiling, commands };
}

function parseField(row: unknown, at: string, problems: string[]): Field {
  const r = isRecord(row) ? row : {};
  const name = String(r.name ?? "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) problems.push(`${at}: name must be an input name`);
  const type = (r.type ?? "text") as FieldType;
  if (!["text", "number", "select"].includes(type)) {
    problems.push(`${at}: type is text, number or select`);
  }
  const options = Array.isArray(r.options)
    ? r.options.map((o) =>
      isRecord(o)
        ? { value: String(o.value), label: String(o.label ?? o.value) }
        : { value: String(o), label: String(o) }
    )
    : undefined;
  if (type === "select" && (!options || options.length === 0)) {
    problems.push(`${at}: a select needs options`);
  }
  return {
    name,
    label: typeof r.label === "string" ? r.label : name,
    type,
    required: r.required !== false,
    hint: typeof r.hint === "string" ? r.hint : undefined,
    placeholder: typeof r.placeholder === "string" ? r.placeholder : undefined,
    initial: typeof r.initial === "string" || typeof r.initial === "number" ? r.initial : undefined,
    min: typeof r.min === "number" ? r.min : undefined,
    max: typeof r.max === "number" ? r.max : undefined,
    options,
    multiline: r.multiline === true,
  };
}

const COMMAND_NAME = /^\/[a-z0-9_-]{1,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
