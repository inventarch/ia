import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Location } from '@inventarch/language';
import { open, readInputs } from '../src/index.js';
import { viewBuilder } from '../src/view.js';

const repository = resolve(import.meta.dirname, '../../..'),
  temporary: string[] = [];
function workspace(native = true) {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-db-view-'));
  temporary.push(root);
  if (native)
    cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), {
      recursive: true,
      filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
    });
  return root;
}
function put(root: string, path: string, text: string) {
  mkdirSync(resolve(root, path, '..'), { recursive: true });
  writeFileSync(resolve(root, path), text, 'utf8');
}
const methodPath = '.ia/src/systems/governance-system/records/sample-procedure.ia';
const lawPath = '.ia/src/systems/governance-system/records/sample-rule.ia';
const contractPath = '.ia/src/systems/compliance-system/contracts/foundation-authoring-contract.ia';
const methodId = 'governance-system/definition/procedure/sample-procedure';
it('admits package-local instances under the sole root owner without changing logical identity', () => {
  const root = workspace(),
    packageRoot = 'packages/example';
  const before = open(root, { cache: false });
  const original = before.records().find((record) => record.source.path === lawPath)!;
  before.close();
  const localPath = `${packageRoot}/${lawPath}`;
  put(root, localPath, readFileSync(resolve(root, lawPath), 'utf8'));
  const duplicate = open(root, { cache: false, authoredRoots: [packageRoot] });
  try {
    expect(duplicate.report.findings.some((finding) => finding.severity === 'error')).toBe(true);
  } finally {
    duplicate.close();
  }
  rmSync(resolve(root, lawPath));
  const db = open(root, { cache: false, authoredRoots: [packageRoot] });
  try {
    expect(db.get(original.identity)?.source.path).toBe(localPath);
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const scope = db.resolveScope({ identities: [original.identity] });
    expect(db.records({ within: scope.token }).map((record) => record.identity)).toEqual([original.identity]);
    put(root, localPath, `${readFileSync(resolve(root, localPath), 'utf8')}\n# source changed\n`);
    db.refresh();
    expect(() => db.records({ within: scope.token })).toThrow(/STALE/);
  } finally {
    db.close();
  }
  const standalone = open(resolve(root, packageRoot), { cache: false });
  try {
    expect(standalone.records().some((record) => record.identity === original.identity)).toBe(false);
    expect(standalone.report.findings.some((finding) => finding.severity === 'error')).toBe(true);
  } finally {
    standalone.close();
  }
});
afterEach(() => {
  for (const root of temporary.splice(0)) {
    const path = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(path) || !path.startsWith('ia-db-view-') || path.includes('..'))
      throw new Error('Unsafe temporary cleanup target');
    rmSync(root, { recursive: true, force: true });
  }
});
it('admits the native corpus and keeps absent execution/build evidence explicit', () => {
  const view = viewBuilder(readInputs(workspace()))();
  expect(view.graph.byName.has('sample-procedure')).toBe(true);
  expect(view.refused).toEqual([]);
  expect(view.blockedSystems).toEqual([]);
  expect(view.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(view.report.verdicts.filter((v) => v.outcome === 'not-evaluated').map((v) => v.check)).toEqual([
    'COMP-ADOPTION',
    'COMP-FIXTURES',
    'COMP-KERNEL',
  ]);
  expect(view.report.findings.some((f) => f.code === 'IA-LANG-EDGE-TARGET-MISSING')).toBe(false);
});
it('admits only the default kernel in an empty workspace', () => {
  const view = viewBuilder(readInputs(workspace(false)))();
  expect(view.graph.nodes.size).toBe(118);
  expect(view.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(view.admittedSystems).toEqual(['floor', 'taxonomy']);
});
it('refuses a foreign instance while preserving healthy records and the owning system finding', () => {
  const root = workspace(),
    path = '.ia/src/systems/agent-system/records/foreign.ia';
  const before = [...viewBuilder(readInputs(root))().graph.nodes.keys()].sort();
  put(root, path, readFileSync(resolve(root, lawPath), 'utf8').replace('@law sample-rule', '@law foreign-law'));
  const view = viewBuilder(readInputs(root))();
  expect([...view.graph.nodes.keys()].sort()).toEqual(before);
  expect(view.graph.byName.has('foreign-law')).toBe(false);
  expect(view.report.findings.filter((f) => f.code === 'IA-COMP-DISCRIMINATOR-FOREIGN')).toHaveLength(1);
  expect(view.refused.find((r) => r.path === path)?.reason).toBe('IA-COMP-DISCRIMINATOR-FOREIGN');
});
it('refuses every preview in a language-error file but preserves another healthy file', () => {
  const root = workspace(),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  put(root, '.ia/src/bad.ia', source.replace('@playbook sample-procedure', '@playbook preview') + '\n@unknown bad\n');
  put(root, '.ia/src/good.ia', source.replace('@playbook sample-procedure', '@playbook healthy'));
  const view = viewBuilder(readInputs(root))();
  expect(view.graph.byName.has('preview')).toBe(false);
  expect(view.graph.byName.has('healthy')).toBe(true);
  expect(
    view.report.findings.some((f) => f.code === 'IA-LANG-DISCRIMINATOR-UNREGISTERED' && f.path === '.ia/src/bad.ia'),
  ).toBe(true);
});
it('refuses individual schema failures and their nested descendants while keeping valid sibling records', () => {
  const root = workspace(),
    source = readFileSync(resolve(root, methodPath), 'utf8').replace('@playbook sample-procedure', '@playbook healthy');
  put(
    root,
    '.ia/src/instances.ia',
    '#! ia 1.0\n@playbook incomplete\n  meaning\n    says "missing answers and cognition"\n    @agent nested\n      meaning\n        says "nested"\n        answers "nested"\n      governance\n        applies [agent]\n' +
      source.replace('#! ia 1.0', ''),
  );
  const view = viewBuilder(readInputs(root))();
  expect(view.graph.byName.has('incomplete')).toBe(false);
  expect(view.graph.byName.has('nested')).toBe(false);
  expect(view.graph.byName.has('healthy')).toBe(true);
  expect(view.refused.some((r) => r.reason === 'enclosing record refused')).toBe(true);
});
it('refuses a missing steward join and its dependents without cascaded steward findings', () => {
  const root = workspace();
  const path = '.ia/src/systems/agent-system/steward.ia';
  put(root, path, '#! ia 1.0\n');
  const view = viewBuilder(readInputs(root))();
  expect(view.blockedSystems).toEqual([
    'agent-composition-system',
    'agent-system',
    'authoring-system',
    'compliance-system',
    'governance-system',
    'hook-authoring-system',
    'learning-system',
    'session-system',
    'template-system',
    'work-system',
    'workspace-system',
  ]);
  expect(view.graph.nodes.size).toBe(118);
  expect(view.admittedSystems).toEqual(['floor', 'taxonomy']);
  expect(view.report.findings.filter((f) => f.code === 'IA-COMP-STEWARD-MISSING')).toHaveLength(1);
});
it('refuses missing schema registration and restores every agent after source restoration', () => {
  const root = workspace(),
    path = '.ia/src/systems/agent-system/system.ia',
    original = readFileSync(resolve(root, path), 'utf8');
  const before = viewBuilder(readInputs(root))().graph.byDiscriminator.get('agent');
  put(root, path, original.replace('      schema @schema agent\n', '').replace('      schema @schema agent\r\n', ''));
  const bad = viewBuilder(readInputs(root))();
  expect(bad.graph.byDiscriminator.has('agent')).toBe(false);
  expect(bad.report.findings.some((f) => f.code === 'IA-LANG-REGISTRATION-INCOMPLETE')).toBe(true);
  put(root, path, original);
  expect(viewBuilder(readInputs(root))().graph.byDiscriminator.get('agent')).toEqual(before);
});
it('selects reach and phase before authority without compiler ambiguity between shadowed occurrences', () => {
  const root = workspace(),
    overlay = '.ia/src/override.ia';
  put(
    root,
    overlay,
    readFileSync(resolve(root, methodPath), 'utf8').replace(
      / {2}activation\n(?: {4}activate when .*\n)+/,
      '  activation\n    activate when phase is act\n',
    ),
  );
  const locations: Record<string, Location> = {
    [methodPath]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' },
    [overlay]: { placement: { kind: 'authored', band: 100, reach: 'team' }, provenance: 'workspace' },
  };
  const build = viewBuilder(readInputs(root, { locations }));
  expect(build().graph.nodes.get(methodId)?.source.path).toBe(methodPath);
  expect(build('team', 'act').graph.nodes.get(methodId)?.source.path).toBe(overlay);
  expect(build('team', 'orient').graph.nodes.get(methodId)?.source.path).toBe(methodPath);
  expect(build('team', 'act').report.findings.some((f) => f.code === 'IA-LANG-EDGE-TARGET-AMBIGUOUS')).toBe(false);
});
it('checks physical requirement duplicates across bands and disjoint reaches before authority', () => {
  const root = workspace(),
    overlay = '.ia/src/contract-overlay.ia';
  put(root, overlay, readFileSync(resolve(root, contractPath), 'utf8'));
  const view = viewBuilder(
    readInputs(root, {
      locations: { [overlay]: { placement: { kind: 'adopted', band: 90, reach: 'other' }, provenance: 'methodology' } },
    }),
  )();
  expect([...view.graph.nodes.values()].some((r) => r.name === 'foundation-authoring-contract')).toBe(false);
  const findings = view.report.findings.filter((f) => f.code === 'IA-LANG-REQUIREMENT-DUPLICATE');
  expect(findings).toHaveLength(6);
  expect(new Set(findings.map((f) => f.path))).toEqual(new Set([overlay, contractPath]));
});
it('resolves new vocabulary only in the locations where its system is visible', () => {
  const root = workspace(),
    prefix = '.ia/src/systems/extension';
  const before = [...viewBuilder(readInputs(root))().graph.nodes.keys()].sort();
  const files = {
    'system.ia':
      '#! ia 1.0\n@system extension\n  provider "fixture"\n  version "1.0.0"\n  steward @agent extension-steward\n  requires\n    - agent-system\n  discriminators\n    widget lowers to definition\n      category thing\n      facets [widget]\n      schema @schema widget\n  edges\n    cite * using *\n',
    'schemas/widget.ia': '#! ia 1.0\n@schema widget\n  lowers to definition\n  sections\n    open\n',
    'steward.ia':
      '#! ia 1.0\n@agent extension-steward\n  meaning\n    says "Own extension"\n    answers "Who owns widget?"\n  governance\n    applies [widget]\n',
    'records/one.ia': '#! ia 1.0\n@widget one\n',
  };
  const locations: Record<string, Location> = {};
  for (const [name, text] of Object.entries(files)) {
    const path = `${prefix}/${name}`;
    put(root, path, text);
    locations[path] = { placement: { kind: 'authored', band: 100, reach: 'team' }, provenance: 'workspace' };
  }
  const build = viewBuilder(readInputs(root, { locations })),
    outside = build(),
    inside = build('team');
  expect([...outside.graph.nodes.keys()].sort()).toEqual(before);
  expect(outside.admittedSystems).not.toContain('extension');
  expect(inside.graph.byDiscriminator.get('widget')).toHaveLength(1);
  expect(inside.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(inside.graph.revision).not.toBe(outside.graph.revision);
});
it('retains a malformed empty folder in revision and admission evidence', () => {
  const root = workspace(false),
    before = viewBuilder(readInputs(root))();
  mkdirSync(resolve(root, '.ia/src/systems/empty'), { recursive: true });
  const after = viewBuilder(readInputs(root))();
  expect(after.graph.revision).not.toBe(before.graph.revision);
  expect(after.report.findings.filter((f) => f.code === 'IA-COMP-SYSTEM-MALFORMED')).toHaveLength(1);
});
