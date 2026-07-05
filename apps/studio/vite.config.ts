import { defineConfig } from 'vite';
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
  server: {
    port: 5173,
    strictPort: true,
  },
});
