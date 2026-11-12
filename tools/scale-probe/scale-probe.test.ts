import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compare } from './compare.mjs';
import { selection, syntheticFiles } from './generate.mjs';
import { normalise } from './normalise.mjs';
import { unexpectedExits } from './probe.mjs';

const declared = (text: string) =>
  [...text.matchAll(/^@(\w[\w-]*) ([\w-]+)$/gm)].map(([, word, name]) => `${word} ${name}`);
const referenced = (text: string) =>
  [...text.matchAll(/@(spec|plan|milestone|task|decision) ([\w-]+)/g)].map(([, word, name]) => `${word} ${name}`);

describe('the synthetic generator', () => {
  it('writes the same files, byte for byte, for the same size and seed', () => {
    expect(syntheticFiles({ records: 437, seed: 7 })).toEqual(syntheticFiles({ records: 437, seed: 7 }));
  });

  it('writes the files the 3.7.0 reference was captured on, so a change to the generator cannot move it', () => {
    // packages/db/tests/fixtures/reference-3.7.0/synthetic-200.json and synthetic-2000.json were captured on these.
    const digest = (records: number) =>
      createHash('sha256')
        .update(JSON.stringify(syntheticFiles({ records, seed: 1 })))
        .digest('hex');
    expect(digest(200)).toBe('78349e641ecde4225a327bdfb3b0807dd8a51c68c0e8c61ca3f5ef6978a3c0fb');
    expect(digest(2000)).toBe('c6f130f9692cb3088bd7fefc9927256cc7b83d93ea95a5521a575aa152b35100');
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

  it('fails two captures of different trees under the same name', () => {
    const at = (commit: string) => ({ ...run('a', [1]), tree: { name: 't', recipe: { kind: 'git' }, commit } });
    expect(compare(one(at('c1')), one(at('c2'))).rows).toEqual([{ tree: 't', command: '*', outputs: 'tree differs' }]);
  });

  it('refuses a comparison with nothing in it', () => {
    expect(() => compare(new Map(), new Map())).toThrow(/nothing to compare/);
  });

  it('fails an output whose standard error differs', () => {
    const said = (stderr: string) => ({ outputs: { validate: { exit: 0, digest: 'a', stderr, files: {} } } });
    expect(compare(one(said('e3')), one(said('f4'))).rows[0]!.outputs).toBe('differ');
    expect(compare(one(said('e3')), one(said('e3'))).rows[0]!.outputs).toBe('equal');
  });

  it('compares outputs alone when asked, whatever the times', () => {
    expect(compare(one(run('a', [1000])), one(run('a', [9000])), { outputsOnly: true }).failed).toBe(0);
  });
});

describe("the probe's expected exits", () => {
  const result = { outputs: { validate: { exit: 0 }, 'kb-check': { exit: 1 } }, skipped: ['kb-pack'] };

  it('names each command that exits otherwise than the tree expects, or did not run', () => {
    expect(unexpectedExits({ validate: 0, 'kb-check': 0, 'kb-pack': 0, records: 0 }, result)).toEqual([
      'kb-check: 0 -> 1',
      'kb-pack: 0 -> skipped',
      'records: 0 -> missing',
    ]);
  });

  it('accepts the expected exits, refusals included, and a tree that expects nothing', () => {
    expect(unexpectedExits({ validate: 0, 'kb-check': 1 }, result)).toEqual([]);
    expect(unexpectedExits(undefined, result)).toEqual([]);
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

  it('leaves a longer name that starts with the root, and a path that only ends with it', () => {
    const out = normalise('validate', { a: 'C:\\work\\tree2\\x', b: 'D:\\old\\C:\\work\\tree' }, root);
    expect(out).toEqual({ a: 'C:\\work\\tree2\\x', b: 'D:\\old\\C:\\work\\tree' });
  });

  it('turns separators to slashes only in the path that follows the root', () => {
    expect(normalise('validate', { a: 'at C:\\work\\tree\\a.ia; then x\\y' }, root)).toEqual({
      a: 'at <root>/a.ia; then x\\y',
    });
  });

  it("blanks the observed and captured times in a written evidence file's text", () => {
    const text =
      '@observation a\n  evidence\n    observed-at "2026-11-12T03:52:42.694Z"\n    captured-at "2026-11-12T03:52:42.694Z"\n    verdict success\n';
    expect(normalise('validate', text, root)).toBe(
      '@observation a\n  evidence\n    observed-at "<time>"\n    captured-at "<time>"\n    verdict success\n',
    );
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
