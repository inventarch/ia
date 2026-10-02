import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  KINDS,
  LANGUAGE_VERSION,
  LANG_CODES,
  buildRegistry,
  compile,
  diag,
  isSeverity,
  parse,
  scan,
} from '../src/index.js';
import type {
  CompileResult,
  FrozenRegistry,
  KernelSeverity,
  Location,
  RegistryResult,
  Severity,
  Source,
} from '../src/index.js';

describe('package surface', () => {
  it('exports the version, parse, scan, the code set, the embed, the registry and the compiler', () => {
    expect(LANGUAGE_VERSION).toBe('1.0');
    expect(parse('#! ia 1.0\n@law x\n', 'a.ia').ast.records).toHaveLength(1);
    expect(scan('#! ia 1.0\n', 'a.ia').version).toBe('1.0');
    expect(LANG_CODES).toContain('IA-LANG-PRAGMA-MISSING');
    expect(KINDS).toHaveLength(7);
    const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
    const parsed = parse('#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0"\n', 'a.ia');
    const source: Source = { ...parsed, location };
    const built: RegistryResult = buildRegistry([source]);
    const { registry, diagnostics } = built;
    expectTypeOf(registry).toEqualTypeOf<FrozenRegistry>();
    expect(diagnostics).toEqual([]);
    const compiled: CompileResult = compile(parsed.ast, registry, location, []);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.records.map((r) => r.identity)).toEqual(['floor/definition/system/s']);
  });

  it('keeps diagnostic severity separate from the kernel severity dimension', () => {
    expectTypeOf<Severity>().toEqualTypeOf<'error' | 'warning'>();
    expectTypeOf<KernelSeverity>().toEqualTypeOf<'blocking' | 'advisory' | 'informational'>();
    expect(diag('IA-LANG-PRAGMA-MISSING', 'a.ia', 1, 'missing pragma').severity).toBe('error');
    expect(isSeverity('blocking')).toBe(true);
    expect(isSeverity('error')).toBe(false);
  });
});
