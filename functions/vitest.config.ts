import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // Room for a test that waits on two triggers (`eventually`, 30 s each).
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
