import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogDuckClient, LogDuckError } from '../src/index.js';

/** A successful ingestion response. */
function accepted(): Response {
  return new Response(
    JSON.stringify({ success: true, eventId: 'evt_1', time: '2026-08-02T09:00:00.000Z' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function rateLimited(retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
    status: 429,
    headers: retryAfter ? { 'Retry-After': retryAfter } : {},
  });
}

const silent = { warn: () => {} };

/** Options that isolate a client from the network and the console. */
function opts(fetchImpl: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  return {
    apiKey: 'ld_test_key',
    source: 'test-suite',
    logger: silent,
    fetch: fetchImpl,
    ...extra,
  };
}

describe('LogDuckClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('the request it builds', () => {
    it('posts to /v1/events with the auth and idempotency headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue(accepted());
      const client = new LogDuckClient(opts(fetchMock));

      await client.send({ type: 'user.signup' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.logduck.com/v1/events');
      expect(init.method).toBe('POST');
      expect(init.headers['X-API-Key']).toBe('ld_test_key');
      expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('sends an Idempotency-Key the server will accept', async () => {
      // The server enforces ^[a-zA-Z0-9_-]{16,36}$ and rejects the request
      // outright without it, so this is part of the contract rather than a
      // nicety.
      const fetchMock = vi.fn().mockResolvedValue(accepted());
      const client = new LogDuckClient(opts(fetchMock));

      await client.send({ type: 'user.signup' });

      const key = fetchMock.mock.calls[0]![1].headers['Idempotency-Key'];
      expect(key).toMatch(/^[a-zA-Z0-9_-]{16,36}$/);
    });

    it('takes source from the client, not the event', async () => {
      const fetchMock = vi.fn().mockResolvedValue(accepted());
      const client = new LogDuckClient(opts(fetchMock, { source: 'checkout-api' }));

      await client.send({ type: 'order.placed' });

      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).source).toBe('checkout-api');
    });

    it('serialises a Date time to ISO 8601', async () => {
      const fetchMock = vi.fn().mockResolvedValue(accepted());
      const client = new LogDuckClient(opts(fetchMock));

      await client.send({ type: 'user.signup', time: new Date('2026-08-02T09:00:00.000Z') });

      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).time).toBe('2026-08-02T09:00:00.000Z');
    });

    it('omits absent optional fields rather than sending null', async () => {
      // The server schema is nullish() so null would pass, but omitting keeps
      // the payload honest about what the caller actually set.
      const fetchMock = vi.fn().mockResolvedValue(accepted());
      const client = new LogDuckClient(opts(fetchMock));

      await client.send({ type: 'user.signup' });

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(body).not.toHaveProperty('subject');
      expect(body).not.toHaveProperty('emoji');
    });
  });

  describe('validation', () => {
    it('rejects an empty type without touching the network', async () => {
      const fetchMock = vi.fn();
      const client = new LogDuckClient(opts(fetchMock));

      expect(await client.send({ type: '  ' })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['type', { type: 'a'.repeat(101) }],
      ['subject', { type: 'ok', subject: 'a'.repeat(501) }],
      ['sessionId', { type: 'ok', sessionId: 'a'.repeat(257) }],
      ['emoji', { type: 'ok', emoji: 'a'.repeat(11) }],
    ])('rejects an over-long %s', async (_field, event) => {
      const fetchMock = vi.fn();
      const client = new LogDuckClient(opts(fetchMock));

      expect(await client.send(event)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('flags an API key without the ld_ prefix', () => {
      const client = new LogDuckClient(opts(vi.fn(), { apiKey: 'oops' }));

      expect(client.validateConfiguration()).toBe(false);
    });

    it('accepts a well-formed configuration', () => {
      expect(new LogDuckClient(opts(vi.fn())).validateConfiguration()).toBe(true);
    });
  });

  describe('failure handling', () => {
    it('returns null instead of throwing by default', async () => {
      // A logging SDK must not take down the code it was meant to observe.
      const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
      const client = new LogDuckClient(opts(fetchMock));

      expect(await client.send({ type: 'user.signup' })).toBeNull();
    });

    it('throws when throwOnError is set', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
      const client = new LogDuckClient(opts(fetchMock, { throwOnError: true }));

      await expect(client.send({ type: 'user.signup' })).rejects.toThrow(LogDuckError);
    });

    it('does not retry a 4xx', async () => {
      // A validation error will fail identically the second time; retrying it
      // only doubles the load.
      const fetchMock = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));
      const client = new LogDuckClient(opts(fetchMock));

      await client.send({ type: 'user.signup' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 5xx once and succeeds', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('boom', { status: 503 }))
        .mockResolvedValueOnce(accepted());
      const client = new LogDuckClient(opts(fetchMock));

      const promise = client.send({ type: 'user.signup' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(await promise).toMatchObject({ success: true, eventId: 'evt_1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a network failure once', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(accepted());
      const client = new LogDuckClient(opts(fetchMock));

      const promise = client.send({ type: 'user.signup' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(await promise).toMatchObject({ success: true });
    });

    it('reuses the same Idempotency-Key across a retry', async () => {
      // This is what makes retrying safe: the server deduplicates on the key,
      // so a retry after a timeout cannot double-post the event.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('boom', { status: 503 }))
        .mockResolvedValueOnce(accepted());
      const client = new LogDuckClient(opts(fetchMock));

      const promise = client.send({ type: 'user.signup' });
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      const first = fetchMock.mock.calls[0]![1].headers['Idempotency-Key'];
      const second = fetchMock.mock.calls[1]![1].headers['Idempotency-Key'];
      expect(second).toBe(first);
    });

    it('sends exactly once when retries are disabled', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
      const client = new LogDuckClient(opts(fetchMock, { retryEnabled: false }));

      expect(await client.send({ type: 'user.signup' })).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate limits', () => {
    it('waits for Retry-After and retries when it is within the cap', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(rateLimited('2'))
        .mockResolvedValueOnce(accepted());
      const client = new LogDuckClient(opts(fetchMock));

      const promise = client.send({ type: 'user.signup' });
      await vi.advanceTimersByTimeAsync(2000);

      expect(await promise).toMatchObject({ success: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up immediately when Retry-After exceeds maxRetryDelay', async () => {
      // The server rate-limits in one-minute windows, so Retry-After can be
      // 60s. Blocking a caller that long is worse than dropping the event.
      const fetchMock = vi.fn().mockResolvedValue(rateLimited('45'));
      const client = new LogDuckClient(opts(fetchMock, { throwOnError: true }));

      await expect(client.send({ type: 'user.signup' })).rejects.toMatchObject({
        status: 429,
        retryAfterMs: 45_000,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces retryAfterMs so the caller can queue the event', async () => {
      const fetchMock = vi.fn().mockResolvedValue(rateLimited('30'));
      const client = new LogDuckClient(opts(fetchMock, { throwOnError: true }));

      const error = await client.send({ type: 'user.signup' }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LogDuckError);
      expect((error as LogDuckError).retryAfterMs).toBe(30_000);
    });

    it('assumes a full window when Retry-After is missing', async () => {
      // Retrying immediately would add load to a server that just asked us to
      // back off, so the unparseable case must not round down to zero.
      const fetchMock = vi.fn().mockResolvedValue(rateLimited());
      const client = new LogDuckClient(opts(fetchMock, { throwOnError: true }));

      await expect(client.send({ type: 'user.signup' })).rejects.toMatchObject({
        retryAfterMs: 60_000,
      });
    });

    it('understands an HTTP-date Retry-After', async () => {
      // The spec allows either delta-seconds or an HTTP-date; treating the
      // date form as unparseable would round the wait down to the 60s
      // fallback and drop events that were only seconds from being sendable.
      // 45s is past the cap, so this asserts the parse without waiting.
      vi.setSystemTime(new Date('2026-08-02T09:00:00.000Z'));
      const fetchMock = vi.fn().mockResolvedValue(rateLimited('Sun, 02 Aug 2026 09:00:45 GMT'));
      const client = new LogDuckClient(opts(fetchMock, { throwOnError: true }));

      await expect(client.send({ type: 'user.signup' })).rejects.toMatchObject({
        retryAfterMs: 45_000,
      });
    });
  });
});
