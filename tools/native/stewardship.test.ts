import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNative, readNative } from './check.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('public system stewardship', () => {
  it('every public system steward has a stewardship mandate covering its folder', () => {
    const { inputs, folders } = readNative(root);
    const { records } = checkNative(inputs, folders);
    const stewards = records.filter((r) => r.discriminator === 'agent' && /^public-.+-system-steward$/.test(r.name));
    expect(stewards).toHaveLength(11);
    for (const steward of stewards) {
      const system = steward.name.replace(/^public-/, '').replace(/-steward$/, '');
      const mandate = records.find((r) => r.discriminator === 'mandate' && r.name === `public-${system}-stewardship`);
      expect(mandate, `mandate for ${steward.name}`).toBeDefined();
      const authority = JSON.stringify(mandate!.sections.filter((s) => s.name === 'authority'));
      expect(authority).toContain(steward.name);
      expect(authority).toContain(`.ia/src/systems/${system}/`);
      expect(authority).toContain('language-workspace');
      for (const move of ['Observation', 'Verification', 'Synthesis']) expect(authority).toContain(move);
      expect(authority).not.toContain('Execution');
      expect(authority).not.toContain('Delegation');
    }
  });
});
