/**
 * The consumer argument grammar: docs/specs/consumer-cli-contract/README.md §2.0.
 *
 * `--flag value` and `--flag=value`, boolean flags, a bare `--` separator, repeatable flags and repeatable
 * positionals. A command declares its shape in a table and the parser enforces it, so no handler reads a flag
 * name of its own. Every refusal here is IA-CLI-USAGE at exit 2 (§3) and happens before any workspace,
 * installation state, cache or network read.
 */

export class UsageError extends Error {
  readonly code = 'IA-CLI-USAGE';
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface OptionSpec {
  readonly name: string;
  readonly kind: 'boolean' | 'value';
  /** One-letter alias, matched as an exact token; bundling such as `-qy` is not admitted. */
  readonly short?: string;
  readonly repeatable?: boolean;
  /** A closed value set. A value outside it is a usage error, not a later refusal. */
  readonly values?: readonly string[];
  readonly integer?: { readonly min: number; readonly max?: number };
  /** How the value is spelled in help; defaults to the value set, or `<value>`. */
  readonly placeholder?: string;
  readonly required?: boolean;
  /** Names that may not appear alongside this one, in either order. */
  readonly conflicts?: readonly string[];
  /** §2.2: `--schema` and `--example` are meaningless without the word they describe. */
  readonly needsPositional?: boolean;
  /** §2.8: `--requests` carries the set the positionals would have carried. */
  readonly excludesPositionals?: boolean;
  /** §2.1 rejects the common `--root` for `ia init`; the reason is stated rather than spelled as "unknown". */
  readonly refuse?: string;
  readonly summary: string;
}
export interface PositionalSpec {
  readonly name: string;
  readonly min: number;
  /** `Number.POSITIVE_INFINITY` for a repeatable positional. */
  readonly max: number;
}
export interface Grammar {
  readonly options: readonly OptionSpec[];
  readonly positionals: PositionalSpec;
}

export interface Arguments {
  readonly positionals: readonly string[];
  /** True when the boolean flag was supplied. */
  readonly flag: (name: string) => boolean;
  /** The single value of a non-repeatable value flag. */
  readonly value: (name: string) => string | undefined;
  /** Every occurrence of a repeatable value flag, in the order supplied. */
  readonly list: (name: string) => readonly string[];
  readonly integer: (name: string, fallback: number) => number;
}

const NO_POSITIONALS: PositionalSpec = { name: 'argument', min: 0, max: 0 };
export const positionals = (name: string, min: number, max: number): PositionalSpec => ({ name, min, max });
export const none = NO_POSITIONALS;

const label = (option: OptionSpec): string => `--${option.name}`;

/** §2.0. Pure: the same argv and grammar always produce the same result or the same refusal. */
export function parseArguments(argv: readonly string[], grammar: Grammar): Arguments {
  const byToken = new Map<string, OptionSpec>();
  for (const option of grammar.options) {
    byToken.set(`--${option.name}`, option);
    if (option.short !== undefined) byToken.set(`-${option.short}`, option);
  }
  const values = new Map<string, string[]>(),
    flags = new Set<string>(),
    rest: string[] = [];
  let separated = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!separated && token === '--') {
      separated = true;
      continue;
    }
    if (separated || !token.startsWith('-') || token === '-') {
      rest.push(token);
      continue;
    }
    const split = token.indexOf('='),
      key = split === -1 ? token : token.slice(0, split);
    const option = byToken.get(key);
    if (option === undefined) throw new UsageError(`Unknown option ${key}`);
    if (option.refuse !== undefined) throw new UsageError(option.refuse);
    if (option.kind === 'boolean') {
      if (split !== -1) throw new UsageError(`Option ${label(option)} does not take a value`);
      if (flags.has(option.name)) throw new UsageError(`Duplicate option ${label(option)}`);
      flags.add(option.name);
      continue;
    }
    // A separate token is taken as the value unless it is itself a declared option, so `--search -x` works and
    // `--severity --json` refuses instead of silently swallowing the next flag. `--flag=value` escapes both.
    const next = argv[index + 1];
    const supplied =
      split === -1 ? (next !== undefined && byToken.has(next) ? undefined : next) : token.slice(split + 1);
    if (supplied === undefined || supplied === '') throw new UsageError(`Option ${label(option)} requires a value`);
    if (split === -1) index += 1;
    const seen = values.get(option.name);
    if (seen !== undefined && option.repeatable !== true) throw new UsageError(`Duplicate option ${label(option)}`);
    if (seen === undefined) values.set(option.name, [supplied]);
    else seen.push(supplied);
  }

  for (const option of grammar.options) {
    const present = option.kind === 'boolean' ? flags.has(option.name) : values.has(option.name);
    if (!present) {
      if (option.required === true) throw new UsageError(`Option ${label(option)} is required`);
      continue;
    }
    for (const other of option.conflicts ?? []) {
      const conflicting = flags.has(other) || values.has(other);
      if (conflicting) throw new UsageError(`Options ${label(option)} and --${other} are mutually exclusive`);
    }
    if (option.needsPositional === true && rest.length === 0)
      throw new UsageError(`Option ${label(option)} requires <${grammar.positionals.name}>`);
    if (option.excludesPositionals === true && rest.length > 0)
      throw new UsageError(`Option ${label(option)} and <${grammar.positionals.name}> are mutually exclusive`);
    for (const value of values.get(option.name) ?? []) {
      if (option.values !== undefined && !option.values.includes(value))
        throw new UsageError(`Option ${label(option)} accepts ${option.values.join(', ')}; got ${value}`);
      if (option.integer !== undefined) {
        const parsed = Number(value),
          { min, max } = option.integer;
        if (
          !/^-?\d+$/.test(value) ||
          !Number.isSafeInteger(parsed) ||
          parsed < min ||
          (max !== undefined && parsed > max)
        )
          throw new UsageError(
            `Option ${label(option)} accepts an integer ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}; got ${value}`,
          );
      }
    }
  }
  const spec = grammar.positionals;
  if (rest.length > spec.max)
    throw new UsageError(
      spec.max === 0
        ? `Unexpected argument ${rest[0]}`
        : `Expected at most ${spec.max} <${spec.name}>; got ${rest.length}`,
    );
  if (rest.length < spec.min) throw new UsageError(`Expected <${spec.name}>`);

  return {
    positionals: rest,
    flag: (name) => flags.has(name),
    value: (name) => values.get(name)?.[0],
    list: (name) => values.get(name) ?? [],
    integer: (name, fallback) => {
      const raw = values.get(name)?.[0];
      return raw === undefined ? fallback : Number(raw);
    },
  };
}
