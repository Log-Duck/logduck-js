import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Baked in at build time rather than imported from package.json at runtime:
  // a bundler resolving `../package.json` from inside node_modules either
  // fails or drags the whole manifest into the browser bundle.
  define: { __VERSION__: JSON.stringify(version) },
});
