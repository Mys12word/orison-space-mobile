import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(appRoot, '../desktop/client/ui/src');

// Renderer-only Vite build. The host half is bundled by scripts/build.mjs with
// esbuild (it needs the Electron/Node shims), so this config only concerns the
// browser bundle.
export default defineConfig({
  root: path.join(appRoot, 'renderer'),
  publicDir: path.join(appRoot, 'renderer/public'),
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@desktop-ui': uiSrc,
    },
  },
  server: {
    host: '127.0.0.1',
    fs: { allow: [path.resolve(appRoot, '../..')] },
  },
  build: {
    outDir: path.resolve(appRoot, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
