/**
 * A stand-in for swamp serve's integration routes, listening on a free local
 * port. Each test scripts the replies it needs and reads back what was sent.
 */

export interface RecordedCall {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** wait this long before answering */
  delayMs?: number;
  /** answer with this raw text instead of JSON */
  raw?: string;
}

type Handler = (call: RecordedCall) => Reply | Promise<Reply>;

export class MockServe {
  readonly calls: RecordedCall[] = [];
  readonly #handlers = new Map<string, Handler>();
  readonly #server: Deno.HttpServer<Deno.NetAddr>;
  readonly #pending = new Set<AbortController>();

  constructor() {
    this.#server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => this.#handle(req),
    );
  }

  get url(): string {
    return `http://127.0.0.1:${this.#server.addr.port}`;
  }

  /** Answer calls to `path` (for actions, `action:<type>`) with `handler`. */
  on(path: string, handler: Handler | Reply): this {
    this.#handlers.set(path, typeof handler === "function" ? handler : () => handler);
    return this;
  }

  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  async close(): Promise<void> {
    for (const controller of this.#pending) controller.abort();
    await this.#server.shutdown();
  }

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      // leave empty
    }
    const call = { path: url.pathname, authorization: req.headers.get("authorization"), body };
    this.calls.push(call);
    const key = url.pathname === "/api/v1/action" ? `action:${String(body.type)}` : url.pathname;
    const handler = this.#handlers.get(key);
    if (!handler) {
      return Response.json({ code: "not_found", message: `no mock for ${key}` }, { status: 404 });
    }
    const reply = await handler(call);
    if (reply.delayMs) {
      const controller = new AbortController();
      this.#pending.add(controller);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, reply.delayMs);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.#pending.delete(controller);
    }
    const headers = { "content-type": "application/json", ...reply.headers };
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers,
    });
  }
}

/** The action route's success shape. */
export function actionOk(type: string, data: unknown): Reply {
  return { status: 200, body: { requestId: "req-1", type, data } };
}

export function failure(status: number, code: string, extra: Record<string, unknown> = {}): Reply {
  return { status, body: { code, message: `mock ${code}`, ...extra } };
}

// Token-shaped values. Long and distinctive so a leak check can search for them.
export const CREDENTIAL = "swi1.slackwater-test." + "a1".repeat(32);
export const ACCESS_TOKEN = "swda1.dlg-1." + "b2".repeat(32);
export const ACCESS_TOKEN_2 = "swda1.dlg-1." + "c3".repeat(32);
export const REFRESH_TOKEN = "swdr1.dlg-1." + "d4".repeat(32);
export const REDEEM_SECRET = "swdx1.pend-1." + "e5".repeat(32);
export const CONSENT_URL = "https://swamp-club.example/consent/" + "f6".repeat(16);
export const ALL_SECRETS = [
  CREDENTIAL,
  ACCESS_TOKEN,
  ACCESS_TOKEN_2,
  REFRESH_TOKEN,
  REDEEM_SECRET,
  CONSENT_URL,
];
