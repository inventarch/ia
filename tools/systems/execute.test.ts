import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { open, readInputs } from '../../packages/db/src/index.js';
import { execute, executeWithContext } from './execute.js';
import * as execution from './execute.js';
import { publish } from './publish.js';
import * as publication from './publish.js';
import { portablePath } from './shared.js';
import { runScenarios } from './scenarios.js';
import { executionFixtureCodes, runExecutionFixtures } from './refusal-fixtures.js';
import { EXEC_CODES, ExecutionError } from './types.js';
import type { Result, Success } from './types.js';

import { createSystemFixture } from './fixture.js';
const repository = resolve(import.meta.dirname, '../..'),
  fixture = createSystemFixture(repository),
  root = fixture.root,
  temporary: string[] = [];
afterAll(() => fixture.close());
const agent = {
  path: '.ia/src/systems/agent-system/records/generated-expert.ia',
  text: '#! ia 1.0\n@agent generated-expert\n  meaning\n    says "An inert format fixture."\n    answers "Which draft is checked?"\n  governance\n    applies [agent]\n',
};
const template = {
  template: 'template-system/template/template/authored-note',
  values: { name: 'note', purpose: 'A concrete note' },
};
function temp(copy = true): string {
  const path = mkdtempSync(resolve(tmpdir(), 'ia-exec-tests-'));
  temporary.push(path);
  if (copy)
    cpSync(resolve(root, '.ia/src'), resolve(path, '.ia/src'), {
      recursive: true,
      filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
    });
  return path;
}
function success(result: Result): Success {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
function put(base: string, path: string, text: string): void {
  const target = resolve(base, path);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, text);
}
afterEach(() => {
  for (const path of temporary.splice(0)) {
    const rel = relative(tmpdir(), path);
    if (isAbsolute(rel) || !rel.startsWith('ia-exec-tests-') || rel.includes('..')) throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

it('executes every native case with actual success/refusal and owner attribution', () => {
  const result = runScenarios(root);
  expect(result.ok).toBe(true);
  expect(result.observations).toHaveLength(6);
  expect(result.missing).toEqual([]);
  for (const observation of result.observations.filter((o) => o.result.ok)) {
    const result = success(observation.result);
    expect(result.steward).toContain('/binding/agent/');
    expect(result.baseRevision).toMatch(/^[a-f0-9]{64}$/);
  }
  // A missing edge target is only a warning, so a renamed example record would still let these cases pass; require a clean draft.
  const draft = '.ia/src/systems/work-system/records/candidate.ia',
    work = result.observations.filter(
      (o) => o.result.ok && o.identity.startsWith('compliance-system/definition/scenario/work-'),
    );
  expect(work.map((o) => o.identity.split('/').pop()).sort()).toEqual([]);
  for (const o of work)
    expect({
      case: o.identity,
      findings: (success(o.result).evidence['findings'] as readonly { readonly path?: string }[]).filter(
        (f) => f.path === draft,
      ),
    }).toEqual({ case: o.identity, findings: [] });
  // The runner compares result codes only, so a work-system refusal could pass for another reason (an empty-diagnostic
  // refusal, #398 review). Require each one to refuse with exactly the diagnostic its scenario.expected names.
  const refused = result.observations.filter(
    (o) => !o.result.ok && o.identity.startsWith('compliance-system/definition/scenario/work-'),
  );
  expect(refused).toEqual([]);
  const cases = resolve(root, '.ia/src/systems/work-system/cases'),
    named = new Map(
      refused.length === 0
        ? []
        : readdirSync(cases).map((file) => {
            const text = readFileSync(resolve(cases, file), 'utf8');
            return [/^@case (\S+)$/m.exec(text)![1]!, /^ {4}expected ".* with (IA-[A-Z-]+):/m.exec(text)?.[1]] as const;
          }),
    );
  for (const o of refused) {
    const name = o.identity.split('/').pop()!,
      codes = o.result.ok
        ? []
        : (o.result.diagnostics as readonly { readonly severity: string; readonly code: string }[])
            .filter((d) => d.severity === 'error')
            .map((d) => d.code);
    expect({ case: name, codes }).toEqual({ case: name, codes: [named.get(name)] });
  }
}, 120_000);
it('observes every platform-reachable executable refusal code through real handlers and isolated publication', () => {
  const result = runExecutionFixtures(repository);
  expect(result).toHaveLength(8);
  expect(result.every((r) => r.assessment.outcome === 'pass')).toBe(true);
  expect([...new Set(result.flatMap((r) => r.observedCodes))].sort()).toEqual([...executionFixtureCodes()].sort());
});
it('qualifies executable refusal coverage on an unsupported platform without crediting existing output', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const result = runExecutionFixtures(repository);
    expect(result).toHaveLength(8);
    expect(new Set(result.map((row) => row.assessment.scope)).size).toBe(8);
    expect(result.every((row) => row.assessment.outcome === 'pass')).toBe(true);
    expect([...new Set(result.flatMap((row) => row.observedCodes))].sort()).toEqual(
      EXEC_CODES.filter((code) => code !== 'IA-EXEC-OUTPUT-EXISTS').sort(),
    );
    expect(result.some((row) => row.observedCodes.includes('IA-EXEC-OUTPUT-EXISTS'))).toBe(false);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});
it('does not credit an unrelated unsafe-output failure as platform unavailability', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const publish = vi.spyOn(publication, 'publish').mockImplementation(() => {
    throw new ExecutionError('IA-EXEC-OUTPUT-UNSAFE', 'Unrelated fixture failure');
  });
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const result = runExecutionFixtures(repository).find(
      (row) => row.assessment.scope === 'execution/publication-unavailable',
    );
    expect(result?.assessment.outcome).toBe('fail');
    expect(result?.observedCodes).toEqual([]);
  } finally {
    publish.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  }
});
it('does not credit draft preparation refusal as an observed publication refusal', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const execute = vi
    .spyOn(execution, 'execute')
    .mockReturnValue({ ok: false, code: 'IA-EXEC-OUTPUT-UNSAFE', message: 'Unrelated draft refusal', diagnostics: [] });
  const publish = vi.spyOn(publication, 'publish');
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const result = runExecutionFixtures(repository).find(
      (row) => row.assessment.scope === 'execution/publication-unavailable',
    );
    expect(result?.assessment.outcome).toBe('fail');
    expect(result?.observedCodes).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  } finally {
    execute.mockRestore();
    publish.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  }
});
it.each([
  new ExecutionError(
    'IA-EXEC-OUTPUT-UNSAFE',
    'Cannot qualify the publication filesystem: spawnSync powershell.exe ETIMEDOUT',
  ),
  new Error('Unexpected fixture setup failure'),
])('retains the underlying publication failure in fixture mismatch diagnostics: %s', (failure) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const publish = vi.spyOn(publication, 'publish').mockImplementation(() => {
    throw failure;
  });
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const result = runExecutionFixtures(repository).find(
      (row) => row.assessment.scope === 'execution/IA-EXEC-OUTPUT-EXISTS',
    );
    expect(result?.assessment.outcome).toBe('fail');
    expect(result?.observedCodes).toEqual(failure instanceof ExecutionError ? [failure.code] : []);
    expect(result?.assessment.findings[0]?.message).toContain(failure.message);
  } finally {
    publish.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  }
});
it('uses the real schema and folder admission and refuses invalid base corpora', () => {
  const base = temp();
  const rejected = execute(base, 'validate-ia', {
    path: '.ia/src/systems/agent-system/records/foreign.ia',
    text: '#! ia 1.0\n@hook generated-guard\n  meaning\n    says "An inert foreign-placement fixture."\n    answers "Which owner rejects this word?"\n  hook\n    event PreToolUse\n    tools [Write]\n    paths ["fixture"]\n    message "Fixture only."\n',
  });
  expect(rejected).toMatchObject({ ok: false, code: 'IA-EXEC-VALIDATION-FAILED' });
  if (!rejected.ok)
    expect(rejected.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'IA-COMP-DISCRIMINATOR-FOREIGN' })]),
    );
  const path = '.ia/src/systems/agent-system/system.ia';
  put(base, path, readFileSync(resolve(base, path), 'utf8').replace('    applies [agent, mandate]\n', ''));
  expect(execute(base, 'format-ia', agent)).toMatchObject({ ok: false, code: 'IA-EXEC-VALIDATION-FAILED' });
});
it('formats through the preservation guard and validates the resulting source', () => {
  const authored = success(execute(root, 'format-ia', agent)).artifacts[0]!;
  const result = success(
    execute(root, 'format-ia', { path: agent.path, text: authored.text.replace('    says ', '    says    ') }),
  );
  expect(result.artifacts[0]!.text).toContain('  meaning\n    says');
  expect(result.evidence['findings']).toEqual(expect.any(Array));
  expect(execute(root, 'format-ia', { path: agent.path, text: 'malformed' })).toMatchObject({
    ok: false,
    code: 'IA-EXEC-VALIDATION-FAILED',
  });
});
it('renders templates once and rejects missing, extra or unsafe parameter results', () => {
  const result = success(
    execute(root, 'render-template', { ...template, values: { name: 'example', purpose: '{{name}} remains literal' } }),
  );
  expect(result.artifacts).toEqual([{ path: 'notes/example.md', text: '# example\n\n{{name}} remains literal\n' }]);
  for (const values of [{ name: 'only' }, { ...template.values, extra: 'x' }, { ...template.values, purpose: 1 }])
    expect(execute(root, 'render-template', { ...template, values })).toMatchObject({
      ok: false,
      code: 'IA-EXEC-INPUT-INVALID',
    });
  for (const name of ['../../escape', 'CON', 'foo\\bar', 'bad:stream'])
    expect(execute(root, 'render-template', { ...template, values: { ...template.values, name } })).toMatchObject({
      ok: false,
      code: 'IA-EXEC-OUTPUT-UNSAFE',
    });
});
it('validates authored template semantics and previews generated IA files', () => {
  const base = temp(),
    path = '.ia/src/systems/template-system/records/authored-note.ia',
    original = readFileSync(resolve(base, path), 'utf8');
  put(base, path, original.replace('{{purpose}}', '{{undeclared}}'));
  expect(execute(base, 'render-template', template)).toMatchObject({ ok: false, code: 'IA-EXEC-TEMPLATE-INVALID' });
  const ia = success(execute(base, 'format-ia', agent)).artifacts[0]!.text;
  put(
    base,
    path,
    original
      .replace('"notes/{{name}}.md"', '".ia/src/systems/agent-system/records/{{name}}.ia"')
      .replace('lines ["# {{name}}", "", "{{purpose}}", ""]', 'lines ["{{purpose}}"]'),
  );
  const result = success(execute(base, 'render-template', { ...template, values: { name: 'draft', purpose: ia } }));
  expect(result.candidateRevision).toBeDefined();
  expect(execute(base, 'render-template', { ...template, values: { name: 'bad', purpose: 'bad IA' } })).toMatchObject({
    ok: false,
    code: 'IA-EXEC-VALIDATION-FAILED',
  });
});
it.skipIf(process.platform !== 'win32')(
  'publishes new draft artifacts and a manifest, refuses overwrite and leaves source unchanged',
  () => {
    const base = temp(),
      before = readInputs(base).fingerprint,
      result = success(execute(base, 'format-ia', agent));
    const path = publish(base, result, 'review-one');
    expect(readFileSync(resolve(base, path, agent.path), 'utf8')).toBe(result.artifacts[0]!.text);
    expect(JSON.parse(readFileSync(resolve(base, path, 'result.json'), 'utf8'))).toMatchObject({
      ok: true,
      published: path,
      operation: result.operation,
    });
    expect(readInputs(base).fingerprint).toBe(before);
    expect(() => publish(base, result, 'review-one')).toThrow(
      expect.objectContaining({ code: 'IA-EXEC-OUTPUT-EXISTS' }),
    );
    expect(readdirSync(resolve(base, '.ia/work/generated'))).toEqual(['review-one']);
  },
);
it('rejects aliases, portable-path violations, collisions and stale publication before writing', () => {
  const base = temp(),
    outside = temp(false),
    result = success(execute(base, 'render-template', template));
  symlinkSync(outside, resolve(base, '.ia/work'), 'junction');
  expect(() => publish(base, result, 'alias')).toThrow(expect.objectContaining({ code: 'IA-EXEC-OUTPUT-UNSAFE' }));
  expect(readdirSync(outside)).toEqual([]);
  for (const path of [
    '../escape',
    '/absolute',
    'C:/outside',
    'Result.JSON',
    'result.json/child',
    'dir/NUL.txt',
    'dir/COM¹.log',
    'dir/LPT²',
    'trailing.',
    'a//b',
  ])
    expect(() => portablePath(path)).toThrow();
  const clean = temp(),
    fresh = success(execute(clean, 'render-template', template));
  expect(() =>
    publish(
      clean,
      {
        ...fresh,
        artifacts: [
          { path: 'a', text: '' },
          { path: 'a/child', text: '' },
        ],
      },
      'collision',
    ),
  ).toThrow(expect.objectContaining({ code: 'IA-EXEC-OUTPUT-UNSAFE' }));
  put(clean, '.ia/src/systems/template-system/records/changed.ia', '#! ia 1.0\n');
  expect(() => publish(clean, fresh, 'stale')).toThrow(expect.objectContaining({ code: 'IA-EXEC-SOURCE-CHANGED' }));
  expect(existsSync(resolve(clean, '.ia/work/generated'))).toBe(false);
});
it('rechecks source revision after a handler and refuses a stale input snapshot', () => {
  const base = temp(),
    db = open(base, { cache: false });
  try {
    const context = { db, records: db.records() };
    put(base, '.ia/src/systems/template-system/records/changed.ia', '#! ia 1.0\n');
    expect(() => executeWithContext(context, 'render-template', template)).toThrow(
      expect.objectContaining({ code: 'IA-EXEC-SOURCE-CHANGED' }),
    );
  } finally {
    db.close();
  }
});
it('runs the actual command with stdin, fixed host code and bounded optional publication', () => {
  const base = temp();
  put(base, '.ia/src/systems/authoring-system/execute.ts', 'throw new Error("Never load code from --root")');
  const before = readInputs(base).fingerprint;
  const call = (args: string[], input?: string) =>
    spawnSync(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', resolve(repository, 'tools/systems/run.ts'), ...args],
      { cwd: repository, ...(input === undefined ? {} : { input }), encoding: 'utf8', timeout: 15000 },
    );
  const stderr = (text: string) =>
    text.replace(
      /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/g,
      '',
    );
  const args = ['--operation', 'format-ia', '--root', base, '--input', '-'];
  const result = call(args, JSON.stringify(agent)),
    draft = JSON.parse(result.stdout);
  expect(result.status).toBe(0);
  expect(draft).toMatchObject({
    ok: true,
    owner: 'authoring-system',
    artifacts: [{ path: agent.path, text: expect.any(String) }],
  });
  expect(draft).not.toHaveProperty('published');
  expect(existsSync(resolve(base, '.ia/work'))).toBe(false);
  expect(stderr(result.stderr)).toBe('');
  const publication = call([...args, '--out', 'command-review'], JSON.stringify(agent)),
    output = JSON.parse(publication.stdout);
  expect(stderr(publication.stderr)).toBe('');
  if (process.platform === 'win32') {
    expect(publication.status).toBe(0);
    expect(output).toMatchObject({
      ok: true,
      owner: 'authoring-system',
      published: '.ia/work/generated/command-review',
    });
    expect(readFileSync(resolve(base, output.published, agent.path), 'utf8')).toBe(draft.artifacts[0].text);
  } else {
    expect(publication.status).toBe(1);
    expect(output).toEqual({
      ok: false,
      code: 'IA-EXEC-OUTPUT-UNSAFE',
      message: expect.stringContaining('Managed publication requires a qualified local Windows NTFS root'),
      diagnostics: [],
    });
    expect(existsSync(resolve(base, '.ia/work'))).toBe(false);
  }
  expect(readInputs(base).fingerprint).toBe(before);
  expect(call(['--help']).stdout).toContain('validate-ia');
  for (const args of [
    [],
    ['--operation'],
    ['--operation', 'validate-ia', '--input', '{'],
    ['--operation', 'validate-ia', '--input', '{}', '--bogus', 'x'],
  ]) {
    const invalid = call(args);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout).code).toBe('IA-EXEC-INPUT-INVALID');
  }
});
it('refuses mismatched native scenario kinds rather than crediting a declared expectation', () => {
  const base = temp(),
    path = '.ia/src/systems/authoring-system/cases/validate-ia-refusal.ia';
  put(base, path, readFileSync(resolve(base, path), 'utf8').replace('kind refusal', 'kind success'));
  const result = runScenarios(base);
  expect(result.ok).toBe(false);
  expect(result.missing).toContain('validate-ia/refusal');
}, 120_000);
