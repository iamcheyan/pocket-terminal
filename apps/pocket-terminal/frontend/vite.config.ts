import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api and the websocket transport to terminald so the
// browser only ever speaks to one origin. POCKET_TERMINAL_API overrides the
// daemon address for tests and non-default ports.
const daemon = process.env.POCKET_TERMINAL_API ?? 'http://127.0.0.1:8795';

export default defineConfig({
  plugins: [react()],
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
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
