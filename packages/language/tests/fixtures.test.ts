import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile/index.js';
import type { Diagnostic } from '../src/diagnostics.js';
import { parse } from '../src/parser/index.js';
import { buildRegistry } from '../src/registry/index.js';
import type { Location } from '../src/registry/types.js';
import { BAND_OF, PROVENANCES } from '../src/taxonomy.js';
import { checkFormatPreservation, format } from '../src/formatter.js';

const ROOT = resolve(import.meta.dirname, '../../compliance/fixtures/language');

/** The expectation files each mode admits beside a `<name>.ia`. */
const EXPECTATIONS = {
  pass: ['.ast.json', '.records.json', '.pool.json'],
  fail: ['.diagnostics.json', '.pool.json'],
} as const;

/** Clauses whose fixtures run the registry and the compiler after a clean parse; the others pin the parser alone. */
const COMPILE_CLAUSES: ReadonlySet<string> = new Set([
  'registry',
  'schema',
  'identity',
  'compile',
  'cells',
  'selectors',
  'edges',
  'conditions',
  'variants',
  'contracts',
  'cases',
]);

/** Every compile-stage fixture is one file at one authored location. */
const LOCATION: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };

interface Case {
  readonly clause: string;
  readonly mode: 'pass' | 'fail';
  readonly name: string;
  readonly dir: string;
}

/** The fixture cases, and everything in the fixture tree that is not a clause directory, a mode directory, a fixture or an expectation beside one. */
interface Listing {
  readonly cases: Case[];
  readonly strays: string[];
}

function listing(): Listing {
  const cases: Case[] = [];
  const strays: string[] = [];
  for (const clause of readdirSync(ROOT, { withFileTypes: true })) {
    if (!clause.isDirectory()) {
      strays.push(clause.name);
      continue;
    }
    const modes = readdirSync(join(ROOT, clause.name), { withFileTypes: true });
    for (const entry of modes) {
      if (!entry.isDirectory() || (entry.name !== 'pass' && entry.name !== 'fail'))
        strays.push(`${clause.name}/${entry.name}`);
    }
    for (const mode of ['pass', 'fail'] as const) {
      if (!modes.some((m) => m.isDirectory() && m.name === mode)) continue;
      const dir = join(ROOT, clause.name, mode);
      const entries = readdirSync(dir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile()).map((e) => e.name);
      for (const e of entries) {
        if (!e.isFile()) {
          strays.push(`${clause.name}/${mode}/${e.name}`);
          continue;
        }
        // Extensions are matched exactly; `.IA` is not a fixture.
        if (e.name.endsWith('.ia')) {
          cases.push({ clause: clause.name, mode, name: e.name.slice(0, -3), dir });
          continue;
        }
        const extensions: readonly string[] =
          clause.name === 'format'
            ? [...EXPECTATIONS[mode], mode === 'pass' ? '.formatted.txt' : '.candidate.txt']
            : EXPECTATIONS[mode];
        const suffix = extensions.find((s) => e.name.endsWith(s));
        if (suffix === undefined || !files.includes(`${e.name.slice(0, -suffix.length)}.ia`))
          strays.push(`${clause.name}/${mode}/${e.name}`);
      }
    }
  }
  // Sorted so the report reads the same on every filesystem.
  return { cases, strays: strays.sort() };
}

/** JSON.parse that names the file when it fails. */
function readJson(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const byLine = (a: Diagnostic, b: Diagnostic): number => a.line - b.line;

/** Parse, and for a compile-stage clause with a clean parse, build the registry from the file and compile it. */
function run(c: Case, source: string): { diagnostics: readonly Diagnostic[]; ast: unknown; records: unknown } {
  const parsed = parse(source, `${c.clause}/${c.mode}/${c.name}.ia`);
  if (c.clause === 'format') {
    if (c.mode === 'pass') {
      const result = format(source, parsed.ast.path);
      expect(result.text).toBe(readFileSync(join(c.dir, `${c.name}.formatted.txt`), 'utf8'));
      return { diagnostics: result.diagnostics, ast: parsed.ast, records: undefined };
    }
    const candidate = readFileSync(join(c.dir, `${c.name}.candidate.txt`), 'utf8');
    return {
      diagnostics: checkFormatPreservation(source, candidate, parsed.ast.path),
      ast: parsed.ast,
      records: undefined,
    };
  }
  if (!COMPILE_CLAUSES.has(c.clause) || parsed.diagnostics.length > 0)
    return { diagnostics: parsed.diagnostics, ast: parsed.ast, records: undefined };
  const poolFile = join(c.dir, `${c.name}.pool.json`);
  const external = existsSync(poolFile)
    ? (readJson(poolFile) as { readonly path: string; readonly source: string; readonly location: Location }[])
    : [];
  const poolSources = external.map((entry) => {
    expect(BAND_OF[entry.location.placement.kind]).toBe(entry.location.placement.band);
    expect(PROVENANCES).toContain(entry.location.provenance);
    return { ...parse(entry.source, entry.path), location: entry.location };
  });
  const built = buildRegistry([{ ...parsed, location: LOCATION }, ...poolSources]);
  const poolResults = poolSources.map((source) => compile(source.ast, built.registry, source.location, []));
  const compiled = compile(
    parsed.ast,
    built.registry,
    LOCATION,
    poolResults.flatMap((result) => result.records),
  );
  return {
    diagnostics: [
      ...built.diagnostics,
      ...poolResults.flatMap((result) => result.diagnostics),
      ...compiled.diagnostics,
    ].sort(byLine),
    ast: parsed.ast,
    records: compiled.records,
  };
}

describe('conformance fixtures', () => {
  const { cases, strays } = listing();
  it('has at least one fixture', () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  it('has nothing in the fixture tree but clause and mode directories, fixtures and the expectations beside them', () => {
    expect(strays.join('\n')).toBe('');
  });

  for (const c of cases) {
    it(`${c.clause}/${c.mode}/${c.name}`, () => {
      const source = readFileSync(join(c.dir, `${c.name}.ia`), 'utf8');
      const result = run(c, source);
      if (c.mode === 'pass') {
        expect(result.diagnostics).toEqual([]);
        const astFile = join(c.dir, `${c.name}.ast.json`);
        const recordsFile = join(c.dir, `${c.name}.records.json`);
        const wantAst = existsSync(astFile);
        const wantRecords = existsSync(recordsFile);
        // A parser clause pins the AST; a compile-stage clause pins the records and may pin the AST too.
        expect(COMPILE_CLAUSES.has(c.clause) ? wantRecords : wantAst).toBe(true);
        if (wantAst) expect(JSON.parse(JSON.stringify(result.ast))).toEqual(readJson(astFile));
        if (wantRecords) expect(JSON.parse(JSON.stringify(result.records))).toEqual(readJson(recordsFile));
      } else {
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.map((d) => ({ code: d.code, line: d.line }))).toEqual(
          readJson(join(c.dir, `${c.name}.diagnostics.json`)),
        );
      }
    });
  }
});
