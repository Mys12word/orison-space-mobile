#!/usr/bin/env node
/**
 * Build the mobile host + renderer.
 *
 *  1. regenerate theme tokens from the YAML palettes (same as desktop)
 *  2. bundle the Node host with esbuild, aliasing `electron`,
 *     `better-sqlite3` and `electron-updater` to the Android shims
 *  3. build the React renderer with Vite
 */
import esbuild from 'esbuild';
import { build as viteBuild } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTokensCss } from './themeTokens.mjs';

const appRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, '');
const repoRoot = path.resolve(appRoot, '../..');
const uiSrc = path.join(repoRoot, 'apps/desktop/client/ui/src');

const shims = {
  electron: path.join(appRoot, 'src/shims/electron.ts'),
  'better-sqlite3': path.join(appRoot, 'src/shims/betterSqlite3.ts'),
  'electron-updater': path.join(appRoot, 'src/shims/electronUpdater.ts'),
};

const shimPlugin = {
  name: 'orison-mobile-shims',
  setup(build) {
    const filter = new RegExp(`^(${Object.keys(shims).join('|')})$`);
    build.onResolve({ filter }, (args) => ({ path: shims[args.path] }));
  },
};

const t0 = Date.now();

console.log('[build] theme tokens');
buildTokensCss(uiSrc);

console.log('[build] host bundle (esbuild)');
await esbuild.build({
  entryPoints: [path.join(appRoot, 'src/host/boot.ts')],
  outdir: path.join(appRoot, 'dist/host'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  splitting: true,
  sourcemap: true,
  logLevel: 'warning',
  entryNames: 'server',
  chunkNames: 'chunks/[name]-[hash]',
  plugins: [shimPlugin],
  // Keep optional pretty-printer out of the bundle; it is only used in dev mode.
  external: ['pino-pretty'],
  // Bundled CJS dependencies call require() for Node builtins; ESM output needs
  // a real require available in every chunk.
  banner: {
    js: "import { createRequire as __orisonCreateRequire } from 'node:module';\nconst require = __orisonCreateRequire(import.meta.url);",
  },
});

console.log('[build] renderer bundle (vite)');
await viteBuild({ configFile: path.join(appRoot, 'vite.config.ts'), logLevel: 'warn' });

console.log(`[build] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
