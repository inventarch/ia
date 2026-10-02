import { expect, it } from 'vitest';
import { none, parseArguments, positionals, UsageError } from '../src/args.js';
import type { Grammar, OptionSpec } from '../src/args.js';
import { COMMANDS, findCommand, nearestTokens } from '../src/commands.js';

const option = (spec: OptionSpec): OptionSpec => spec;
const OPTIONS: readonly OptionSpec[] = [
  option({ name: 'root', kind: 'value', summary: 'root' }),
  option({ name: 'json', kind: 'boolean', summary: 'json' }),
  option({ name: 'quiet', kind: 'boolean', short: 'q', summary: 'quiet' }),
  option({ name: 'color', kind: 'boolean', conflicts: ['no-color'], summary: 'color' }),
  option({ name: 'no-color', kind: 'boolean', summary: 'no colour' }),
  option({ name: 'domain', kind: 'value', repeatable: true, summary: 'domain' }),
  option({ name: 'severity', kind: 'value', values: ['error', 'warning'], summary: 'severity' }),
  option({ name: 'depth', kind: 'value', integer: { min: 0, max: 3 }, summary: 'depth' }),
  option({ name: 'count', kind: 'value', integer: { min: 1 }, summary: 'count' }),
  option({ name: 'to', kind: 'value', required: true, summary: 'to' }),
  option({ name: 'schema', kind: 'boolean', needsPositional: true, summary: 'schema' }),
  option({ name: 'requests', kind: 'value', excludesPositionals: true, summary: 'requests' }),
  option({ name: 'banned', kind: 'value', refuse: 'banned is not accepted here', summary: 'banned' }),
];
const grammar = (max = Number.POSITIVE_INFINITY, min = 0): Grammar => ({
  options: OPTIONS,
  positionals: max === 0 ? none : positionals('path', min, max),
});
const parse = (argv: readonly string[], shape: Grammar = grammar()) => parseArguments(['--to', 'x', ...argv], shape);
const refuses = (argv: readonly string[], shape: Grammar = grammar()): string => {
  try {
    parseArguments(['--to', 'x', ...argv], shape);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe('IA-CLI-USAGE');
    return (error as UsageError).message;
  }
  throw new Error(`Expected a usage refusal for ${JSON.stringify(argv)}`);
};

it('accepts both value spellings, boolean flags, short aliases and repeatable options', () => {
  const args = parse(['--root', 'a', '--domain=one', '--domain', 'two', '-q', '--json']);
  expect(args.value('root')).toBe('a');
  expect(args.list('domain')).toEqual(['one', 'two']);
  expect(args.flag('quiet')).toBe(true);
  expect(args.flag('json')).toBe(true);
  expect(args.flag('color')).toBe(false);
  expect(args.value('severity')).toBeUndefined();
  expect(args.integer('depth', 1)).toBe(1);
  expect(parse(['--depth=0']).integer('depth', 1)).toBe(0);
  expect(parse(['--root=with spaces']).value('root')).toBe('with spaces');
});

it('collects repeatable positionals and admits leading dashes only after a bare separator', () => {
  expect(parse(['one', 'two', 'three']).positionals).toEqual(['one', 'two', 'three']);
  expect(parse(['--json', 'one', '--root', 'r', 'two']).positionals).toEqual(['one', 'two']);
  expect(parse(['--', '--json', '-q']).positionals).toEqual(['--json', '-q']);
  expect(parse(['--json', '--', '--root']).flag('json')).toBe(true);
  expect(parse(['--json', '--', '--root']).positionals).toEqual(['--root']);
  expect(refuses(['-x'])).toContain('Unknown option -x');
  expect(refuses(['--nope'])).toContain('Unknown option --nope');
  // A lone `-` is a positional token in the legacy protocol, so it is never silently read as a flag here.
  expect(parse(['-']).positionals).toEqual(['-']);
});

it('refuses duplicates, missing values, unknown values and mutually exclusive combinations', () => {
  expect(refuses(['--root', 'a', '--root', 'b'])).toBe('Duplicate option --root');
  expect(refuses(['--json', '--json'])).toBe('Duplicate option --json');
  expect(refuses(['--root'])).toBe('Option --root requires a value');
  expect(refuses(['--root', '--json'])).toBe('Option --root requires a value');
  expect(refuses(['--root='])).toBe('Option --root requires a value');
  expect(refuses(['--json=1'])).toBe('Option --json does not take a value');
  expect(refuses(['--color', '--no-color'])).toBe('Options --color and --no-color are mutually exclusive');
  expect(refuses(['--no-color', '--color'])).toBe('Options --color and --no-color are mutually exclusive');
  expect(refuses(['--severity', 'loud'])).toBe('Option --severity accepts error, warning; got loud');
  expect(refuses(['--depth', '4'])).toBe('Option --depth accepts an integer from 0 to 3; got 4');
  expect(refuses(['--depth', 'deep'])).toContain('accepts an integer from 0 to 3');
  expect(refuses(['--count', '0'])).toBe('Option --count accepts an integer of at least 1; got 0');
  expect(refuses(['--banned', 'x'])).toBe('banned is not accepted here');
  expect(parse(['--domain', 'a', '--domain', 'a']).list('domain')).toEqual(['a', 'a']);
});

it('enforces required options, dependent options and positional arity before anything is read', () => {
  expect(() => parseArguments([], grammar())).toThrow('Option --to is required');
  expect(refuses(['--schema'])).toBe('Option --schema requires <path>');
  expect(parse(['--schema', 'word']).flag('schema')).toBe(true);
  expect(refuses(['--requests', 'file.json', 'one'])).toBe('Option --requests and <path> are mutually exclusive');
  expect(refuses(['a', 'b'], grammar(1))).toBe('Expected at most 1 <path>; got 2');
  expect(refuses([], grammar(1, 1))).toBe('Expected <path>');
  expect(refuses(['a'], grammar(0))).toBe('Unexpected argument a');
});

it('gives every shipped command a grammar that admits its own documented syntax', () => {
  for (const command of COMMANDS) {
    expect(command.syntax[0]).toContain(`ia ${command.name}`);
    const names = command.grammar.options.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('help');
    expect(names).toContain('json');
    // Every flag the syntax line names has to exist in the grammar, or the help would document a refusal.
    for (const flag of command.syntax.join(' ').matchAll(/--([a-z-]+)/g)) expect(names).toContain(flag[1]);
  }
  // Every surface is implemented: since M5.3 no row carries a refusal note, and init's --host names what it does.
  expect(COMMANDS.filter((command) => 'unimplemented' in command).map((command) => command.name)).toEqual([]);
  expect(findCommand('init')?.grammar.options.find((row) => row.name === 'host')?.summary).toBe(
    'Host to register after initialization',
  );
  expect(findCommand('nope')).toBeUndefined();
});

it('suggests only genuinely near tokens and refuses to guess at an unrelated word', () => {
  expect(
    nearestTokens(
      'validte',
      COMMANDS.map((command) => command.name),
    ),
  ).toEqual(['validate']);
  expect(
    nearestTokens(
      'vocab',
      COMMANDS.map((command) => command.name),
    ),
  ).toEqual([]);
  expect(
    nearestTokens(
      'xyzzy',
      COMMANDS.map((command) => command.name),
    ),
  ).toEqual([]);
  expect(nearestTokens('instal', ['install', 'inspect'])).toEqual(['install']);
});
