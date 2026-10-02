import '../../tools/temp/physical-temp.mjs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 30000,
  },
  resolve: { conditions: ['development'] },
});
