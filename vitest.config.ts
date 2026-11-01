import { defineConfig } from 'vitest/config';

// Only the package's own tests; the apps in examples/ have their own setup.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
