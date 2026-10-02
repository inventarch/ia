import { describe, expect, it } from 'vitest';
import { canonicalPath } from '../src/paths.js';

describe('canonicalPath', () => {
  it('uses forward slashes and drops empty and dot segments', () => {
    expect(canonicalPath('systems\\agent-system\\system.ia')).toBe('systems/agent-system/system.ia');
    expect(canonicalPath('./a//b/./c.ia')).toBe('a/b/c.ia');
    expect(canonicalPath('a/b/../c.ia')).toBe('a/c.ia');
  });

  it('keeps a leading .. it cannot resolve and keeps case as given', () => {
    expect(canonicalPath('../x.ia')).toBe('../x.ia');
    expect(canonicalPath('a/../../x.ia')).toBe('../x.ia');
    expect(canonicalPath('Docs/Spec.IA')).toBe('Docs/Spec.IA');
  });

  it.each([
    ['.\\a//b\\..\\c.ia', 'a/c.ia'],
    ['a/b/c/../../d.ia', 'a/d.ia'],
    ['a/./../b/../c.ia', 'c.ia'],
    ['../../x.ia', '../../x.ia'],
    ['../a/../../x.ia', '../../x.ia'],
    ['a/../../../x.ia', '../../x.ia'],
    ['.././..//x.ia', '../../x.ia'],
    ['a/.../.hidden.ia', 'a/.../.hidden.ia'],
    ['Docs/My File.IA', 'Docs/My File.IA'],
    ['a/ ../b.ia', 'a/ ../b.ia'],
    ['a/b/../', 'a'],
    ['a/b/../..', ''],
  ])('normalizes %s to %s and is idempotent', (input, expected) => {
    const normalized = canonicalPath(input);
    expect(normalized).toBe(expected);
    expect(canonicalPath(normalized)).toBe(normalized);
  });
});
