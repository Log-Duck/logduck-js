import { createUsage, type Usage } from './usage.js';

/**
 * The script-tag build. Reads its configuration from the tag's data attributes and starts
 * tracking; the tracker is exposed as `window.logduck` for `search()` and friends.
 *
 * ```html
 * <script async src="https://cdn.jsdelivr.net/npm/logduck/dist/usage.global.js" data-key="ld_..."></script>
 * ```
 */
declare global {
  interface Window {
    logduck?: Usage;
  }
}

const script = document.currentScript as HTMLScriptElement | null;
const data = script?.dataset ?? {};
const key = data.key ?? '';
const sampleRate = data.sampleRate ? Number(data.sampleRate) : undefined;

window.logduck = createUsage({
  key,
  baseUrl: data.baseUrl,
  sampleRate,
  autoTrack: data.autoTrack !== 'false',
  host: data.host,
  cookieDomain: data.cookieDomain,
});
