import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { open, pathKey } from '../src/index.js';
import { methodPath, put, workspace } from './workspace.js';

const path = '.ia/src/systems/agent-system/records/draft-agent.ia';
const source =
  '#! ia 1.0\n@agent draft-agent\n  meaning\n    says "A draft expert"\n    answers "Who authors drafts?"\n  governance\n    applies [agent]\n';
it('admits a draft through the real pipeline without changing files, cache, scope or revision', () => {
  const root = workspace(),
    db = open(root),
    before = db.snapshot(),
    within = db.resolveScope().token,
    cache = readFileSync(resolve(root, '.ia/.iadb/graph.json'));
  try {
    const result = db.preview([{ path, text: source }]);
    expect(result.baseRevision).toBe(before.revision);
    expect(result.revision).not.toBe(before.revision);
    expect(result.records.find((r) => r.name === 'draft-agent')?.source.path).toBe(path);
    expect(result.report.findings.some((f) => f.severity === 'error')).toBe(false);
    expect(db.snapshot({ within })).toEqual(before);
    expect(existsSync(resolve(root, path))).toBe(false);
    // Compare exact bytes without expanding a multi-megabyte Buffer into matcher property keys.
    expect(readFileSync(resolve(root, '.ia/.iadb/graph.json')).equals(cache)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(db.preview([]).revision).toBe(before.revision);
    put(root, path, source);
    const fresh = open(root, { cache: false });
    try {
      expect(result.records).toEqual(fresh.records());
      expect(result.revision).toBe(fresh.revision);
      expect(result.report).toEqual(fresh.report);
    } finally {
      fresh.close();
    }
  } finally {
    db.close();
  }
}, 60_000); // Full native-tree copy/cache/re-admission across several disk snapshots; allow Windows I/O variance as the corpus grows. Not a latency assertion.
it('retains real schema/foreign/identity refusals and preserves prior immutable results', () => {
  const root = workspace(),
    db = open(root, { cache: false });
  try {
    const bad = db.preview([{ path, text: source.replace('    applies [agent]\n', '') }]);
    expect(bad.records.some((r) => r.name === 'draft-agent')).toBe(false);
    expect(bad.report.findings.some((f) => f.code === 'IA-COMP-FIELD-MISSING')).toBe(true);
    const foreign = db.preview([
      {
        path: '.ia/src/systems/agent-system/foreign.ia',
        text: readFileSync(resolve(root, methodPath), 'utf8').replace('sample-procedure', 'foreign-draft'),
      },
    ]);
    expect(foreign.report.findings.some((f) => f.code === 'IA-COMP-DISCRIMINATOR-FOREIGN')).toBe(true);
    const duplicated = db.preview([
      { path, text: source },
      { path: '.ia/src/systems/agent-system/records/duplicate.ia', text: source },
    ]);
    expect(duplicated.report.findings.some((f) => f.code === 'IA-GRAPH-IDENTITY-TIE')).toBe(true);
    expect(db.preview([{ path, text: source }]).records.some((r) => r.name === 'draft-agent')).toBe(true);
    expect(bad.records.some((r) => r.name === 'draft-agent')).toBe(false);
  } finally {
    db.close();
  }
});
it('rejects malformed paths, duplicates, floor edits and malformed Unicode before admission', () => {
  const db = open(workspace(), { cache: false });
  try {
    for (const bad of [
      '../escape.ia',
      '.ia/src/../escape.ia',
      '.ia/src/floor/change.ia',
      '.ia/src/file.txt',
      '.ia\\src\\file.ia',
      '.ia/src/file:ads.ia',
    ])
      expect(() => db.preview([{ path: bad, text: source }])).toThrow(
        expect.objectContaining({ code: 'IA-DB-DRAFT-INVALID' }),
      );
    expect(() =>
      db.preview([
        { path, text: source },
        { path, text: source },
      ]),
    ).toThrow(expect.objectContaining({ code: 'IA-DB-DRAFT-INVALID' }));
    expect(() => db.preview([{ path, text: '\ud800' }])).toThrow(
      expect.objectContaining({ code: 'IA-DB-DRAFT-INVALID' }),
    );
    // Where the volume folds them, two spellings of one file are one draft (#315, #323); the `.ia/src/` prefix keeps its case.
    for (const [a, b] of [
      ['.ia/src/Draft.ia', '.ia/src/draft.ia'],
      ['.ia/src/cla\u00df.ia', '.ia/src/class.ia'],
    ] as const)
      if (pathKey(a) === pathKey(b))
        expect(() =>
          db.preview([
            { path: a, text: source },
            { path: b, text: source },
          ]),
        ).toThrow(
          expect.objectContaining({
            code: 'IA-DB-DRAFT-INVALID',
            message: expect.stringContaining('Duplicate or aliased'),
          }),
        );
  } finally {
    db.close();
  }
  expect(() => db.preview([])).toThrow(expect.objectContaining({ code: 'IA-DB-CLOSED' }));
});
it('preserves explicit placement/provenance and admits new folders only through system checks', () => {
  const root = workspace(),
    db = open(root, {
      cache: false,
      locations: {
        [path]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' },
        [methodPath]: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'methodology' },
      },
    });
  try {
    const result = db.preview([
      { path, text: source },
      { path: methodPath, text: readFileSync(resolve(root, methodPath), 'utf8') + '\n# draft\n' },
    ]);
    expect(result.records.find((r) => r.name === 'draft-agent')).toMatchObject({ band: 90, provenance: 'methodology' });
    expect(result.records.find((r) => r.name === 'sample-procedure')?.provenance).toBe('methodology');
    const malformed = db.preview([{ path: '.ia/src/systems/undeclared/record.ia', text: source }]);
    expect(malformed.report.findings.some((f) => f.code === 'IA-COMP-SYSTEM-MALFORMED')).toBe(true);
  } finally {
    db.close();
  }
});
