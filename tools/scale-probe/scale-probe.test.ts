import { describe, expect, it } from 'vitest';
import { compare } from './compare.mjs';
import { selection, syntheticFiles } from './generate.mjs';
import { normalise } from './normalise.mjs';

const declared = (text: string) =>
  [...text.matchAll(/^@(\w[\w-]*) ([\w-]+)$/gm)].map(([, word, name]) => `${word} ${name}`);
const referenced = (text: string) =>
  [...text.matchAll(/@(spec|plan|milestone|task|decision) ([\w-]+)/g)].map(([, word, name]) => `${word} ${name}`);

describe('the synthetic generator', () => {
  it('writes the same files, byte for byte, for the same size and seed', () => {
    expect(syntheticFiles({ records: 437, seed: 7 })).toEqual(syntheticFiles({ records: 437, seed: 7 }));
  });

  it('writes different text for a different seed, with the same record names', () => {
    const a = syntheticFiles({ records: 120, seed: 1 }),
      b = syntheticFiles({ records: 120, seed: 2 });
    expect(a).not.toEqual(b);
    const names = (files: Record<string, string>) => Object.values(files).flatMap(declared).sort();
    expect(names(a)).toEqual(names(b));
  });

  it('writes exactly the asked number of records, each name once', () => {
    for (const records of [1, 49, 50, 51, 1234]) {
      const names = Object.values(syntheticFiles({ records, seed: 3 })).flatMap(declared);
      expect(names).toHaveLength(records);
      expect(new Set(names).size).toBe(records);
    }
  });

  it('refers only to records declared earlier, and writes every document a spec names', () => {
    const files = syntheticFiles({ records: 777, seed: 5 });
    const seen = new Set<string>();
    for (const [path, text] of Object.entries(files).sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (!path.endsWith('.ia')) continue;
      for (const block of text.split(/\n(?=@)/)) {
        const [head] = declared(block);
        for (const ref of referenced(block))
          if (ref !== head) expect(seen.has(ref), `${path}: ${head} -> ${ref}`).toBe(true);
        if (head) seen.add(head);
      }
    }
    for (const [, source] of Object.values(files).flatMap((text) => [...text.matchAll(/source "([^"]+)"/g)]))
      expect(files[source!], source).toBeTypeOf('string');
  });

  it('keeps at most fifteen records in a file and twenty files in a folder', () => {
    const files = syntheticFiles({ records: 5000, seed: 9 });
    const folders = new Map<string, number>();
    for (const [path, text] of Object.entries(files)) {
      if (!path.endsWith('.ia')) continue;
      expect(declared(text).length).toBeLessThanOrEqual(15);
      const folder = path.slice(0, path.lastIndexOf('/'));
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
    expect(Math.max(...folders.values())).toBeLessThanOrEqual(20);
  });

  it('selects for kb pack every record of each file it selects from, and the document its spec names', () => {
    for (const records of [7, 50, 300]) {
      const files = syntheticFiles({ records, seed: 4 }),
        chosen = selection({ records });
      const names = new Set(chosen.records.map((identity) => identity.split('/').slice(2).join(' ')));
      const touched = Object.entries(files).filter(
        ([path, text]) => path.endsWith('.ia') && declared(text).some((n) => names.has(n)),
      );
      expect(touched.flatMap(([, text]) => declared(text)).sort()).toEqual([...names].sort());
      for (const resource of chosen.resources) expect(files[resource], resource).toBeTypeOf('string');
    }
  });

  it('refuses a size that is not a positive whole number', () => {
    for (const records of [0, -1, 1.5, Number.NaN])
      expect(() => syntheticFiles({ records, seed: 1 })).toThrow(/records/);
  });
});

describe('the comparison', () => {
  const run = (digest: string, wallMs: number[], maxRssMB = [100]) => ({
    outputs: { validate: { exit: 0, digest, files: {} } },
    measurements: { validate: wallMs.map((ms, i) => ({ wallMs: ms, maxRssMB: maxRssMB[i] ?? maxRssMB[0] })) },
  });
  const one = (value: unknown) => new Map([['t.json', value]]);

  it('passes equal outputs that are no slower and no larger', () => {
    expect(compare(one(run('a', [1000, 1100, 900])), one(run('a', [950, 1000, 990]))).failed).toBe(0);
  });

  it('fails an output whose digest differs, and names it', () => {
    const result = compare(one(run('a', [1])), one(run('b', [1])));
    expect(result.failed).toBe(1);
    expect(result.rows[0]).toMatchObject({ tree: 't', command: 'validate', outputs: 'differ' });
  });

  it('fails a command missing on one side', () => {
    expect(compare(one(run('a', [1])), one({ outputs: {} })).rows[0]!.outputs).toBe('missing');
  });

  it('flags a median past the ratio, and ignores a difference below the noise floor', () => {
    expect(compare(one(run('a', [1000])), one(run('a', [1300]))).rows[0]).toMatchObject({
      slower: true,
      larger: false,
    });
    expect(compare(one(run('a', [100])), one(run('a', [200]))).rows[0]).toMatchObject({ slower: false });
    expect(compare(one(run('a', [100], [100])), one(run('a', [100], [200]))).rows[0]).toMatchObject({ larger: true });
  });

  it('compares outputs alone when asked, whatever the times', () => {
    expect(compare(one(run('a', [1000])), one(run('a', [9000])), { outputsOnly: true }).failed).toBe(0);
  });
});

describe('the normaliser', () => {
  const root = 'C:\\work\\tree';

  it('makes the workspace root relative wherever it appears, in either separator', () => {
    const out = normalise(
      'validate',
      { root, next: `Run "ia report --root C:/work/tree" now`, where: { path: 'C:\\work\\tree\\.ia\\src\\a.ia' } },
      root,
    );
    expect(out).toEqual({
      root: '<root>',
      next: 'Run "ia report --root <root>" now',
      where: { path: '<root>/.ia/src/a.ia' },
    });
  });

  it("drops evidence times and capture's prior-state fields, and keeps the rest", () => {
    const envelope = {
      snapshot: `${root}\\.ia\\work\\snapshot\\current.json`,
      revision: 'r',
      records: 3,
      prior: { revision: 'p' },
      previous: 'x',
      rotated: true,
      changed: 1,
      new: 2,
      unchanged: 0,
      evidence: { observations: [{ name: 'a', observedAt: '2026-11-11T00:00:00.000Z', outcome: 'pass' }] },
    };
    expect(normalise('capture', envelope, root)).toEqual({
      snapshot: '<root>/.ia/work/snapshot/current.json',
      revision: 'r',
      records: 3,
      unchanged: 0,
      evidence: { observations: [{ name: 'a', outcome: 'pass' }] },
    });
  });

  it("keeps a field named like capture's prior-state fields in any other command", () => {
    expect(normalise('validate', { new: 1, changed: 2 }, root)).toEqual({ new: 1, changed: 2 });
  });

  it('drops cache state, cache observations and timings', () => {
    const out = normalise(
      'inspect',
      { cache: { state: 'hit', observations: [1], kept: true }, timings: { ms: 3 }, records: [] },
      root,
    );
    expect(out).toEqual({ cache: { kept: true }, records: [] });
  });
});
