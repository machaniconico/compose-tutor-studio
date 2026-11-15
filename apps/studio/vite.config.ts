import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import studioPackage from './package.json';

// Vite configuration for the Compose Tutor Studio web app.
export default defineConfig({
  clearScreen: false,
  define: {
    __CTS_APP_VERSION__: JSON.stringify(studioPackage.version ?? '0.0.0'),
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  plugins: [react()],
  test: {
    // Default stays node; DOM tests opt in with `// @vitest-environment jsdom`.
    environment: 'node',
    setupFiles: ['./tests/setupDom.ts'],
    // Dynamic imports of the store graph in beforeAll are slow on WSL /mnt/d under parallel load.
    hookTimeout: 120_000,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
