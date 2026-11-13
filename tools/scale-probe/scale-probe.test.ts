import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBounded } from '../testing/subprocess.js';
import { compare } from './compare.mjs';
import { contents, generate, selection, syntheticFiles } from './generate.mjs';
import { normalise } from './normalise.mjs';
import { refuseStaleOut, unexpectedExits } from './probe.mjs';

const declared = (text: string) =>
  [...text.matchAll(/^@(\w[\w-]*) ([\w-]+)$/gm)].map(([, word, name]) => `${word} ${name}`);
const referenced = (text: string) =>
  [...text.matchAll(/@(spec|plan|milestone|task|decision) ([\w-]+)/g)].map(([, word, name]) => `${word} ${name}`);

const PROBE = fileURLToPath(new URL('./probe.mjs', import.meta.url));
const bound = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;

/** Runs `run` in a fresh temporary folder, removed afterwards. */
async function scratch(run: (base: string) => Promise<void> | void): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'ia-scale-probe-test-'));
  try {
    await run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** The message `run` throws, or undefined when it returns. */
function thrown(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

describe('the synthetic generator', () => {
  it('writes the same files, byte for byte, for the same size and seed', () => {
    expect(syntheticFiles({ records: 437, seed: 7 })).toEqual(syntheticFiles({ records: 437, seed: 7 }));
  });

  it('pins the init arguments, files, selection and commit it gave the trees the 3.7.0 reference was captured on', () => {
    // packages/db/tests/fixtures/reference-3.7.0/synthetic-200.json and synthetic-2000.json were captured on these
    // trees, whose commits they record. The files `ia init` writes come from the 3.7.0 CLI and are not pinned here.
    const digest = (records: number) =>
      createHash('sha256')
        .update(JSON.stringify(contents({ records, seed: 1, git: true })))
        .digest('hex');
    expect(digest(200)).toBe('b1d7bf6a0f1a5ce54ffdecaf37ba777f217674c1ac873c22fbdee3b9fd8efe23');
    expect(digest(2000)).toBe('b2df8f539636a6730ddedb2fa328be8024caf4c0456a12901b59694bf0e9db97');
  });

  /** A stand-in `ia init` that writes the folder name and arguments it was given into that folder, and nothing else. */
  const recordingInit = (base: string): string => {
    const init = join(base, 'init.mjs');
    writeFileSync(
      init,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { basename, join } from 'node:path';",
        'const [, , command, folder, ...rest] = process.argv;',
        "writeFileSync(join(folder, 'init.json'), JSON.stringify([command, basename(folder), ...rest]));",
      ].join('\n'),
    );
    return init;
  };
  const PINNED = '83de71881c5fc005d2aba403116ad06150d87d12';

  it('makes a pinned commit around a stand-in ia init that records how it was called', () =>
    scratch((base) => {
      // Beyond the digest above, this pins the file names, how generate() calls `ia init` (the folder and arguments
      // it gives it), and the message it commits with. The real `ia init`'s files come from the 3.7.0 CLI.
      const made = generate({
        cli: recordingInit(base),
        out: join(base, 'synthetic'),
        records: 200,
        seed: 1,
        git: true,
      });
      expect(made.commit).toBe(PINNED);
    }));

  it('makes the same commit whatever git template the environment names', () =>
    scratch((base) => {
      // GIT_TEMPLATE_DIR outranks init.templateDir. This template's exclude file would leave the documents out.
      mkdirSync(join(base, 'template', 'info'), { recursive: true });
      writeFileSync(join(base, 'template', 'info', 'exclude'), '*.md\n');
      const before = process.env['GIT_TEMPLATE_DIR'];
      process.env['GIT_TEMPLATE_DIR'] = join(base, 'template');
      try {
        const made = generate({
          cli: recordingInit(base),
          out: join(base, 'synthetic'),
          records: 200,
          seed: 1,
          git: true,
        });
        expect(made.commit).toBe(PINNED);
      } finally {
        if (before === undefined) delete process.env['GIT_TEMPLATE_DIR'];
        else process.env['GIT_TEMPLATE_DIR'] = before;
      }
    }));

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
    expect(thrown(() => compare(new Map(), new Map()))).toBe('nothing to compare: neither side holds a capture');
  });

  it('refuses a comparison whose captures hold no command output', () => {
    const none = 'nothing to compare: no capture holds a command output';
    const empty = { outputs: {}, skipped: ['kb-pack'] };
    expect(thrown(() => compare(one(empty), one(empty)))).toBe(none);
    expect(thrown(() => compare(one(empty), new Map()))).toBe(none);
    // Under different names, each side's capture has no match on the other, yet neither holds an output either.
    expect(thrown(() => compare(new Map([['x.json', empty]]), new Map([['y.json', empty]])))).toBe(none);
  });

  it('fails an output that was unstable in its capture, on either side, whatever the digests', () => {
    const at = (stable: boolean, digest = 'a') => ({
      outputs: { validate: { exit: 0, digest, stderr: 'e', files: {}, stable } },
    });
    for (const [before, after] of [
      [at(false), at(true)],
      [at(true), at(false)],
      [at(false), at(false)],
      [at(false), at(true, 'b')],
    ]) {
      const result = compare(one(before), one(after));
      expect(result.rows).toEqual([{ tree: 't', command: 'validate', outputs: 'unstable' }]);
      expect(result.failed).toBe(1);
    }
    expect(compare(one(at(true)), one(at(true))).rows[0]!.outputs).toBe('equal');
    expect(compare(one(at(false)), one({ outputs: {} })).rows[0]!.outputs).toBe('missing');
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

describe("the probe's --out", () => {
  const stale = (folders: string[]) =>
    `--out already holds captures in ${folders.join(', ')}; a tree this run does not finish would keep an earlier run's capture there. Remove them or choose another --out.`;

  it('accepts an --out that holds no capture for its labels: no folder, other files, or another label', () =>
    scratch((out) => {
      expect(thrown(() => refuseStaleOut(join(out, 'none'), ['a']))).toBeUndefined();
      mkdirSync(join(out, 'a'));
      writeFileSync(join(out, 'a', 'notes.txt'), '');
      mkdirSync(join(out, 'b'));
      writeFileSync(join(out, 'b', 't.json'), '{}');
      expect(thrown(() => refuseStaleOut(out, ['a']))).toBeUndefined();
    }));

  it('refuses an --out whose label folders already hold captures, naming each', () =>
    scratch((out) => {
      for (const label of ['a', 'b', 'c']) mkdirSync(join(out, label));
      writeFileSync(join(out, 'a', 't.json'), '{}');
      writeFileSync(join(out, 'c', 'u.json'), '{}');
      expect(thrown(() => refuseStaleOut(out, ['a', 'b', 'c']))).toBe(stale([join(out, 'a'), join(out, 'c')]));
    }));

  it('stops on any error but a missing folder, such as a file where a label folder should be', () =>
    scratch((out) => {
      writeFileSync(join(out, 'a'), '');
      let code: unknown;
      try {
        refuseStaleOut(out, ['a']);
      } catch (error) {
        code = (error as NodeJS.ErrnoException).code;
      }
      expect(code).toBe('ENOTDIR');
    }));

  it('refuses at start with exit 2, before it builds a tree', () =>
    scratch(async (out) => {
      mkdirSync(join(out, 'a'));
      writeFileSync(join(out, 'a', 't.json'), '{}\n');
      // Neither CLI exists, so a probe that went on to build a tree would stop with another message.
      const missing = join(out, 'missing.js');
      const run = await runBounded(
        process.execPath,
        [PROBE, '--init-cli', missing, '--cli', `a=${missing}`, '--out', out],
        { timeoutMs: bound },
      );
      expect(run).toMatchObject({ status: 2, stdout: '', stderr: `${stale([join(out, 'a')])}\n` });
      expect(readdirSync(out)).toEqual(['a']);
      expect(readFileSync(join(out, 'a', 't.json'), 'utf8')).toBe('{}\n');
    }));
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
