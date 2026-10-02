import '../../tools/temp/physical-temp.mjs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
  resolve: {
    conditions: ['development'],
    alias: { '@tools/testing': resolve(import.meta.dirname, '../../tools/testing') },
  },
});
