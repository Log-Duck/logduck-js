import { isPowerOfTwo, sampleKeeps } from './sampling.js';
import type { LogDuckLogger } from './types.js';

/**
 * Replaced with the package version at build time (see tsup.config.ts).
 */
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

const DEFAULT_BASE_URL = 'https://api.logduck.com';
/** The server accepts at most this many hits per request. */
const HITS_PER_REQUEST = 50;
/** Hits waiting in memory before the oldest are dropped. There is no storage in anonymous mode. */
const DEFAULT_QUEUE_LIMIT = 200;
const DEFAULT_FLUSH_MS = 1000;
/** Largest rate the server accepts, and the largest a page could usefully sample at. */
const SAMPLE_RATE_MAX = 1024;
const DIMENSION_KEYS_MAX = 10;
const DIMENSION_VALUE_MAX = 256;
const DIMENSION_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** Configuration for {@link createUsage}. */
export interface UsageOptions {
  /** A **client** key (`ld_...`), created for this site in the dashboard with its origins listed. */
  key: string;
  /** API base URL. Override only for a self-hosted deployment or in tests. */
  baseUrl?: string;
  /**
   * Record a `page.view` on creation and on every `history.pushState`, `replaceState` and
   * `popstate`, and a `page.leave` when the page is hidden. Default true. Turn it off for a
   * router the SDK cannot see and call {@link Usage.page} yourself.
   */
  autoTrack?: boolean;
  /**
   * Send one hit in N, N a power of two up to 1,024. Default 1 (everything). The environment
   * must allow it (its *max client sample rate* setting, off by default), or the server refuses
   * the hits: a public key plus a client-chosen rate would otherwise let anyone inflate counts.
   * Hits that are sent carry the rate and the dashboard weights them back up.
   */
  sampleRate?: number;
  /**
   * Attached to every hit: at most ten lowercase keys (`dealer`, `section`, `variant`) with
   * string values of at most 256 characters. Never an identifier — the server refuses keys
   * named like one.
   */
  dimensions?: Record<string, string>;
  /** The hostname to report. Defaults to `location.hostname`. */
  host?: string;
  /** Where warnings go. Defaults to `console`. */
  logger?: LogDuckLogger;
  /** How long hits wait to be batched before a flush. Default one second. */
  flushIntervalMs?: number;
  /** Injected for tests. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to `navigator.sendBeacon`. */
  sendBeacon?: (url: string, body: string) => boolean;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface PageOptions {
  /** Path with its query string, e.g. `/pricing?utm_source=newsletter`. Defaults to the current location. */
  path?: string;
  /** Defaults to `document.referrer` on the first view, then to the previous page. */
  referrer?: string;
  /** Defaults to `document.title`. */
  title?: string;
}

/** The usage surface: how people move through the site. Hits are never events (no push, no webhooks). */
export interface Usage {
  /** Records a page view. Called for you when `autoTrack` is on. */
  page(options?: PageOptions): void;
  /** Records that the current page was a 404. */
  notFound(options?: PageOptions): void;
  /** Records a site search. Stored only if the environment has search terms switched on. */
  search(term: string, options?: PageOptions): void;
  /** Replaces the dimensions attached to every later hit. */
  setDimensions(dimensions: Record<string, string>): void;
  /**
   * Consented mode is not yet available: this does nothing today, and will mint the visitor
   * ID once the server supports identity collection. Safe to call now so the integration does
   * not change later.
   */
  consent(granted: boolean): void;
  /** See {@link Usage.consent}: a no-op until identity collection exists. */
  identify(userId: string): void;
  /** Sends whatever is queued now. */
  flush(): void;
  /** Detaches the listeners `autoTrack` installed and sends what is queued. */
  stop(): void;
}

/** One hit on the wire: flat lowercase CloudEvents attributes, as the server's schema names them. */
interface Hit {
  id: string;
  type: 'page.view' | 'page.leave' | 'page.notfound' | 'site.search';
  time: string;
  path: string;
  host?: string;
  referrer?: string;
  title?: string;
  sessionid: string;
  platform: 'web';
  sdkversion: string;
  durationms?: number;
  maxscrollpct?: number;
  term?: string;
  dimensions?: Record<string, string>;
  samplerate: number;
}

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/** Inert: every method a no-op. What a server-rendered page or a worker gets. */
function inert(): Usage {
  const nothing = (): void => {};
  return { page: nothing, notFound: nothing, search: nothing, setDimensions: nothing, consent: nothing, identify: nothing, flush: nothing, stop: nothing };
}

/**
 * Creates the usage tracker for this page.
 *
 * ```ts
 * import { createUsage } from 'logduck/usage';
 * const usage = createUsage({ key: 'ld_...' });   // page views start now
 * usage.search('duck');
 * ```
 *
 * Anonymous by design: nothing is stored on the device, no cookie, no fingerprint — so no
 * banner is needed for it. The session id lives for the page load and the queue in memory.
 * Without a `document` (server rendering) every method is a no-op.
 */
export function createUsage(options: UsageOptions): Usage {
  if (typeof document === 'undefined' || typeof window === 'undefined') return inert();

  const logger = options.logger ?? console;
  const warn = (message: string): void => logger.warn(`LogDuck usage: ${message}`);
  const now = options.now ?? Date.now;
  const url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/usage`;
  const flushMs = options.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  const fetchImpl = options.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
  const beacon = options.sendBeacon ?? (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
    ? (target: string, body: string) => navigator.sendBeacon(target, body)
    : undefined);

  if (!options.key) warn('no key configured - every request will be refused');

  let sampleRate = options.sampleRate ?? 1;
  if (!isPowerOfTwo(sampleRate) || sampleRate > SAMPLE_RATE_MAX) {
    warn(`sampleRate must be a power of two up to ${SAMPLE_RATE_MAX}; sending everything`);
    sampleRate = 1;
  }

  let dimensions = cleanDimensions(options.dimensions, warn);
  // One id per page load, held in memory: the server joins loads into sessions itself, from a
  // key that rotates daily, so nothing is stored on or read from the device.
  const sessionid = randomId();
  const queue: Hit[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warnedOnce = false;
  let stopped = false;

  // The page in progress, for page.leave.
  let currentPath: string | undefined;
  let currentHref: string | undefined;
  let viewStartedAt = now();
  let maxScroll = 0;
  let leaveSent = false;

  function hostname(): string | undefined {
    return options.host ?? (location.hostname || undefined);
  }

  function enqueue(hit: Omit<Hit, 'id' | 'time' | 'sessionid' | 'platform' | 'sdkversion' | 'samplerate'>): void {
    if (stopped) return;
    const id = randomId();
    if (!sampleKeeps(id, sampleRate)) return;
    const full: Hit = { id, time: new Date(now()).toISOString(), sessionid, platform: 'web', sdkversion: VERSION, samplerate: sampleRate, ...hit };
    if (dimensions && !full.dimensions) full.dimensions = dimensions;
    queue.push(full);
    if (queue.length > DEFAULT_QUEUE_LIMIT) queue.splice(0, queue.length - DEFAULT_QUEUE_LIMIT);
    if (queue.length >= HITS_PER_REQUEST) flush('batch');
    else if (!timer) timer = setTimeout(() => flush('timer'), flushMs);
  }

  /**
   * A beacon is what survives the page going away, so unload flushes use it. Everything else
   * goes through fetch with keepalive, which is the one path that can see the response: the
   * first non-204 of the session is warned once, so a wrong key or an unlisted origin is
   * visible in the console rather than silently counted as nothing.
   */
  function flush(reason: 'batch' | 'timer' | 'hide' | 'manual'): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (queue.length > 0) {
      const batch = queue.splice(0, HITS_PER_REQUEST);
      const body = JSON.stringify({ key: options.key, hits: batch });
      if (reason === 'hide' && beacon && beacon(url, body)) continue;
      if (!fetchImpl) {
        if (beacon) beacon(url, body);
        continue;
      }
      fetchImpl(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } })
        .then((response) => {
          if (response.status !== 204 && !warnedOnce) {
            warnedOnce = true;
            warn(`the server answered ${response.status}; hits from this page are not being recorded`);
          }
        })
        .catch(() => {
          // Network failures are the beacon's problem too; there is nothing a page can do.
        });
    }
  }

  function pathOf(options?: PageOptions): string {
    return options?.path ?? `${location.pathname}${location.search}`;
  }

  function leave(): void {
    if (currentPath === undefined || leaveSent) return;
    leaveSent = true;
    enqueue({
      type: 'page.leave',
      path: currentPath,
      host: hostname(),
      durationms: Math.max(0, now() - viewStartedAt),
      maxscrollpct: Math.round(maxScroll),
    });
  }

  function view(type: 'page.view' | 'page.notfound', pageOptions?: PageOptions): void {
    const path = pathOf(pageOptions);
    const referrer = pageOptions?.referrer ?? (currentHref ?? (document.referrer || undefined));
    enqueue({ type, path, host: hostname(), referrer: referrer || undefined, title: pageOptions?.title ?? (document.title || undefined) });
    currentPath = path;
    currentHref = location.href;
    viewStartedAt = now();
    maxScroll = scrollPercent();
    leaveSent = false;
  }

  function scrollPercent(): number {
    const doc = document.documentElement;
    const total = Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0);
    if (!total) return 0;
    return Math.min(100, ((window.scrollY + window.innerHeight) / total) * 100);
  }

  const onScroll = (): void => {
    maxScroll = Math.max(maxScroll, scrollPercent());
  };
  const onHide = (): void => {
    if (document.visibilityState === 'hidden') {
      leave();
      flush('hide');
    } else {
      // Back from the background: the dwell that follows is a new segment of the same page.
      viewStartedAt = now();
      leaveSent = false;
    }
  };
  const onPageHide = (): void => {
    leave();
    flush('hide');
  };
  const onNavigate = (): void => {
    const path = `${location.pathname}${location.search}`;
    if (path === currentPath) return;
    leave();
    view('page.view');
  };

  // Dwell and scroll belong to every integration: autoTrack only decides who notices a
  // navigation, not whether a page that is left reports how long it was read.
  const restore: (() => void)[] = [];
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  restore.push(() => {
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
  });
  if (options.autoTrack ?? true) {
    const history = window.history;
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function patched(this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        onNavigate();
        return result;
      } as History['pushState'];
      restore.push(() => {
        history[method] = original;
      });
    }
    window.addEventListener('popstate', onNavigate);
    restore.push(() => window.removeEventListener('popstate', onNavigate));
    view('page.view');
  }

  // A page reported by the caller ends the one in progress, as a noticed navigation does.
  return {
    page: (pageOptions) => {
      leave();
      view('page.view', pageOptions);
    },
    notFound: (pageOptions) => {
      leave();
      view('page.notfound', pageOptions);
    },
    search: (term, pageOptions) => {
      const trimmed = term.trim();
      if (!trimmed) return;
      enqueue({ type: 'site.search', path: pathOf(pageOptions), host: hostname(), term: trimmed.slice(0, 100) });
    },
    setDimensions: (next) => {
      dimensions = cleanDimensions(next, warn);
    },
    consent: () => {},
    identify: () => {},
    flush: () => flush('manual'),
    stop: () => {
      for (const undo of restore) undo();
      flush('manual');
      stopped = true;
    },
  };
}

function cleanDimensions(input: Record<string, string> | undefined, warn: (message: string) => void): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!DIMENSION_KEY.test(key)) {
      warn(`dimension "${key}" dropped: keys are lowercase identifiers of at most 64 characters`);
      continue;
    }
    if (typeof value !== 'string') {
      warn(`dimension "${key}" dropped: values are strings`);
      continue;
    }
    if (Object.keys(out).length >= DIMENSION_KEYS_MAX) {
      warn(`dimension "${key}" dropped: at most ${DIMENSION_KEYS_MAX} dimensions`);
      continue;
    }
    out[key] = value.slice(0, DIMENSION_VALUE_MAX);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
