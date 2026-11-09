/**
 * A value that must never reach a log, a Slack message or error text.
 *
 * Tokens, the integration credential, redeem secrets and consent URLs are all
 * held as `Secret`s. Printing one, interpolating it into a string or turning it
 * into JSON gives `[redacted]`. The only way to get the value is `reveal()`, so
 * a search for `reveal(` finds every place a secret leaves this type.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The real value. Call only where it goes onto the wire or into the store. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [Symbol.for("Deno.customInspect")](): string {
    return "Secret([redacted])";
  }
}
