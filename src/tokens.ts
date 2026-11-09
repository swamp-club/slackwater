/**
 * Hands out a linked person's access token, refreshing it first when it is
 * close to expiring.
 *
 * - Refreshes when less than a tenth of the token's life is left, and never
 *   later than five minutes before it ends.
 * - Makes one refresh at a time per person. Serve keeps the refresh token and
 *   the two previous access tokens valid, so racing refreshes would be
 *   harmless, but there's no reason to send them.
 * - A refused refresh ends the link here too, unless the reason is
 *   `not_admitted`, which can recover: the tokens are kept and the person is
 *   told serve refused them for now.
 * - If serve can't be reached, the current token is used while it still works.
 */

import { type ServeClient, ServeError } from "./serve/client.ts";
import type { Secret } from "./serve/secret.ts";
import type { LinkRecord, PersonKey, Store } from "./store.ts";

const MIN_MARGIN_MS = 5 * 60_000;
const ACCESS_TOKEN_LIFE_MS = 60 * 60_000;

export type TokenResult =
  | { ok: true; accessToken: Secret; link: LinkRecord }
  /** not linked, or the link ended (`reason` says why when serve refused) */
  | { ok: false; why: "not_linked" | "link_ended"; reason?: string }
  /** serve refused for now; the link is kept */
  | { ok: false; why: "not_admitted" }
  /** serve couldn't be reached and the token has run out */
  | { ok: false; why: "serve_unavailable" };

export class TokenKeeper {
  readonly #inflight = new Map<string, Promise<TokenResult>>();

  constructor(
    private readonly serve: ServeClient,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  async accessToken(person: PersonKey): Promise<TokenResult> {
    const link = await this.store.getLink(person);
    if (!link) return { ok: false, why: "not_linked" };
    if (link.expiresAt && Date.parse(link.expiresAt) <= this.now()) {
      await this.store.deleteLink(person);
      return { ok: false, why: "link_ended", reason: "expired" };
    }
    if (!this.#due(link)) return { ok: true, accessToken: link.accessToken, link };

    const key = `${person.teamId}/${person.userId}`;
    let refreshing = this.#inflight.get(key);
    if (!refreshing) {
      refreshing = this.#refresh(link).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, refreshing);
    }
    return refreshing;
  }

  /**
   * Serve said the access token is no good (`unauthorized`), for example after
   * a restore from backup. Refresh now, whatever the clock says.
   */
  async forceRefresh(person: PersonKey): Promise<TokenResult> {
    const link = await this.store.getLink(person);
    if (!link) return { ok: false, why: "not_linked" };
    return this.#refresh(link);
  }

  #due(link: LinkRecord): boolean {
    const expires = Date.parse(link.accessTokenExpiresAt);
    if (Number.isNaN(expires)) return true;
    const margin = Math.max(MIN_MARGIN_MS, ACCESS_TOKEN_LIFE_MS / 10);
    return expires - this.now() <= margin;
  }

  async #refresh(link: LinkRecord): Promise<TokenResult> {
    try {
      const outcome = await this.serve.refresh(link.refreshToken);
      if (outcome.status === "refreshed") {
        const updated: LinkRecord = {
          ...link,
          accessToken: outcome.accessToken,
          accessTokenExpiresAt: outcome.accessTokenExpiresAt,
          expiresAt: outcome.expiresAt ?? link.expiresAt,
        };
        await this.store.putLink(updated);
        return { ok: true, accessToken: updated.accessToken, link: updated };
      }
      if (outcome.reason === "not_admitted") return { ok: false, why: "not_admitted" };
      await this.store.deleteLink(link);
      return { ok: false, why: "link_ended", reason: outcome.reason };
    } catch (error) {
      if (!(error instanceof ServeError)) throw error;
      // Serve didn't answer properly. Keep going on the current token if it
      // still has life in it; the next call will try the refresh again.
      if (Date.parse(link.accessTokenExpiresAt) > this.now() + 5_000) {
        return { ok: true, accessToken: link.accessToken, link };
      }
      return { ok: false, why: "serve_unavailable" };
    }
  }
}
