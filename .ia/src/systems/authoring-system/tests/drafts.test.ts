import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { open, pathKey, readInputs } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { EditorSnapshot } from '@inventarch/db/editor';
import { DraftError, formatDraft, validateDraft } from '../src/index.js';

const root = resolve(import.meta.dirname, '../../../../..'),
  readers: Handle[] = [];
function context() {
  const reader = open(root, { cache: false });
  readers.push(reader);
  return { reader, within: reader.resolveScope().token, revision: reader.revision };
}
const isError = (finding: { readonly severity: string }): boolean => finding.severity === 'error';
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
  // Where the volume folds case (db's pathKey), a floor or system-folder path spelled in another case is the same
  // path, so the authored-root rule refuses it as it refuses the lowercase one.
  const folded = pathKey('.ia/src/Floor/x.ia') === '.ia/src/floor/x.ia';
  for (const target of [
    '../escape.ia',
    '.ia/src/floor/schema.ia',
    '.ia/src/systems/agent-system/system.ia',
    '.ia/src/systems/agent-system/schemas/evil.ia',
    '.ia/src/systems/absent/records/new.ia',
    '.ia/distributions/store/pin/file.ia',
    // Under the authored root, but no IA file: only an IA source is drafted.
    '.ia/src/participant.md',
    '.ia/src/notes/probe.txt',
    '.ia/src/probe',
    '.ia/src/systems/agent-system/records/notes.txt',
    ...(folded
      ? ['.ia/src/Floor/x.ia', '.ia/src/Systems/agent-system/schemas/evil.ia', '.ia/src/Systems/absent/records/new.ia']
      : []),
  ])
    for (const draft of [formatDraft, validateDraft])
      expect(() => draft(ctx, { path: target, text }), target).toThrow(
        expect.objectContaining({ name: 'DraftError', code: 'IA-EXEC-OUTPUT-UNSAFE' }),
      );
  expect(preview).not.toHaveBeenCalled();
});
it('drafts a file under an authored root outside every system folder, and no file outside one', () => {
  // This repository's participant pair is authored in .ia/src/participant.ia, under the `.ia/src @authored` root its
  // language workspace declares (db D02c), as a default `ia init` authors its three records in .ia/src/workspace.ia.
  const ctx = context(),
    participant = '.ia/src/participant.ia',
    authored = readFileSync(resolve(root, participant), 'utf8');
  expect(formatDraft(ctx, { path: participant, text: authored }).artifacts).toEqual([
    { path: participant, text: authored },
  ]);
  expect(
    formatDraft(ctx, { path: participant, text: authored.replace('    says "The IDE', '    says    "The IDE') })
      .artifacts,
  ).toEqual([{ path: participant, text: authored }]);
  expect(validateDraft(ctx, { path: participant, text: authored }).evidence.findings.filter(isError)).toEqual([]);
  // Outside the source tree, in the floor, in an adopted mount, or in the systems directory but no system's folder.
  for (const target of [
    'participant.ia',
    'docs/participant.ia',
    '.ia/src/floor/participant.ia',
    '.ia/adopted/fixture/rev/.ia/src/participant.ia',
    '.ia/src/systems/participant.ia',
  ])
    expect(() => formatDraft(ctx, { path: target, text: authored })).toThrow(
      expect.objectContaining({ code: 'IA-EXEC-OUTPUT-UNSAFE' }),
    );
  // A root the workspace does not declare at the authored placement takes no draft: one that does not contain the
  // file, and the same root declared at another placement. The whole repository, declared as the root, takes it.
  const language = '.ia/src/systems/workspace-system/records/language.ia',
    declared = readFileSync(resolve(root, language), 'utf8');
  // Each declared root is read back first, so a refusal is the rule's and never an entry db declined to read.
  const drafted = (spelled: string, declaredRoot: string, placement: string) => {
    const edited = declared.replace('sources [".ia/src @authored"]', `sources ["${spelled} @${placement}"]`);
    expect(edited).not.toBe(declared);
    const reader = new EditorSnapshot(readInputs(root), [{ path: language, text: edited, version: 1 }]);
    try {
      expect(reader.roots().map((row) => [row.root, row.placement])).toEqual([[declaredRoot, placement]]);
      return formatDraft(
        { reader, within: reader.resolveScope().token, revision: reader.revision },
        { path: participant, text: authored },
      ).artifacts;
    } finally {
      reader.close();
    }
  };
  for (const [spelled, placement] of [
    ['.ia/src/systems', 'authored'],
    ['.ia/src', 'adopted'],
  ] as const)
    expect(() => drafted(spelled, spelled, placement), `${spelled} @${placement}`).toThrow(
      expect.objectContaining({ code: 'IA-EXEC-OUTPUT-UNSAFE' }),
    );
  expect(drafted('.', '', 'authored')).toEqual([{ path: participant, text: authored }]);
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
