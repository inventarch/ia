import '../../../../tools/temp/physical-temp.mjs';
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] }, resolve: { conditions: ['development'] } });
