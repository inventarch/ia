import '../../tools/temp/physical-temp.mjs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
// Snapshot/packing setup and cleanup need the same allowance as their consumers.
// Test-only primitives live under tools/testing; the alias keeps package tests off private relative paths.
export default defineConfig({
  resolve: {
    conditions: ['development'],
    alias: { '@tools/testing': resolve(import.meta.dirname, '../../tools/testing') },
  },
  test: { include: ['tests/**/*.test.ts'], reporters: ['dot'], testTimeout: 30000, hookTimeout: 30000 },
});
