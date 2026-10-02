import '../../tools/temp/physical-temp.mjs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
// Both suites exercise built subprocesses, sometimes several per test.
// Test-only primitives live under tools/testing; the alias keeps package tests off private relative paths.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
  resolve: {
    conditions: ['development'],
    alias: { '@tools/testing': resolve(import.meta.dirname, '../../tools/testing') },
  },
});
