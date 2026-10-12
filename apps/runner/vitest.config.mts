import '../../tools/temp/physical-temp.mjs';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000, hookTimeout: 60000, maxWorkers: 1 },
  resolve: { conditions: ['development'] },
});
