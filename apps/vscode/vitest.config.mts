import '../../tools/temp/physical-temp.mjs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
// Workspace-tree setup admits both the real foundation and its adopted view.
// Test-only primitives live under tools/testing; the alias keeps package tests off private relative paths.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000 },
  resolve: {
    conditions: ['development'],
    alias: { '@tools/testing': resolve(import.meta.dirname, '../../tools/testing') },
  },
});
