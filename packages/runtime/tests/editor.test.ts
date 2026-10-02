import { describe, expect, it } from 'vitest';
import { EditorWorkspace } from '../src/editor/index.js';
import { lawId, methodId, methodPath, playbook, put, workspace } from './workspace.js';

describe('public editor facade', () => {
  it('projects admitted/refused occurrences, follows references and resolves discriminator/schema navigation', () => {
    const editor = new EditorWorkspace(workspace()),
      view = editor.view();
    const record = view.records.find((r) => r.identity === methodId)!;
    expect(record.status).toBe('admitted');
    const source = editor.source(record.source.action, view.stamp),
      lines = source.text.split('\n'),
      line = lines.findIndex((l) => l.includes('@law sample-rule'));
    const definition = editor.definition(methodPath, { line, character: 14 });
    expect(definition[0]?.path).toContain('sample-rule.ia');
    expect(editor.definition(methodPath, { line: record.source.range.start.line, character: 2 })[0]?.path).toContain(
      'system.ia',
    );
    expect(editor.definition(methodPath, { line, character: 1 }, true)[0]?.path).toContain('playbook.schema.ia');
    const law = view.records.find((r) => r.identity === lawId)!;
    expect(
      editor
        .references(law.source.path, { line: law.source.range.start.line, character: 2 })
        .some((r) => r.path === methodPath),
    ).toBe(true);
    expect(editor.inspect(record.occurrence, view.stamp).cells).toHaveLength(24);
    const relationship = editor.inspect(record.occurrence, view.stamp).relationships.find((r) => r.to === lawId)!;
    expect(relationship.toSource?.path).toBe(law.source.path);
    expect(editor.source(relationship.toSource!.action, view.stamp).text).toContain('@law sample-rule');
    expect(editor.graph(record.occurrence, view.stamp).nodes.some((r) => r.identity === lawId)).toBe(true);
    editor.close();
  });
  it('returns structural containment separately from semantic edges, nodes, traversal and totals', () => {
    const root = workspace(),
      path = '.ia/src/systems/governance-system/records/outer.ia';
    const nest = (name: string): string =>
      playbook(name)
        .replace('#! ia 1.0\n', '')
        .replace(/^(?=.)/gm, '    ');
    put(
      root,
      path,
      playbook('outer-method', '  relationships\n    cites @law sample-rule\n') + '  meaning\n' + nest('nested-child'),
    );
    const editor = new EditorWorkspace(root),
      view = editor.view(),
      named = (name: string) => view.records.find((r) => r.name === name)!;
    const outer = named('outer-method'),
      child = named('nested-child');
    expect([outer.status, child.status]).toEqual(['admitted', 'admitted']);
    const graph = editor.graph(outer.occurrence, view.stamp);
    expect(graph.containment.links.map((c) => [c.parent, c.child])).toEqual([[outer.identity, child.identity]]);
    expect(graph.containment.links[0]!.source.range.start.line).toBe(child.source.range.start.line);
    expect(editor.source(graph.containment.links[0]!.source.action, view.stamp).text).toContain(
      '@playbook nested-child',
    );
    expect(graph.containment.nodes.map((n) => n.identity)).toEqual([child.identity]);
    expect(new Set(graph.nodes.map((n) => n.identity))).toEqual(new Set([outer.identity, lawId]));
    expect(graph.edges.some((e) => e.from === child.identity || e.to === child.identity)).toBe(false);
    expect(graph.totals).toEqual({ nodes: 2, edges: graph.edges.length });
    expect(graph.containment.truncated).toBe(false);
    const inner = editor.graph(child.occurrence, view.stamp, undefined, 3);
    expect(inner.nodes.map((n) => n.identity)).toEqual([child.identity]);
    expect(inner.edges).toEqual([]);
    expect(inner.containment.nodes.map((n) => n.identity)).toEqual([outer.identity]);
    expect(editor.graph(named('sample-procedure').occurrence, view.stamp).containment).toEqual({
      links: [],
      nodes: [],
      truncated: false,
    });
    editor.close();
  });
  it('completes dynamic registered words and reference targets, then invalidates stale actions', () => {
    const editor = new EditorWorkspace(workspace()),
      view = editor.view(),
      source = editor.sourceText(methodPath)!;
    editor.update([{ path: methodPath, text: '#! ia 1.0\n@pla', version: 1 }]);
    expect(editor.completions(methodPath, { line: 1, character: 4 }).map((c) => c.label)).toContain('@playbook');
    const partial = '#! ia 1.0\n@playbook sample-procedure\n  relationships\n    cites @law sam';
    editor.update([{ path: methodPath, text: partial, version: 2 }]);
    const item = editor.completions(methodPath, { line: 3, character: 18 }).find((c) => c.label === '@law sample-rule');
    expect(item).toBeDefined();
    expect(item?.range.start.character).toBe(10);
    expect(() => editor.source(view.records[0]!.source.action, view.stamp)).toThrow('view changed');
    expect(item?.documentation).toBeUndefined();
    expect(item?.citation).toEqual({ kind: 'record', identity: lawId });
    const bound = editor.stamp(),
      documentation = editor.completionDocumentation(methodPath, item!.citation!, bound);
    expect(documentation).toContain(`\`${lawId}\``);
    expect(documentation).toContain('sample-rule.ia:');
    editor.update([{ path: methodPath, text: '#! ia 1.0\n@pla', version: 3 }]);
    const word = editor.completions(methodPath, { line: 1, character: 4 }).find((c) => c.label === '@playbook')!;
    expect(word.citation).toEqual({ kind: 'word', keyword: 'playbook' });
    expect(editor.completionDocumentation(methodPath, word.citation!, editor.stamp())).toContain('Schema `playbook`');
    expect(
      editor.completionDocumentation(methodPath, { kind: 'record', identity: 'missing:record' }, editor.stamp()),
    ).toBeUndefined();
    expect(() => editor.completionDocumentation(methodPath, item!.citation!, bound)).toThrow('view changed');
    editor.update([{ path: methodPath, text: source, version: 4 }]);
    expect(editor.semanticTokens(methodPath).some((t) => t.type === 'type')).toBe(true);
    editor.close();
  });
  it('admits a create-only proposal despite unrelated baseline errors, and rejects loss, aliases and authority changes', () => {
    const root = workspace();
    put(root, '.ia/src/broken.ia', '#! ia 9.0\n');
    const editor = new EditorWorkspace(root),
      stamp = editor.stamp(),
      file = { path: '.ia/src/systems/governance-system/records/fresh-method.ia', text: playbook('fresh-method') };
    const allowed = editor.validateProposal([file], stamp);
    expect(allowed.messages).toEqual([]);
    expect(allowed.allowed).toBe(true);
    expect(editor.validateProposal([{ ...file, text: playbook('sample-procedure') }], stamp).allowed).toBe(false);
    expect(editor.validateProposal([{ ...file, path: methodPath }], stamp).allowed).toBe(false);
    expect(
      editor.validateProposal([{ ...file, path: '.ia/src/systems/governance-system/records/CON.ia' }], stamp).allowed,
    ).toBe(false);
    expect(editor.validateProposal([{ ...file, text: '#! ia 1.0\n@schema fresh\n' }], stamp).allowed).toBe(false);
    editor.close();
  });
});
