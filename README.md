# LogDuck JavaScript SDK

Official JavaScript and TypeScript SDK for [LogDuck](https://logduck.com) — send
events from your app and get notified about the ones that matter.

Works in Node 18+, Deno, Bun, Cloudflare Workers and the browser. No runtime
dependencies.

```bash
npm install logduck
```

**This is the TypeScript SDK.** The source is TypeScript and the package ships
its own type declarations, so there is no separate `@types/logduck` to install.
Both ESM and CommonJS builds are included.

## Quick start

Two settings are required: your API key, and a `source` naming the app sending
the event.

```ts
import { LogDuckClient } from 'logduck';

const logduck = new LogDuckClient({
  apiKey: process.env.LOGDUCK_API_KEY!,
  source: 'checkout-api',
});

await logduck.send({ type: 'order.placed' });
```

That is the whole minimal setup. Create an API key in your project settings —
see [Authentication](https://logduck.com/docs#authentication).

## Every option

Only `apiKey` and `source` are required. The values below are the defaults you
get by omitting each one.

```ts
import { LogDuckClient } from 'logduck';

const logduck = new LogDuckClient({
  apiKey: process.env.LOGDUCK_API_KEY!,   // required — your key, starts with `ld_`
  source: 'checkout-api',                 // required — which app sent this, max 200 chars
  throwOnError: false,                    // optional, default false — true throws instead of returning null
  retryEnabled: true,                     // optional, default true  — retry once on 5xx, network errors and 429
  maxRetryDelayMs: 10_000,                // optional, default 10000 — never block your caller longer than this
  timeoutMs: 30_000,                      // optional, default 30000 — per-request timeout
  baseUrl: 'https://api.logduck.com',     // optional — override only for a self-hosted deployment
  logger: console,                        // optional, default console — anything with a .warn() method
  fetch: globalThis.fetch,                // optional — inject a fetch implementation, mainly for tests
});

await logduck.send({
  type: 'order.placed',                   // required — max 100 chars, naming rule below
  subject: 'order_9127',                  // optional — what the event is about, max 500 chars
  sessionId: 'sess_8f21c',                // optional — groups related events, max 256 chars
  message: 'Order placed on the Pro plan', // optional — the push notification body, max 500 chars
  time: new Date(),                       // optional — defaults to when the server received it
  data: { total: 4999, currency: 'NOK' }, // optional — any JSON-serialisable object
  emoji: '🛒',                             // optional — shown next to the event, max 10 chars
});
```

One client per process is enough — it holds no connection state.

**`message` is what a push notification shows.** Without it the body falls back
to listing the first few `data` keys, which reads like `total: 4999, currency:
NOK` rather than "Order placed on the Pro plan".

**Wire names.** The event is a CloudEvents 1.0 document, and a CloudEvents
extension attribute name must be lowercase alphanumeric — so `sessionId` goes
out as `sessionid`. The SDK maps it for you; you only need this when comparing
against the raw HTTP API.

**Naming `type`:** the server lowercases it and requires
`^[a-z][a-z0-9_.]*$` — letters, digits, `_` and `.`, starting with a letter.
So `order.placed` and `user.signup_completed` are fine; `order-placed` is
rejected with a 400. Dots are the conventional separator.

## Errors

By default `send` **never throws**. It returns `null` and logs a warning — a
logging SDK that throws can take down the code it was only meant to observe.

```ts
const result = await logduck.send({ type: 'order.placed' });

if (result === null) {
  // The event did not reach LogDuck. A warning has already been logged.
}
```

Set `throwOnError: true` to get a `LogDuckError` instead. Note that
`try`/`catch` only catches anything when that option is on — with the default,
the `catch` below would never run:

```ts
import { LogDuckClient, LogDuckError, type LogDuckEvent } from 'logduck';

const logduck = new LogDuckClient({
  apiKey: process.env.LOGDUCK_API_KEY!,
  source: 'checkout-api',
  throwOnError: true,          // required, or the catch below never fires
});

// Your own queue — the SDK does not provide one.
const retryQueue: Array<{ event: LogDuckEvent; notBefore: number }> = [];

const event: LogDuckEvent = { type: 'order.placed', subject: 'order_9127' };

try {
  await logduck.send(event);
} catch (error) {
  if (error instanceof LogDuckError && error.retryAfterMs !== undefined) {
    // Rate limited for longer than the client will wait — queue it rather than lose it.
    retryQueue.push({ event, notBefore: Date.now() + error.retryAfterMs });
  }
}
```

`LogDuckError` carries `status`, `body`, `retryAfterMs` and `cause`.

## Retries and rate limits

### The SDK sets `Idempotency-Key` for you

Every call generates an `Idempotency-Key` header, and reuses the **same** key on
the retry. The server deduplicates on it, so an event that timed out and got
retried is recorded once rather than twice.

You never set this header yourself. It is the main thing the SDK does for you
that raw HTTP does not — the endpoint *requires* the header (16–36 characters of
`[A-Za-z0-9_-]`) and rejects requests without one.

### What gets retried

| Response | Behaviour |
|---|---|
| 5xx, network failure, timeout | retried once after 1 second |
| 429 | retried once after the server's `Retry-After`, but only if that fits inside `maxRetryDelayMs` |
| Any other 4xx | never retried — it will fail identically the second time |

The server rate-limits each API key in fixed one-minute windows, so `Retry-After`
can be as much as 60 seconds. Blocking your caller that long is rarely
acceptable, so beyond `maxRetryDelayMs` the client gives up immediately and puts
the remaining wait on `error.retryAfterMs`, letting you queue the event instead
of losing it.

## What the server adds

Every event comes back with more on it than you sent. LogDuck resolves the
request itself and stores the result as flat fields you cannot set — an event
can never claim an origin that is not its own:

| Field | |
|---|---|
| `requestip`, `requestagent` | The address and User-Agent the request came from |
| `requestcountry`, `requestcontinent` | ISO 3166-1 alpha-2, and one of `AF`/`AN`/`AS`/`EU`/`NA`/`OC`/`SA` |
| `requestregion` | First-level subdivision — state, province or region — by name |
| `requestcity`, `requestcityid` | City name, and its GeoNames id, which tells Portland, Oregon from Portland, Maine |
| `requestlat`, `requestlon` | The city's approximate centre, as decimal-degree strings |
| `requesttimezone` | IANA name, e.g. `Europe/Brussels` |

A country resolves for nearly every routable address; a city for rather fewer.
Region and city are independent, so an address can resolve to one without the
other — do not guard one on the other. The last four are present **only**
alongside a city, and absent rather than guessed: the database answers them for
a country-only lookup too, from the country's centroid, which for anywhere
larger than a small country is wrong for most of the people in it.

These locate a city, not a device — the underlying accuracy radius is typically
5–200 km. If you need finer, resolve it yourself and put it in the event's data.

## Site usage: page views (`logduck/usage`)

A second, separate entry point counts how people move through a site — page
views, time on page, 404s, site searches — into the **Site** tab of your
project. It is not the events client: a page view never triggers a push or a
webhook, is billed against its own allowance, and is **anonymous by design**.
Nothing is stored on the visitor's device (no cookie, no local storage, no
fingerprint), so no consent banner is needed for it. The server keeps a
country and a city from the address and a device class and browser family from
the user agent, and discards both.

```ts
import { createUsage } from 'logduck/usage';

const usage = createUsage({ key: 'ld_...' });   // a client key, with your origins listed
```

That records a `page.view` now and on every `pushState`, `replaceState` and
`popstate`, and a `page.leave` (time on page, scroll depth) when the tab is
hidden, batched and sent with `sendBeacon` so nothing is lost on navigation.
Or as a script tag, with no bundler:

```html
<script async src="https://cdn.jsdelivr.net/npm/logduck/dist/usage.global.js" data-key="ld_..."></script>
```

Then `window.logduck.search('ducks')`. The key is a **client key** created for
the site in the dashboard, with the site's origins listed: the key ships in the
page, and the origin list is what stops another site spending your allowance.
A server key is refused.

| Option / method | |
|---|---|
| `autoTrack: false` | For a router the SDK cannot see; call `usage.page({ path, referrer, title })` yourself. Each call ends the previous page (its `page.leave`), and hiding the tab ends the last one, exactly as with auto-tracking |
| `usage.notFound()` | The current page was a 404 |
| `usage.search(term)` | A site search. Stored only if the environment has search terms switched on; digit runs of six or more are masked on the server |
| `dimensions`, `usage.setDimensions({...})` | Up to ten lowercase keys describing the page — `dealer`, `section`, `variant` — never an identifier (keys like `email` or `user_id` are refused) |
| `sampleRate: 8` | Send one hit in eight. A power of two up to 1,024, and the environment must allow it (off by default); sent hits carry the rate and the dashboard weights them back |
| `consent(true)`, `identify(id)` | Reserved for the consented mode (unique visitors, journeys). No-ops today, so your integration does not change when it arrives |

Nothing is stored on or read from the visitor's device: no cookie, no local or
session storage, no fingerprint. Page views are joined into sessions on the
server, under a key that changes every day and never leaves it.
Without a `document` — server rendering, a worker — `createUsage` returns an
inert object and every call is a no-op. The first non-204 of a session is
warned once in the console, so a wrong key or an unlisted origin is visible
rather than silently counted as nothing. Ad blockers block the API host for
roughly a fifth to a third of visitors; a first-party collection domain is
planned.

## Using the API without the SDK

The SDK is a convenience, not a requirement — `POST /v1/events` is a plain JSON
endpoint over HTTPS, usable from any language or from `curl`:

```bash
curl -X POST https://api.logduck.com/v1/events \
  -H "X-API-Key: ld_your_key_here" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.placed","source":"checkout-api","subject":"order_9127"}'
```

Full request and response reference:
**[logduck.com/docs#api-reference](https://logduck.com/docs#api-reference)**.

Going direct means you take on what the SDK handles: generating a valid
`Idempotency-Key` per event and reusing it across retries, honouring
`Retry-After` on a 429, and deciding which failures are worth retrying.

## Logging

Warnings go to `console` unless you pass something else with a `.warn()` method
— `pino`, `winston` and `bunyan` all qualify:

```ts
import { LogDuckClient } from 'logduck';
import pino from 'pino';

const log = pino();
const logduck = new LogDuckClient({
  apiKey: process.env.LOGDUCK_API_KEY!,
  source: 'checkout-api',
  logger: log,
});
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Releases are published by CI. Run `npm version <patch|minor|major>` and push the
tag; `publish.yml` refuses the release if the tag and `package.json` disagree, or
if the version is already on npm.

## License

MIT
