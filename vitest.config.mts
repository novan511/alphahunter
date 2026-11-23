import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'scripts/**'],
    clearMocks: true,
    testTimeout: 10_000,
  },
});
