import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import studioPackage from './package.json';

const PRODUCTION_CONNECT_SRC = "connect-src 'self'";
const DEVELOPMENT_CONNECT_SRC =
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*";
const TAURI_CONNECT_SRC =
  "connect-src 'self' ipc: http://ipc.localhost https://ipc.localhost";
const TAURI_DEVELOPMENT_CONNECT_SRC =
  "connect-src 'self' ipc: http://ipc.localhost https://ipc.localhost ws://localhost:* ws://127.0.0.1:*";

function studioManualChunks(moduleId: string): string | undefined {
  const normalizedId = moduleId.replaceAll('\\', '/');
  if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(normalizedId)) {
    return 'react-runtime';
  }
  return undefined;
}

// Vite configuration for the Compose Tutor Studio web app.
//
// Cloudflare Pages ではルート (`/`) 配信のため base は '/' のまま。
// SPA フォールバックは public/_redirects (`/* /index.html 200`) が担う。
// ビルド出力は既定の `dist/` で、CF Pages の「出力ディレクトリ」に指定する。
export default defineConfig(({ mode }) => {
  const includeE2eFixtures = mode === 'e2e';
  const tauriDevHost = process.env.TAURI_DEV_HOST;
  const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
  const tauriBuildTarget =
    tauriPlatform === 'windows' ? 'chrome105' : tauriPlatform ? 'safari15.5' : undefined;

  return {
    base: '/',
    clearScreen: false,
    define: {
      __CTS_APP_VERSION__: JSON.stringify(studioPackage.version),
    },
    plugins: [
      react(),
      {
        name: 'runtime-csp',
        transformIndexHtml(html, context) {
          let connectSrc = context.server ? DEVELOPMENT_CONNECT_SRC : PRODUCTION_CONNECT_SRC;
          if (tauriPlatform) {
            connectSrc = context.server ? TAURI_DEVELOPMENT_CONNECT_SRC : TAURI_CONNECT_SRC;
          }
          return html.replace(PRODUCTION_CONNECT_SRC, connectSrc);
        },
      },
    ],
    server: {
      port: 5173,
      strictPort: true,
      host: tauriDevHost || false,
      hmr: tauriDevHost
        ? {
            protocol: 'ws',
            host: tauriDevHost,
            port: 1421,
          }
        : undefined,
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    build: {
      outDir: includeE2eFixtures ? 'test-results/e2e-build' : 'dist',
      // Tauri uses WebView2 on Windows and WebKit on macOS/Linux. Keep the
      // existing modern-browser target for standalone web builds.
      ...(tauriBuildTarget ? { target: tauriBuildTarget } : {}),
      minify: tauriPlatform && process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
      sourcemap: Boolean(tauriPlatform && process.env.TAURI_ENV_DEBUG),
      // バンドル済み JS/CSS の出力先サブディレクトリ (dist/assets/)。
      // public/ 配下 (_redirects 等) は Vite が dist 直下へそのままコピーする。
      assetsDir: 'assets',
      rollupOptions: {
        ...(includeE2eFixtures
          ? {
              input: {
                app: fileURLToPath(new URL('./index.html', import.meta.url)),
                'fatal-boundary': fileURLToPath(
                  new URL('./e2e/fixtures/fatal-boundary.html', import.meta.url),
                ),
              },
            }
          : {}),
        output: {
          // React is a stable, shared runtime boundary. Feature/domain modules
          // stay under Rollup's graph-driven splitting so side-effect order is
          // unchanged and closed dialogs remain genuinely on demand.
          manualChunks: studioManualChunks,
        },
      },
    },
  };
});
