import { LogDuckError } from './errors.js';
import type {
  LogDuckEvent,
  LogDuckLogger,
  LogDuckOptions,
  LogDuckResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.logduck.com';

/**
 * Replaced with the package version at build time (see tsup.config.ts).
 * `typeof` rather than a bare reference so running straight from source — in
 * the test suite, say — does not throw a ReferenceError.
 */
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

/** Delay before retrying a 5xx or a network failure. */
const TRANSIENT_RETRY_MS = 1000;

/**
 * The server rate-limits in fixed one-minute windows, so a missing or
 * unparseable `Retry-After` cannot mean less than a full window. Assume the
 * maximum rather than retrying immediately and adding load to a server that
 * just asked us to back off.
 */
const RETRY_AFTER_FALLBACK_MS = 60_000;

const LIMITS = {
  type: 100,
  source: 200,
  subject: 500,
  sessionId: 256,
  message: 500,
  emoji: 10,
} as const;

/**
 * Sends events to LogDuck.
 *
 * ```ts
 * const logduck = new LogDuckClient({ apiKey: 'ld_...', source: 'checkout-api' });
 * await logduck.send({ type: 'order.placed', subject: 'order_9127' });
 * ```
 *
 * One instance per process is enough — it holds no connection state.
 */
export class LogDuckClient {
  private readonly apiKey: string;
  private readonly source: string;
  private readonly throwOnError: boolean;
  private readonly retryEnabled: boolean;
  private readonly maxRetryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly logger: LogDuckLogger;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly userAgent: string;

  constructor(options: LogDuckOptions) {
    this.apiKey = options.apiKey ?? '';
    this.source = options.source ?? '';
    this.throwOnError = options.throwOnError ?? false;
    this.retryEnabled = options.retryEnabled ?? true;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.logger = options.logger ?? console;
    this.userAgent = `LogDuck-JS/${VERSION}`;

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new LogDuckError(
        'No fetch implementation available. LogDuck needs Node 18+ or an explicit `fetch` option.'
      );
    }
    // Unbound `globalThis.fetch` throws "Illegal invocation" in browsers.
    this.fetchImpl = fetchImpl.bind(globalThis);

    if (!this.apiKey) this.warn('LogDuck API key is not configured - all requests will fail');
    if (!this.source) this.warn('LogDuck source is not configured - all requests will fail');
  }

  /**
   * Checks the configuration without sending anything. Returns false and logs
   * a warning for each problem, so it is useful as a startup assertion.
   */
  validateConfiguration(): boolean {
    let valid = true;

    if (!this.apiKey) {
      this.warn('LogDuck validation failed: API key is not configured');
      valid = false;
    } else if (!this.apiKey.startsWith('ld_')) {
      this.warn("LogDuck validation failed: API key must start with 'ld_'");
      valid = false;
    }

    if (!this.source) {
      this.warn('LogDuck validation failed: source is not configured');
      valid = false;
    } else if (this.source.length > LIMITS.source) {
      this.warn(`LogDuck validation failed: source exceeds ${LIMITS.source} characters`);
      valid = false;
    }

    return valid;
  }

  /**
   * Sends one event.
   *
   * Resolves to the created event, or to `null` when the send failed and
   * `throwOnError` is off (the default).
   */
  async send(event: LogDuckEvent): Promise<LogDuckResponse | null> {
    const validationError = this.validateEvent(event);
    if (validationError) {
      return this.fail(new LogDuckError(validationError, { status: 400 }), validationError);
    }

    // One key for the whole call, reused across retries: that is what makes a
    // retry safe, since the server deduplicates on it.
    const idempotencyKey = randomKey();
    const payload = {
      type: event.type,
      source: this.source,
      subject: event.subject,
      // The wire name is lowercase: a CloudEvents extension attribute name
      // must be lowercase alphanumeric, and the server discards anything it
      // does not recognise rather than erroring.
      sessionid: event.sessionId,
      message: event.message,
      time: event.time instanceof Date ? event.time.toISOString() : event.time,
      data: event.data,
      emoji: event.emoji,
    };

    const maxAttempts = this.retryEnabled ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;

      try {
        response = await this.post(payload, idempotencyKey);
      } catch (cause) {
        // Network failure or timeout.
        const message = cause instanceof Error ? cause.message : String(cause);
        if (attempt < maxAttempts) {
          this.warn(`LogDuck request failed (${message}), retrying...`);
          await sleep(TRANSIENT_RETRY_MS);
          continue;
        }
        return this.fail(
          new LogDuckError(`${message} (after ${maxAttempts} attempts)`, { cause }),
          `LogDuck event failed after ${maxAttempts} attempts: ${message}`
        );
      }

      const body = await response.text().catch(() => '');

      if (response.ok) {
        try {
          return JSON.parse(body) as LogDuckResponse;
        } catch (cause) {
          return this.fail(
            new LogDuckError('Failed to parse response', {
              status: response.status,
              body,
              cause,
            }),
            'LogDuck event failed: could not parse response'
          );
        }
      }

      // 429 is the one 4xx worth retrying: the server tells us when its window
      // resets, and the unchanged Idempotency-Key makes the retry safe.
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

        if (attempt < maxAttempts && retryAfterMs <= this.maxRetryDelayMs) {
          this.warn(`LogDuck rate limited, retrying in ${Math.round(retryAfterMs / 1000)}s...`);
          await sleep(retryAfterMs);
          continue;
        }

        // Out of attempts, or the wait is longer than a caller should be
        // blocked for. Surface retryAfterMs so the event can be queued.
        return this.fail(
          new LogDuckError(
            `Rate limit exceeded. Retry after ${Math.round(retryAfterMs / 1000)}s.`,
            { status: 429, body, retryAfterMs }
          ),
          `LogDuck event dropped: rate limit exceeded, retry after ${Math.round(retryAfterMs / 1000)}s`
        );
      }

      // Any other 4xx is our fault and will fail again identically.
      if (response.status >= 400 && response.status < 500) {
        const message = clientErrorMessage(response.status);
        return this.fail(
          new LogDuckError(message, { status: response.status, body }),
          `LogDuck event failed: ${message}`
        );
      }

      if (attempt < maxAttempts) {
        this.warn(`LogDuck request failed with status ${response.status}, retrying...`);
        await sleep(TRANSIENT_RETRY_MS);
        continue;
      }

      return this.fail(
        new LogDuckError(
          `Request failed with status ${response.status} after ${maxAttempts} attempts`,
          { status: response.status, body }
        ),
        `LogDuck event failed after ${maxAttempts} attempts`
      );
    }

    /* c8 ignore next -- unreachable: every path above returns or continues */
    return null;
  }

  private post(payload: unknown, idempotencyKey: string): Promise<Response> {
    // AbortSignal.timeout would be neater but is not in Node 18.0-18.13.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    return this.fetchImpl(`${this.baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
        'Idempotency-Key': idempotencyKey,
        'User-Agent': this.userAgent,
      },
      // undefined-valued keys drop out here, which is what the API expects for
      // an omitted optional field.
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  }

  private validateEvent(event: LogDuckEvent): string | null {
    if (!event?.type?.trim()) return 'type is required';
    if (event.type.length > LIMITS.type) return `type exceeds ${LIMITS.type} characters`;
    if (!this.source) return 'source is not configured';
    if (this.source.length > LIMITS.source) return `source exceeds ${LIMITS.source} characters`;
    if ((event.subject?.length ?? 0) > LIMITS.subject)
      return `subject exceeds ${LIMITS.subject} characters`;
    if ((event.sessionId?.length ?? 0) > LIMITS.sessionId)
      return `sessionId exceeds ${LIMITS.sessionId} characters`;
    if ((event.message?.length ?? 0) > LIMITS.message)
      return `message exceeds ${LIMITS.message} characters`;
    if ((event.emoji?.length ?? 0) > LIMITS.emoji)
      return `emoji exceeds ${LIMITS.emoji} characters`;
    return null;
  }

  /** Throw or warn-and-return-null, depending on `throwOnError`. */
  private fail(error: LogDuckError, warning: string): null {
    if (this.throwOnError) throw error;
    this.warn(warning, error);
    return null;
  }

  private warn(message: string, error?: unknown): void {
    if (error) this.logger.warn(`[LogDuck] ${message}`, error);
    else this.logger.warn(`[LogDuck] ${message}`);
  }
}

/**
 * The server requires 16-36 characters of `[A-Za-z0-9_-]`. A UUID is 36 with
 * hyphens, so it fits exactly.
 */
function randomKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Node 18 without a global crypto, and older browsers over plain HTTP.
  let key = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    key += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return key;
}

/** Handles both forms the spec allows: delta-seconds and an HTTP-date. */
function parseRetryAfter(header: string | null): number {
  if (!header) return RETRY_AFTER_FALLBACK_MS;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return RETRY_AFTER_FALLBACK_MS;
}

function clientErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Validation error';
    case 401:
      return 'Invalid API key';
    case 403:
      return 'API key expired or unauthorized';
    default:
      return `Request failed with status ${status}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
