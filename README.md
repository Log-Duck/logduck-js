# LogDuck JavaScript SDK

Official JavaScript and TypeScript SDK for [LogDuck](https://logduck.com) — send
events from your app and get notified about the ones that matter.

Works in Node 18+, Deno, Bun, Cloudflare Workers and the browser. No runtime
dependencies.

```bash
npm install logduck
```

**This is the TypeScript SDK.** The source is TypeScript and the package ships
its own type declarations, so there is nothing to install alongside it and no
separate `@types/logduck` — `logduck` is the whole thing, from either language.
Both ESM and CommonJS builds are included.

## Usage

```ts
import { LogDuckClient } from 'logduck';

const logduck = new LogDuckClient({
  apiKey: process.env.LOGDUCK_API_KEY!,
  source: 'checkout-api',
});

await logduck.send({
  type: 'order.placed',
  subject: 'order_9127',
  data: { total: 4999, currency: 'NOK' },
  emoji: '🛒',
});
```

One client per process is enough — it holds no connection state.

## Options

| Option | Default | What it does |
|---|---|---|
| `apiKey` | — | Required. Must start with `ld_`. |
| `source` | — | Required. Identifies the app sending events (max 200 chars). Attached to every event. |
| `throwOnError` | `false` | When false, failures are logged and `send` resolves to `null`. |
| `retryEnabled` | `true` | Retry once on 5xx, network errors and rate limits. |
| `maxRetryDelayMs` | `10000` | Longest wait before retrying a rate-limited request. |
| `timeoutMs` | `30000` | Request timeout. |
| `baseUrl` | `https://api.logduck.com` | Override for a self-hosted deployment. |
| `logger` | `console` | Anything with a `warn` method — pino, winston and bunyan all fit. |

## Event fields

| Field | Required | Limit |
|---|---|---|
| `type` | yes | 100 chars. Lowercased by the server, which requires `^[a-z][a-z0-9_.]*$` — letters, digits, `_` and `.`, starting with a letter. A hyphen is rejected. |
| `subject` | no | 500 chars. The resource the event is about. |
| `sessionId` | no | 256 chars. Groups related events. |
| `time` | no | `Date` or ISO 8601 string. Defaults to server time. |
| `data` | no | Any JSON object. |
| `emoji` | no | 10 chars. |

`source` is not an event field — it comes from the client options.

## Errors

`send` resolves to `null` on failure and logs a warning. A logging SDK that
throws can take down the code it was only meant to observe, so that is the
default; set `throwOnError: true` to get a `LogDuckError` instead.

```ts
import { LogDuckError } from 'logduck';

try {
  await logduck.send({ type: 'order.placed' });
} catch (error) {
  if (error instanceof LogDuckError && error.retryAfterMs) {
    // Rate limited. Queue it rather than lose it.
    queue.push({ event, notBefore: Date.now() + error.retryAfterMs });
  }
}
```

### Retries and rate limits

Every request carries an `Idempotency-Key`, unchanged across a retry, so the
server deduplicates rather than double-posting.

- **5xx and network failures** — retried once after 1 second.
- **429** — retried once, waiting for the period the server gives in
  `Retry-After`, but never longer than `maxRetryDelayMs`. The server limits each
  API key in fixed one-minute windows, so `Retry-After` can be as much as 60
  seconds; blocking a caller that long is rarely acceptable. When the wait would
  exceed the cap the client gives up immediately and the failure carries
  `retryAfterMs`, so the event can be queued instead of lost.
- **Other 4xx** — never retried. They will fail identically the second time.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Releases are published by CI. Run `npm version <patch|minor|major>` and push the
tag; `publish.yml` refuses the release if the tag and `package.json` disagree,
or if the version is already on npm.

## License

MIT
