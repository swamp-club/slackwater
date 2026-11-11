/**
 * Where Slackwater keeps what it must remember between restarts: each linked
 * person's tokens, links waiting for consent, and runs it is following.
 *
 * `Store` is the interface. Two implementations come with the app:
 * `MemoryStore` for tests, and `EncryptedFileStore`, which writes one file
 * encrypted with AES-256-GCM under `SLACKWATER_STORE_KEY`. A deployment that
 * runs more than one copy of the app needs a shared store instead (a database
 * or a secrets service); write one against this interface.
 */

import { Secret } from "./serve/secret.ts";
import { SetupError } from "./setup_error.ts";

/** A Slack person: their workspace and user id. */
export interface PersonKey {
  teamId: string;
  userId: string;
}

export interface LinkRecord extends PersonKey {
  delegationId: string;
  accessToken: Secret;
  accessTokenExpiresAt: string;
  refreshToken: Secret;
  expiresAt?: string;
  /** the swamp-club username serve reported, shown to the person */
  username?: string;
  linkedAt: string;
}

export interface PendingLinkRecord extends PersonKey {
  pendingId: string;
  redeemSecret: Secret;
  /** stop polling after this (ms since epoch) */
  giveUpAt: number;
  /** seconds between redeem polls, as serve asked */
  interval: number;
  /** the Slack email sent with the link, to compare with the account that agreed */
  email?: string;
}

export interface WatchedRunRecord {
  runId: string;
  workflowName: string;
  /** who started it; their token is used to follow it */
  starter: PersonKey;
  /** where the status message is */
  channel: string;
  ts: string;
  /** the last status shown, so the message is only updated on change */
  lastShown: string;
  startedAt: number;
  /** the command's own description of the run, for the message header */
  title: string;
}

export interface Store {
  getLink(person: PersonKey): Promise<LinkRecord | undefined>;
  putLink(link: LinkRecord): Promise<void>;
  deleteLink(person: PersonKey): Promise<void>;

  getPending(person: PersonKey): Promise<PendingLinkRecord | undefined>;
  listPending(): Promise<PendingLinkRecord[]>;
  putPending(pending: PendingLinkRecord): Promise<void>;
  deletePending(person: PersonKey): Promise<void>;

  listRuns(): Promise<WatchedRunRecord[]>;
  putRun(run: WatchedRunRecord): Promise<void>;
  deleteRun(runId: string): Promise<void>;
}

const personId = (p: PersonKey) => `${p.teamId}/${p.userId}`;

interface State {
  links: Record<string, LinkRecord>;
  pending: Record<string, PendingLinkRecord>;
  runs: Record<string, WatchedRunRecord>;
}

/** Keeps everything in memory. For tests, and for trying the app out. */
export class MemoryStore implements Store {
  protected state: State = { links: {}, pending: {}, runs: {} };

  /** called after every change; the file store saves here */
  protected changed(): Promise<void> {
    return Promise.resolve();
  }

  getLink(p: PersonKey) {
    return Promise.resolve(this.state.links[personId(p)]);
  }
  putLink(link: LinkRecord) {
    this.state.links[personId(link)] = link;
    return this.changed();
  }
  deleteLink(p: PersonKey) {
    delete this.state.links[personId(p)];
    return this.changed();
  }
  getPending(p: PersonKey) {
    return Promise.resolve(this.state.pending[personId(p)]);
  }
  listPending() {
    return Promise.resolve(Object.values(this.state.pending));
  }
  putPending(pending: PendingLinkRecord) {
    this.state.pending[personId(pending)] = pending;
    return this.changed();
  }
  deletePending(p: PersonKey) {
    delete this.state.pending[personId(p)];
    return this.changed();
  }
  listRuns() {
    return Promise.resolve(Object.values(this.state.runs));
  }
  putRun(run: WatchedRunRecord) {
    this.state.runs[run.runId] = run;
    return this.changed();
  }
  deleteRun(runId: string) {
    delete this.state.runs[runId];
    return this.changed();
  }
}

/**
 * One encrypted file, `<dir>/store.enc`. The folder is made readable by this
 * user only, and each save writes a new file and renames it into place, so a
 * crash never leaves half a file.
 */
export class EncryptedFileStore extends MemoryStore {
  readonly #path: string;
  readonly #dir: string;
  readonly #key: CryptoKey;
  #saving: Promise<void> = Promise.resolve();

  private constructor(dir: string, key: CryptoKey) {
    super();
    this.#dir = dir;
    this.#path = `${dir}/store.enc`;
    this.#key = key;
  }

  /** `keyBase64` is 32 random bytes, base64 encoded (`openssl rand -base64 32`). */
  static async open(dir: string, keyBase64: Secret): Promise<EncryptedFileStore> {
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = Uint8Array.from(atob(keyBase64.reveal()), (c) => c.charCodeAt(0));
    } catch {
      throw new SetupError("SLACKWATER_STORE_KEY is not valid base64");
    }
    if (raw.length !== 32) {
      throw new SetupError("SLACKWATER_STORE_KEY must be 32 bytes, base64 encoded");
    }
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    await Deno.chmod(dir, 0o700).catch(() => {});
    const store = new EncryptedFileStore(dir, key);
    await store.#load();
    return store;
  }

  async #load() {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await Deno.readFile(this.#path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) },
        this.#key,
        bytes.slice(12),
      );
    } catch {
      throw new SetupError(
        `can't decrypt ${this.#path}: SLACKWATER_STORE_KEY isn't the key it was written with`,
      );
    }
    this.state = JSON.parse(
      new TextDecoder().decode(plain),
      (key, value) =>
        SECRET_FIELDS.has(key) && typeof value === "string" ? new Secret(value) : value,
    );
  }

  protected override changed(): Promise<void> {
    this.#saving = this.#saving.then(() => this.#save(), () => this.#save());
    return this.#saving;
  }

  async #save() {
    // Secret.toJSON redacts, and JSON.stringify calls it before any replacer,
    // so reveal the secrets in a copy first. This is the only place they are
    // written down, and the result is encrypted before it touches the disk.
    const json = JSON.stringify(reveal(this.state));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.#key,
      new TextEncoder().encode(json),
    );
    const out = new Uint8Array(12 + sealed.byteLength);
    out.set(iv);
    out.set(new Uint8Array(sealed), 12);
    const tmp = `${this.#dir}/.store.enc.${crypto.randomUUID()}`;
    await Deno.writeFile(tmp, out, { mode: 0o600 });
    await Deno.rename(tmp, this.#path);
  }
}

const SECRET_FIELDS = new Set(["accessToken", "refreshToken", "redeemSecret"]);

function reveal(value: unknown): unknown {
  if (value instanceof Secret) return value.reveal();
  if (Array.isArray(value)) return value.map(reveal);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reveal(v)]));
  }
  return value;
}
