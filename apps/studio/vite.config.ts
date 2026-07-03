import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite configuration for the Compose Tutor Studio web app.
//
// Cloudflare Pages ではルート (`/`) 配信のため base は '/' のまま。
// SPA フォールバックは public/_redirects (`/* /index.html 200`) が担う。
// ビルド出力は既定の `dist/` で、CF Pages の「出力ディレクトリ」に指定する。
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    // バンドル済み JS/CSS の出力先サブディレクトリ (dist/assets/)。
    // public/ 配下 (_redirects 等) は Vite が dist 直下へそのままコピーする。
    assetsDir: 'assets',
  },
});
