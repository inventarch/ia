import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { open } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

describe('cache-free editor capture', () => {
  it('shares disk admission and preserves the existing draft contract', () => {
    const root = workspace(),
      editor = new EditorDatabase(root),
      disk = open(root, { cache: false });
    expect(editor.current.records()).toEqual(disk.records());
    expect(editor.current.report).toEqual(disk.report);
    const text = readFileSync(resolve(root, methodPath), 'utf8').replace('sample-procedure', 'another-method');
    const candidate = editor.current.candidate([{ path: methodPath, text, version: 1 }]);
    expect(candidate.records()).toEqual(disk.preview([{ path: methodPath, text }]).records);
    expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);
    expect(disk.get(methodId)).toBeDefined();
    candidate.close();
    editor.close();
    disk.close();
  });
  it('refuses the complete dirty file, retains healthy sources, and retires old scope issuers', () => {
    const root = workspace(),
      editor = new EditorDatabase(root),
      previous = editor.current;
    const scope = previous.resolveScope();
    editor.update([{ path: methodPath, text: '#! ia 9.0\n@playbook broken\n', version: 2 }]);
    expect(editor.current.get(methodId)).toBeUndefined();
    expect(editor.current.records().length).toBeGreaterThan(100);
    expect(editor.current.report.findings.some((f) => f.code === 'IA-LANG-VERSION-UNSUPPORTED')).toBe(true);
    expect(() => previous.records({ within: scope.token })).toThrow('IA-DB-CLOSED');
    expect(() => editor.current.records({ within: scope.token })).toThrow('IA-DB-SCOPE-UNAVAILABLE');
    expect(() => editor.update([{ path: methodPath, text: '', version: 1 }])).toThrow('IA-DB-STALE');
    expect(() => editor.update([{ path: methodPath, text: '', version: 2 }])).toThrow('IA-DB-STALE');
    editor.update([]);
    expect(editor.current.get(methodId)).toBeDefined();
    editor.close();
    expect(() => editor.update([])).toThrow('IA-DB-CLOSED');
  });
  it('reconciles disk deletion and supports local floor overlays without writing source', () => {
    const root = workspace(),
      editor = new EditorDatabase(root);
    const source = editor.current.sources.find((s) => s.path.startsWith('.ia/src/floor/'))!;
    expect(source.origin).toBe('local');
    editor.update([{ path: source.path, text: '#! ia 1.0\n', version: 1 }]);
    expect(readFileSync(resolve(root, source.path), 'utf8')).toBe(source.text);
    unlinkSync(resolve(root, methodPath));
    editor.update([], true);
    expect(editor.current.sources.some((s) => s.path === methodPath)).toBe(false);
    editor.close();
  });
  it('refuses virtual floor edits, path escapes, and duplicate aliases', () => {
    const root = workspace(false),
      editor = new EditorDatabase(root),
      floor = editor.current.sources[0]!;
    expect(floor.origin).toBe('embedded');
    expect(floor.writable).toBe(false);
    expect(() => editor.update([{ path: floor.path, text: '', version: 1 }])).toThrow('read-only');
    expect(() => editor.update([{ path: '../escape.ia', text: '', version: 1 }])).toThrow();
    expect(() =>
      editor.update([
        { path: '.ia/src/x.ia', text: '', version: 1 },
        { path: '.ia/src/x.ia', text: '', version: 2 },
      ]),
    ).toThrow('duplicate');
    expect(editor.current.sources[0]).toEqual(floor);
    editor.close();
  });
  it('retains location and phase scope enforcement in preview readers', () => {
    const root = workspace(),
      path = '.ia/src/example.ia';
    put(root, path, '#! ia 1.0\n@playbook local\n  meaning\n    says "Only local"\n');
    const editor = new EditorDatabase(root, {
      locations: { [path]: { placement: { kind: 'authored', band: 100, reach: 'area' }, provenance: 'workspace' } },
    });
    expect(editor.current.sources.find((s) => s.path === path)?.location.placement.reach).toBe('area');
    const scope = editor.current.resolveScope({ root: 'area', identities: [methodId] });
    expect(editor.current.records({ within: scope.token }).map((r) => r.identity)).toEqual([methodId]);
    expect(() => editor.current.records({ within: scope.token, root: '' })).toThrow('IA-DB-SCOPE-MISMATCH');
    editor.close();
  });
});
