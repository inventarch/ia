import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { open, readInputs } from '@ia/db';
import type { Handle } from '@ia/db';
import { EditorSnapshot } from '@ia/db/editor';
import { DraftError, formatDraft, validateDraft } from '../src/index.js';

const root = resolve(import.meta.dirname, '../../../../..'),
  readers: Handle[] = [];
function context() {
  const reader = open(root, { cache: false });
  readers.push(reader);
  return { reader, within: reader.resolveScope().token, revision: reader.revision };
}
const path = '.ia/src/systems/agent-system/records/public-draft.ia';
const text =
  '#! ia 1.0\n@agent public-draft\n  meaning\n    says    "An original bounded draft."\n    answers "Who reviews?"\n  governance\n    applies []\n';
afterEach(() => {
  vi.restoreAllMocks();
  for (const reader of readers.splice(0)) reader.close();
});
it('validates and formats real contextual drafts with evidence and no source changes', () => {
  const ctx = context(),
    before = readInputs(root).fingerprint;
  const checked = validateDraft(ctx, { path, text }),
    formatted = formatDraft(ctx, { path, text });
  expect(checked.artifacts).toEqual([]);
  expect(checked.evidence.admitted).toBeGreaterThan(ctx.reader.records().length);
  expect(formatted.artifacts).toEqual([{ path, text: text.replace('says    ', 'says ') }]);
  expect(formatted.baseRevision).toBe(ctx.revision);
  expect(formatted.candidateRevision).not.toBe(ctx.revision);
  expect(formatted.evidence.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(readInputs(root).fingerprint).toBe(before);
});
it('refuses narrowed, phase-specific, foreign, stale and closed scopes before contextual preview', () => {
  const ctx = context(),
    foreign = context(),
    preview = vi.spyOn(Object.getPrototypeOf(ctx.reader), 'preview');
  const scopes = [
    ctx.reader.resolveScope({ identities: [ctx.reader.records()[0]!.identity] }).token,
    ctx.reader.resolveScope({ identities: ctx.reader.records().map((r) => r.identity) }).token,
    ctx.reader.resolveScope({ phase: 'act' }).token,
    foreign.within,
    'forged',
  ];
  for (const within of scopes)
    expect(() => validateDraft({ ...ctx, within }, { path, text })).toThrow(
      expect.objectContaining({ code: 'IA-EXEC-SCOPE-UNAVAILABLE', diagnostics: [] }),
    );
  expect(() => validateDraft({ ...ctx, revision: 'stale' }, { path, text })).toThrow(DraftError);
  ctx.reader.close();
  expect(() => validateDraft(ctx, { path, text })).toThrow(DraftError);
  expect(preview).not.toHaveBeenCalled();
});
it('refuses declarations, schemas, unknown owners and unsafe paths before preview', () => {
  const ctx = context(),
    preview = vi.spyOn(Object.getPrototypeOf(ctx.reader), 'preview');
  for (const target of [
    '../escape.ia',
    '.ia/src/floor/schema.ia',
    '.ia/src/systems/agent-system/system.ia',
    '.ia/src/systems/agent-system/schemas/evil.ia',
    '.ia/src/systems/absent/records/new.ia',
    '.ia/distributions/store/pin/file.ia',
  ])
    expect(() => formatDraft(ctx, { path: target, text })).toThrow(
      expect.objectContaining({ code: 'IA-EXEC-OUTPUT-UNSAFE' }),
    );
  expect(preview).not.toHaveBeenCalled();
});
it('refuses malformed, forged and oversized arguments without emitting a draft', () => {
  const ctx = context();
  for (const input of [
    null,
    [],
    { path },
    { path, text, root: 'forged' },
    { path, text: '\ud800' },
    { path, text: ' ' },
  ])
    expect(() => validateDraft(ctx, input)).toThrow(expect.objectContaining({ code: 'IA-EXEC-INPUT-INVALID' }));
  expect(() => formatDraft(ctx, { path, text: text + '#'.repeat(1024 * 1024) })).toThrow(
    expect.objectContaining({ code: 'IA-EXEC-LIMIT-EXCEEDED' }),
  );
});
it('preserves formatter and contextual admission refusals', () => {
  const ctx = context();
  expect(() => formatDraft(ctx, { path, text: 'malformed' })).toThrow(
    expect.objectContaining({ code: 'IA-EXEC-VALIDATION-FAILED' }),
  );
  expect(() => validateDraft(ctx, { path, text: text.replace('    answers "Who reviews?"\n', '') })).toThrow(
    expect.objectContaining({ code: 'IA-EXEC-VALIDATION-FAILED' }),
  );
});

it('does not leak refused-source diagnostics through a scope containing every admitted identity', () => {
  const reader = new EditorSnapshot(readInputs(root), [
    {
      path: '.ia/src/systems/agent-system/records/undisclosed.ia',
      text: '#! ia 1.0\n@agent confidential-refused\n  private-secret "hidden"\n',
      version: 1,
    },
  ]);
  try {
    expect(reader.report.findings.some((f) => f.severity === 'error')).toBe(true);
    const within = reader.resolveScope({ identities: reader.records().map((r) => r.identity) }).token;
    expect(() => validateDraft({ reader, within, revision: reader.revision }, { path, text })).toThrow(
      expect.objectContaining({ code: 'IA-EXEC-SCOPE-UNAVAILABLE', diagnostics: [] }),
    );
  } finally {
    reader.close();
  }
});
