import './tools/temp/physical-temp.mjs';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tools/**/*.test.ts'], testTimeout: 30000 },
  resolve: { conditions: ['development'] },
});
