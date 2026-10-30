import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api and the websocket transport to terminald so the
// browser only ever speaks to one origin. POCKET_TERMINAL_API overrides the
// daemon address for tests and non-default ports.
const daemon = process.env.POCKET_TERMINAL_API ?? 'http://127.0.0.1:8795';

/**
 * Append `?v=<content hash>` to every built JS/CSS URL.
 *
 * Vite already hashes file names, which busts caches on its own; the explicit
 * query makes the version visible in the document and keeps the PJOS
 * convention that a changed bundle always carries a new `?v=N` marker.
 */
const assetVersion = () => ({
  name: 'pocket-terminal-asset-version',
  apply: 'build' as const,
  enforce: 'post' as const,
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string) {
      // Vite names bundles `index-<contenthash>.js`; that hash already changes
      // with the bytes, so mirror it into the PJOS `?v=` marker without
      // re-reading the (not yet flushed) output files.
      return html.replace(/(src|href)="(\/assets\/(?:[^"?]*-)?([A-Za-z0-9_-]+)\.(?:js|css))"/g, (_match, attr: string, path: string, hash: string) => {
        return `${attr}="${path}?v=${hash}"`;
      });
    },
  },
});

export default defineConfig({
  plugins: [react(), assetVersion()],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: {
      '/api': {target: daemon, changeOrigin: false, ws: true},
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: {
      '/api': {target: daemon, changeOrigin: false, ws: true},
    },
  },
  build: {
    // xterm.js plus the app is one intentional chunk; the console is a
    // local-first tool and a single request keeps first paint predictable.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
