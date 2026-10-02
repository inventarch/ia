import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';
import { execute } from './execute.js';
import { publish } from './publish.js';
import { EXEC_CODES, ExecutionError } from './types.js';
import type { Result } from './types.js';

/** Diagnostics reachable through the current platform's real publication boundary. */
export function executionFixtureCodes(): readonly string[] {
  return process.platform === 'win32' ? EXEC_CODES : EXEC_CODES.filter((code) => code !== 'IA-EXEC-OUTPUT-EXISTS');
}

/** Run real effects only in a fresh bounded temporary copy of the native corpus. */
export function runExecutionFixtures(root: string): readonly FixtureResult[] {
  const temp = mkdtempSync(resolve(tmpdir(), 'ia-execution-fixtures-'));
  try {
    cpSync(resolve(root, '.ia/src'), resolve(temp, '.ia/src'), {
      recursive: true,
      filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
    });
    cpSync(
      resolve(root, 'tools/systems/fixtures/authored-note.ia'),
      resolve(temp, '.ia/src/systems/template-system/records/authored-note.ia'),
    );
    const template = {
      template: 'template-system/template/template/authored-note',
      values: { name: 'fixture', purpose: 'Actual generated artifact' },
    };
    const windows = process.platform === 'win32';
    const rows: readonly [string, () => Result | string, string?][] = [
      ['IA-EXEC-INPUT-INVALID', () => execute(temp, 'validate-ia', {})],
      ['IA-EXEC-OPERATION-UNAVAILABLE', () => execute(temp, 'absent-operation', {})],
      [
        'IA-EXEC-BINDING-MISMATCH',
        () => {
          const path = resolve(temp, '.ia/src/systems/authoring-system/operations/validate-ia.ia'),
            before = readFileSync(path, 'utf8');
          try {
            writeFileSync(path, before.replace('handler ia-validate', 'handler unknown-handler'));
            return execute(temp, 'validate-ia', {});
          } finally {
            writeFileSync(path, before);
          }
        },
      ],
      [
        'IA-EXEC-VALIDATION-FAILED',
        () =>
          execute(temp, 'validate-ia', {
            path: '.ia/src/systems/agent-system/records/bad.ia',
            text: '@agent missing-pragma\n',
          }),
      ],
      [
        'IA-EXEC-TEMPLATE-INVALID',
        () => execute(temp, 'render-template', { ...template, template: 'template-system/template/template/absent' }),
      ],
      [
        'IA-EXEC-OUTPUT-UNSAFE',
        () => execute(temp, 'render-template', { ...template, values: { ...template.values, name: '../../escape' } }),
      ],
      [
        windows ? 'IA-EXEC-OUTPUT-EXISTS' : 'IA-EXEC-OUTPUT-UNSAFE',
        () => {
          const result = execute(temp, 'render-template', template);
          if (!result.ok) throw new Error('Publication fixture requires a successfully prepared draft');
          if (windows) {
            publish(temp, result, 'fixture');
            return publish(temp, result, 'fixture');
          }
          try {
            return publish(temp, result, 'fixture');
          } catch (error) {
            if (
              !(error instanceof ExecutionError) ||
              error.code !== 'IA-EXEC-OUTPUT-UNSAFE' ||
              !error.message.includes('Managed publication requires a qualified local Windows NTFS root')
            )
              throw new Error('Expected the qualified-Windows-root publication refusal');
            throw error;
          } finally {
            if (existsSync(resolve(temp, '.ia/work')))
              throw new Error('Unsupported publication changed the filesystem');
          }
        },
        windows ? 'IA-EXEC-OUTPUT-EXISTS' : 'publication-unavailable',
      ],
      [
        'IA-EXEC-SOURCE-CHANGED',
        () => {
          const result = execute(temp, 'render-template', template);
          if (!result.ok) return result;
          const path = resolve(temp, '.ia/src/systems/template-system/records/authored-note.ia');
          writeFileSync(path, readFileSync(path, 'utf8') + '\n# changed after execution\n');
          return publish(temp, result, 'stale');
        },
      ],
    ];
    return rows.map(([expected, run, label]): FixtureResult => {
      let observedCodes: string[] = [],
        detail = '';
      try {
        const result = run();
        if (typeof result !== 'string' && !result.ok) {
          observedCodes = [result.code];
          detail = result.message;
        }
      } catch (error) {
        if (error instanceof ExecutionError) observedCodes = [error.code];
        detail = error instanceof Error ? error.message : String(error);
      }
      const findings: Finding[] = observedCodes.includes(expected)
        ? []
        : [
            {
              code: 'IA-COMP-FIXTURE-MISMATCH',
              severity: 'error',
              path: 'tools/systems',
              line: 1,
              message: `${expected}: observed ${observedCodes.join(', ') || 'no expected refusal'}${detail ? `; ${detail.slice(0, 2048)}` : ''}`,
            },
          ];
      return { assessment: assess('COMP-FIXTURES', `execution/${label ?? expected}`, findings), observedCodes };
    });
  } finally {
    const rel = relative(resolve(tmpdir()), temp);
    if (isAbsolute(rel) || !rel.startsWith('ia-execution-fixtures-') || rel.includes('..'))
      throw new Error('Unsafe fixture cleanup');
    rmSync(temp, { recursive: true, force: true });
  }
}
