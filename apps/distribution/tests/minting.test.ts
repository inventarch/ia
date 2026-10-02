import { beforeAll, expect, it } from 'vitest';
import { digest } from '@ia/session-system';
import { assessReleaseMinting } from '../src/minting.js';
import { mintingFixture } from './minting-fixture.js';

let f: ReturnType<typeof mintingFixture>, baseline: ReturnType<ReturnType<typeof mintingFixture>['make']>;
/** The slowest case packs two workspaces: about 13 s locally and 36 s on a Windows runner, past the former 30 s. */
const MINTING = 120_000;
beforeAll(() => {
  f = mintingFixture();
  baseline = f.make('baseline');
}, MINTING);
const set = (value: typeof baseline) => ({ lock: value.lock, archives: value.archives });
it(
  'refuses a new registration admitted by native packing until its exact guide is included',
  () => {
    const missing = f.make('missing'),
      guided = f.make('guided');
    const request = {
      floor: f.floor,
      baseline: set(baseline),
      candidate: set(missing),
      policyRevision: digest('policy'),
    };
    const denied = assessReleaseMinting(request);
    expect(denied.ready).toBe(false);
    expect(denied.changed).toContainEqual({
      key: 'authoring-system/criterion-note',
      change: 'added',
      status: 'missing',
    });
    const accepted = assessReleaseMinting({ ...request, candidate: set(guided) });
    expect(accepted.ready).toBe(true);
    expect(accepted.semantic).toBe('not-evaluated');
    expect(accepted.proof).not.toBe(denied.proof);
  },
  MINTING,
);
it(
  'binds explicit baseline, floor, candidate bytes and current policy; altered bytes cannot reuse a proof',
  () => {
    const request = { floor: f.floor, baseline: null, candidate: set(baseline), policyRevision: digest('initial') };
    const first = assessReleaseMinting(request);
    expect(first.ready).toBe(true);
    expect(assessReleaseMinting({ ...request, policyRevision: digest('changed') }).proof).not.toBe(first.proof);
    expect(() =>
      assessReleaseMinting({
        ...request,
        candidate: {
          ...set(baseline),
          archives: new Map([[baseline.packed.archiveDigest, Buffer.from('substituted')]]),
        },
      }),
    ).toThrow();
    expect(() => assessReleaseMinting({ ...request, floor: [] })).toThrow();
  },
  MINTING,
);
it(
  'retains exact legacy gaps only when unchanged instead of treating a fresh legacy package as minted',
  () => {
    const legacy = f.make('legacy'),
      selection = set(legacy);
    expect(
      assessReleaseMinting({
        floor: f.floor,
        baseline: selection,
        candidate: selection,
        policyRevision: digest('legacy'),
      }),
    ).toMatchObject({ ready: true });
    expect(
      assessReleaseMinting({ floor: f.floor, baseline: null, candidate: selection, policyRevision: digest('new') })
        .ready,
    ).toBe(false);
  },
  MINTING,
);
