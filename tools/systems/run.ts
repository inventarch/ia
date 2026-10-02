import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { execute, refusal } from './execute.js';
import { publish } from './publish.js';
import { ExecutionError } from './types.js';

export function run(
  args: readonly string[],
  stdin: () => string = () => readFileSync(0, 'utf8'),
): { readonly status: number; readonly output: string } {
  if (args.length === 1 && args[0] === '--help')
    return {
      status: 0,
      output:
        'Usage: pnpm system:run --operation <name> --input <JSON|-> [--root <absolute workspace>] [--out <new-run-id>]\nOperations: validate-ia, format-ia, render-template\n',
    };
  try {
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]!,
        value = args[i + 1];
      if (
        !['--operation', '--input', '--root', '--out'].includes(flag) ||
        value === undefined ||
        Object.hasOwn(options, flag)
      )
        throw new ExecutionError('IA-EXEC-INPUT-INVALID', 'Unknown, duplicated or incomplete command option');
      options[flag] = value;
    }
    if (
      !options['--operation'] ||
      !options['--input'] ||
      (options['--root'] !== undefined && !isAbsolute(options['--root']))
    )
      throw new ExecutionError('IA-EXEC-INPUT-INVALID', 'Operation/input are required; explicit root must be absolute');
    let input: unknown;
    try {
      input = JSON.parse(options['--input'] === '-' ? stdin() : options['--input']);
    } catch {
      throw new ExecutionError('IA-EXEC-INPUT-INVALID', 'Input must be valid JSON');
    }
    const root = options['--root'] ?? resolve(import.meta.dirname, '../..'),
      result = execute(root, options['--operation'], input);
    const published = result.ok && options['--out'] !== undefined ? publish(root, result, options['--out']) : undefined;
    return {
      status: result.ok ? 0 : 1,
      output: JSON.stringify({ ...result, ...(published === undefined ? {} : { published }) }) + '\n',
    };
  } catch (error) {
    return {
      status: error instanceof ExecutionError && error.code === 'IA-EXEC-INPUT-INVALID' ? 2 : 1,
      output: JSON.stringify(refusal(error)) + '\n',
    };
  }
}
if (isEntry(process.argv[1], import.meta.url)) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.status;
}
