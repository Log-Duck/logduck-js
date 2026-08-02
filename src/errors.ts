/**
 * Raised when a request fails and `throwOnError` is enabled, and attached to
 * the warning logged when it is not.
 */
export class LogDuckError extends Error {
  /** HTTP status, or undefined when the request never got a response. */
  readonly status?: number;
  /** Raw response body, when there was one. */
  readonly body?: string;
  /**
   * Set on a 429: how long the server asked us to wait, in milliseconds.
   *
   * Present so the application can queue the event and send it later rather
   * than drop it — the client itself refuses to block for a full rate-limit
   * window.
   */
  readonly retryAfterMs?: number;
  /** The underlying network or parse failure, when there was one. */
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      status?: number;
      body?: string;
      retryAfterMs?: number;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'LogDuckError';
    this.status = options.status;
    this.body = options.body;
    this.retryAfterMs = options.retryAfterMs;
    this.cause = options.cause;

    // Without this, `instanceof LogDuckError` is false when the package is
    // consumed as CommonJS compiled down to ES5.
    Object.setPrototypeOf(this, LogDuckError.prototype);
  }
}
