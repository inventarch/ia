import { runBounded } from '../../../../../../tools/testing/subprocess.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('qualifies the neutral plain-JavaScript SDK recipe with memory and reopened SQLite sessions', async () => {
  const root = fileURLToPath(new URL('../../../../../..', import.meta.url));
  const temporary = mkdtempSync(resolve(tmpdir(), 'ia-sdk-onboarding-'));
  try {
    const output = await runBounded(
      process.execPath,
      [fileURLToPath(new URL('./recipe.mjs', import.meta.url)), root, resolve(temporary, 'sessions')],
      { timeoutMs: 60000 },
    );
    expect(output.timedOut).toBe(false);
    expect(output.truncated).toBe(false);
    expect(output.status, output.stderr).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(result.profile).toBe('deterministic-fake-sdk-qualification');
    for (const profile of [result.memory, result.sqlite]) {
      expect(profile.paidProviderCalls).toBe(0);
      expect(profile.restart).toBe(true);
      expect(profile.negatives).toContain('revoked-operation');
      expect(profile.observations.find((row: { scenario: string }) => row.scenario === 'orchestration')).toMatchObject({
        status: 'completed',
        counters: { model: 5, reads: 1 },
      });
      expect(profile.observations.find((row: { scenario: string }) => row.scenario === 'recovery')).toMatchObject({
        status: 'completed',
        operationAttempts: 2,
      });
      expect(
        profile.observations.find((row: { scenario: string }) => row.scenario === 'revoked-operation'),
      ).toMatchObject({ counters: { reads: 0 }, operationAttempts: 0 });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 65000);
