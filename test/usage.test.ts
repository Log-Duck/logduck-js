// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsage } from '../src/usage.js';
import { fnv1a32, sampleKeeps } from '../src/sampling.js';

const silent = { warn: vi.fn() };

function ok(status = 204): Response {
  return new Response(null, { status });
}

interface Sent {
  key: string;
  hits: Record<string, unknown>[];
}

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Sent[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Sent);
}

describe('createUsage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(ok());
    beacon = vi.fn().mockReturnValue(true);
    silent.warn.mockClear();
    window.history.replaceState({}, '', '/pricing?utm_source=newsletter');
    document.title = 'Pricing';
    Object.defineProperty(document, 'referrer', { value: 'https://news.ycombinator.com/', configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  const make = (extra: Record<string, unknown> = {}) =>
    createUsage({ key: 'ld_test', logger: silent, fetch: fetchMock as never, sendBeacon: beacon as never, baseUrl: 'https://api.test', ...extra });

  it('records a page view on creation and posts it as a text/plain batch with the key in the body', async () => {
    const usage = make();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/usage');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');

    const [body] = sentBodies(fetchMock);
    expect(body!.key).toBe('ld_test');
    expect(body!.hits).toHaveLength(1);
    expect(body!.hits[0]).toMatchObject({
      type: 'page.view',
      path: '/pricing?utm_source=newsletter',
      host: 'localhost',
      referrer: 'https://news.ycombinator.com/',
      title: 'Pricing',
      platform: 'web',
      samplerate: 1,
    });
    expect(body!.hits[0]!.id).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof body!.hits[0]!.sessionid).toBe('string');
    usage.stop();
  });

  it('keeps one session per tab across page loads, and starts a new one after thirty idle minutes', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const first = make({ autoTrack: false, now });
    first.page({ path: '/a' });
    await vi.advanceTimersByTimeAsync(1000);
    first.stop();

    clock += 10 * 60 * 1000;
    const second = make({ autoTrack: false, now });
    second.page({ path: '/b' });
    await vi.advanceTimersByTimeAsync(1000);
    second.stop();

    clock += 31 * 60 * 1000;
    const third = make({ autoTrack: false, now });
    third.page({ path: '/c' });
    await vi.advanceTimersByTimeAsync(1000);
    third.stop();

    const [a, b, c] = sentBodies(fetchMock).map((body) => body!.hits[0]!.sessionid);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(sessionStorage.getItem('logduck.session')).toMatch(new RegExp(`^${c}:\\d+$`));
  });

  it('batches hits that arrive within the flush interval, fifty per request', async () => {
    const usage = make({ autoTrack: false });
    for (let i = 0; i < 60; i++) usage.search(`q${i}`);
    await vi.advanceTimersByTimeAsync(1000);
    const bodies = sentBodies(fetchMock);
    expect(bodies.map((b) => b.hits.length)).toEqual([50, 10]);
  });

  it('without autoTrack, a reported page ends the previous one and hiding the tab ends the last: dwell and scroll are never lost', async () => {
    const usage = make({ autoTrack: false });
    usage.page({ path: '/a' });
    vi.advanceTimersByTime(3000);
    usage.page({ path: '/b' });
    await vi.advanceTimersByTimeAsync(1000);
    fetchMock.mockClear();

    vi.advanceTimersByTime(2000);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const [sent] = beacon.mock.calls.map((call) => JSON.parse(call[1] as string) as { hits: { type: string; path: string; durationms?: number }[] });
    expect(sent!.hits.map((h) => [h.type, h.path])).toEqual([['page.leave', '/b']]);
    expect(sent!.hits[0]!.durationms).toBe(3000);
    usage.stop();
  });

  it('follows pushState and popstate: a leave for the old page, a view for the new one with the old page as referrer', async () => {
    const usage = make();
    await vi.advanceTimersByTimeAsync(1000);
    fetchMock.mockClear();

    window.scrollTo(0, 0);
    vi.advanceTimersByTime(4000);
    window.history.pushState({}, '', '/docs');
    await vi.advanceTimersByTimeAsync(1000);

    const [body] = sentBodies(fetchMock);
    expect(body!.hits.map((h) => h.type)).toEqual(['page.leave', 'page.view']);
    expect(body!.hits[0]).toMatchObject({ path: '/pricing?utm_source=newsletter', durationms: 5000 });
    expect(body!.hits[1]).toMatchObject({ path: '/docs', referrer: 'http://localhost:3000/pricing?utm_source=newsletter' });

    // Same URL again is not a navigation.
    fetchMock.mockClear();
    window.history.replaceState({}, '', '/docs');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    usage.stop();
  });

  it('sends the leave through the beacon when the page is hidden, and only once', async () => {
    const usage = make();
    await vi.advanceTimersByTimeAsync(1000);
    fetchMock.mockClear();

    vi.advanceTimersByTime(2500);
    (document as { visibilityState: string }).visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = JSON.parse(beacon.mock.calls[0]![1] as string) as Sent;
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({ type: 'page.leave', durationms: 3500, maxscrollpct: expect.any(Number) });
    usage.stop();
  });

  it('search and notFound carry the current page; search terms are capped at 100 characters', async () => {
    const usage = make({ autoTrack: false });
    usage.search('  ' + 'x'.repeat(150));
    usage.search('   ');
    usage.notFound();
    await vi.advanceTimersByTimeAsync(1000);
    const [body] = sentBodies(fetchMock);
    expect(body!.hits.map((h) => h.type)).toEqual(['site.search', 'page.notfound']);
    expect((body!.hits[0]!.term as string).length).toBe(100);
    expect(body!.hits[1]).toMatchObject({ path: '/pricing?utm_source=newsletter' });
  });

  it('attaches cleaned dimensions to every hit and drops bad keys with a warning', async () => {
    const usage = make({ autoTrack: false, dimensions: { dealer: 'oslo', Bad: 'x', long: 'y'.repeat(300) } });
    usage.page();
    await vi.advanceTimersByTimeAsync(1000);
    const [body] = sentBodies(fetchMock);
    expect(body!.hits[0]!.dimensions).toEqual({ dealer: 'oslo', long: 'y'.repeat(256) });
    expect(silent.warn).toHaveBeenCalledWith(expect.stringContaining('dimension "Bad" dropped'));
  });

  it('samples at a power-of-two rate using the same hash as the server, and stamps the rate', async () => {
    const usage = make({ autoTrack: false, sampleRate: 4 });
    for (let i = 0; i < 400; i++) usage.page({ path: `/p${i}` });
    await vi.advanceTimersByTimeAsync(1000);
    // 400 views and 399 leaves: a quarter of 799 kept, give or take the hash.
    const hits = sentBodies(fetchMock).flatMap((b) => b.hits);
    expect(hits.length).toBeGreaterThan(120);
    expect(hits.length).toBeLessThan(280);
    expect(hits.every((h) => h.samplerate === 4 && sampleKeeps(h.id as string, 4))).toBe(true);
  });

  it('refuses a rate that is not a power of two and sends everything', async () => {
    const usage = make({ autoTrack: false, sampleRate: 6 });
    usage.page();
    await vi.advanceTimersByTimeAsync(1000);
    expect(silent.warn).toHaveBeenCalledWith(expect.stringContaining('power of two'));
    expect(sentBodies(fetchMock)[0]!.hits[0]!.samplerate).toBe(1);
  });

  it('warns once per session on the first non-204, so a wrong key or origin is visible', async () => {
    fetchMock.mockResolvedValue(ok(403));
    const usage = make({ autoTrack: false });
    usage.page();
    await vi.advanceTimersByTimeAsync(1000);
    usage.page();
    await vi.advanceTimersByTimeAsync(1000);
    const warnings = silent.warn.mock.calls.filter(([m]) => String(m).includes('answered 403'));
    expect(warnings).toHaveLength(1);
  });

  it('consent and identify are no-ops that do not throw', () => {
    const usage = make({ autoTrack: false });
    expect(() => usage.consent(true)).not.toThrow();
    expect(() => usage.identify('u1')).not.toThrow();
  });

  it('stop detaches the listeners and flushes', async () => {
    const usage = make();
    usage.stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    window.history.pushState({}, '', '/after');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('sampling matches the server', () => {
  it('pins the FNV-1a reference vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
});
