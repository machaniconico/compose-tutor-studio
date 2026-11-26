import { defineConfig } from 'vitest/config';

// lint.boundary walks the source tree; on slow (WSL /mnt) filesystems it can exceed the 5s default.
export default defineConfig({ test: { testTimeout: 30000 } });
