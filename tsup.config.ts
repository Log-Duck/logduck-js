import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

// Baked in at build time rather than imported from package.json at runtime:
// a bundler resolving `../package.json` from inside node_modules either
// fails or drags the whole manifest into the browser bundle.
const define = { __VERSION__: JSON.stringify(version) };

export default defineConfig([
  {
    // `logduck` (events, any runtime) and `logduck/usage` (page views, browser only) are
    // separate entry points so a Node service never bundles browser code.
    entry: ['src/index.ts', 'src/usage.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    define,
  },
  {
    // The script-tag build: `<script async src=".../dist/usage.global.js" data-key="ld_...">`.
    entry: { usage: 'src/usage.iife.ts' },
    format: ['iife'],
    outExtension: () => ({ js: '.global.js' }),
    minify: true,
    sourcemap: true,
    define,
  },
]);
