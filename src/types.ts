/** An event to send to LogDuck. */
export interface LogDuckEvent {
  /**
   * What happened, e.g. `user.signup` (required, max 100 characters).
   *
   * The server lowercases this and requires it to match
   * `^[a-z][a-z0-9_.]*$` — letters, digits, underscores and dots, starting
   * with a letter. A hyphen is rejected with a 400.
   */
  type: string;
  /** The resource the event is about, e.g. a user or order id (max 500). */
  subject?: string;
  /** Groups related events within a session (max 256). */
  sessionId?: string;
  /** When it happened. Defaults to server time if unset. */
  time?: Date | string;
  /** Arbitrary JSON payload. */
  data?: Record<string, unknown>;
  /** Shown alongside the event in the dashboard (max 10 characters). */
  emoji?: string;
}

/** What the API returns for an accepted event. */
export interface LogDuckResponse {
  success: boolean;
  eventId: string;
  time: string;
}

/**
 * Anything with a `warn` method — `console` satisfies it, as do pino, winston
 * and bunyan.
 */
export interface LogDuckLogger {
  warn(message: string, ...args: unknown[]): void;
}

/** Configuration for {@link LogDuckClient}. */
export interface LogDuckOptions {
  /** Your LogDuck API key (required). Must start with `ld_`. */
  apiKey: string;
  /**
   * Identifies the app or service sending events (required, max 200).
   * Set once at construction; it is attached to every event.
   */
  source: string;
  /**
   * When false (the default) errors are logged and `send` resolves to `null`.
   * When true they reject with a {@link LogDuckError}.
   *
   * The default is deliberate: a logging SDK that throws can take down the
   * code it was only meant to observe.
   */
  throwOnError?: boolean;
  /**
   * Retry once on transient failures — 5xx, network errors and rate limits.
   * Default true.
   */
  retryEnabled?: boolean;
  /**
   * Longest the client will wait before retrying a rate-limited (429)
   * request. Default 10 seconds.
   *
   * The server rate-limits per API key in fixed one-minute windows, so its
   * `Retry-After` can be as much as 60 seconds. Blocking a caller that long
   * is rarely acceptable, so when `Retry-After` exceeds this cap the client
   * gives up immediately. The failure carries {@link LogDuckError.retryAfterMs}
   * so the application can queue the event instead of losing it.
   */
  maxRetryDelayMs?: number;
  /** Request timeout in milliseconds. Default 30 seconds. */
  timeoutMs?: number;
  /** API base URL. Override only for a self-hosted deployment or in tests. */
  baseUrl?: string;
  /** Where warnings go. Defaults to `console`. */
  logger?: LogDuckLogger;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}
