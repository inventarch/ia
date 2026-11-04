import { resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const rootManifest = resolve(sep, 'package.json');
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const fake = (path: unknown): boolean => typeof path === 'string' && resolve(path) === rootManifest;
  return {
    ...real,
    existsSync: (path: string) => fake(path) || real.existsSync(path),
    readFileSync: ((path: string, ...rest: unknown[]) =>
      fake(path)
        ? JSON.stringify({ workspaces: ['packages/*'] })
        : (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof real.readFileSync,
  };
});

describe('installRoot at the filesystem root', () => {
  it('inspects a filesystem-root owner before the ascent stops', async () => {
    const { installRoot } = await import('../src/local-cli.js');
    const member = resolve(sep, 'packages', 'x');
    expect(installRoot(member)).toBe(resolve(sep));
  });
});
