import { describe, expect, it } from 'vitest';
import { diag, isError, LANG_CODES } from '../src/diagnostics.js';

describe('diagnostics', () => {
  it('builds a diagnostic with path and line', () => {
    const d = diag('IA-LANG-PRAGMA-MISSING', 'a.ia', 1, 'file a.ia has no pragma');
    expect(d).toEqual({
      code: 'IA-LANG-PRAGMA-MISSING',
      severity: 'error',
      path: 'a.ia',
      line: 1,
      message: 'file a.ia has no pragma',
    });
    expect(isError(d)).toBe(true);
  });

  it('accepts an explicit warning severity and an end line', () => {
    const d = diag('IA-LANG-EDGE-TARGET-MISSING', 'a.ia', 4, 'no such target', { severity: 'warning', endLine: 4 });
    expect(d.severity).toBe('warning');
    expect(d.endLine).toBe(4);
    expect(isError(d)).toBe(false);
  });

  it('carries an identity only when one is given', () => {
    const with_ = diag('IA-LANG-IDENTITY-COLLISION', 'a.ia', 2, 'collides', { identity: 'floor/definition/system/x' });
    expect(with_.identity).toBe('floor/definition/system/x');
    const without = diag('IA-LANG-IDENTITY-COLLISION', 'a.ia', 2, 'collides');
    expect('identity' in without).toBe(false);
    expect('endLine' in without).toBe(false);
  });

  it('knows every parser code plan 1 emits', () => {
    for (const code of [
      'IA-LANG-PRAGMA-MISSING',
      'IA-LANG-VERSION-UNSUPPORTED',
      'IA-LANG-INDENT-TAB',
      'IA-LANG-INDENT-STEP',
      'IA-LANG-STRING-UNTERMINATED',
      'IA-LANG-PROSE-TRAILING',
      'IA-LANG-PROSE-UNTERMINATED',
      'IA-LANG-LIST-UNTERMINATED',
      'IA-LANG-HEADER-MALFORMED',
      'IA-LANG-HEAD-FIELD-AFTER-SECTION',
      'IA-LANG-TOPLEVEL-UNEXPECTED',
    ]) {
      expect(LANG_CODES).toContain(code);
    }
  });

  it('is a closed, well-formed, duplicate-free set of fifty-two codes', () => {
    expect(LANG_CODES).toHaveLength(52);
    expect(new Set(LANG_CODES).size).toBe(LANG_CODES.length);
    for (const code of LANG_CODES) expect(code).toMatch(/^IA-LANG-[A-Z]+(-[A-Z]+)*$/);
  });
});
