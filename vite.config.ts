import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * satellite.js のマルチスレッド WASM を握り潰すためのスタブ。
 *
 * satellite.js の index は createMultiThreadRuntime を re-export しており、
 * その中の `await import('#wasm-multi-thread')` をバンドラが追ってしまう。
 * pthreads 版は SharedArrayBuffer を要求する = COOP/COEP ヘッダが必要で、
 * このアプリでは使わない。バンドルから丸ごと外す。
 */
const multiThreadStub = fileURLToPath(
  new URL('./src/shims/wasm-multi-thread-stub.ts', import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^#wasm-multi-thread$/, replacement: multiThreadStub }],
  },
  worker: {
    // 伝播 Worker は { type: 'module' } で起動する。既定の iife だと
    // WASM ローダーのトップレベル await が通らない。
    format: 'es',
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      // `npm run dev:worker` で立てた wrangler dev に API だけ転送する
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
