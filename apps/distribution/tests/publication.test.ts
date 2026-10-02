import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectionManifest, ProjectionResult } from '@ia/agent-composition-system/projections';
import { checkProjection, publishProjection, recoverProjection, removeProjection } from '../src/publication.js';
import { digest, sha256 } from '../src/files.js';

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'ia-publication-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.includes('ia-publication-test-'))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function product(version = 'one', config = false): Extract<ProjectionResult, { status: 'compiled' }> {
  const files = [
    { path: '.agents/skills/review/SKILL.md', content: `# Review ${version}\n` },
    { path: `.codex/agents/${version}.toml`, content: `name = "${version}"\n` },
    ...(config
      ? [
          {
            path: '.codex/config.toml',
            content: `[agents."review"]\ndescription = "${version}"\nconfig_file = "agents/${version}.toml"\n`,
          },
        ]
      : []),
  ].map((f) => ({ ...f, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content), encoding: 'utf8' as const }));
  const body: Omit<ProjectionManifest, 'digest'> = {
    format: 'ia.projection-manifest.v1',
    product: 'workspace',
    sourceRevisions: [],
    descriptorDigest: 'a'.repeat(64),
    resourcesDigest: 'b'.repeat(64),
    inventoryDigest: 'c'.repeat(64),
    profiles: [],
    exports: [],
    outputs: files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      sha256: f.sha256,
      role: 'agent',
      sources: [],
      resources: [],
    })),
    omissions: [],
    enforcement: [],
  };
  return {
    format: 'ia.projection-result.v1',
    status: 'compiled',
    files,
    diagnostics: [],
    manifest: { ...body, digest: digest(body) },
  };
}
const id = 'review-codex-workspace';
const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');
const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

describe('managed projection publication', () => {
  it('checks without writes, regenerates, removes obsolete exports and preserves unrelated files', () => {
    const root = temporary();
    put(root, 'notes.txt', 'authored');
    expect(checkProjection(root, id, product()).status).toBe('stale');
    expect(existsSync(join(root, '.ia'))).toBe(false);
    expect(publishProjection(root, id, product()).status).toBe('published');
    expect(checkProjection(root, id, product()).status).toBe('current');
    expect(checkProjection(root, id, product('two')).status).toBe('stale');
    publishProjection(root, id, product('two'));
    expect(existsSync(join(root, '.codex/agents/one.toml'))).toBe(false);
    expect(read(root, '.agents/skills/review/SKILL.md')).toContain('two');
    removeProjection(root, id);
    expect(existsSync(join(root, '.agents/skills/review/SKILL.md'))).toBe(false);
    expect(read(root, 'notes.txt')).toBe('authored');
  });
  it('preflights all collisions before modifying an earlier output', () => {
    const root = temporary();
    publishProjection(root, id, product());
    put(root, '.codex/agents/two.toml', 'authored');
    expect(() => publishProjection(root, id, product('two'))).toThrow('Unmanaged output');
    expect(read(root, '.agents/skills/review/SKILL.md')).toContain('one');
    expect(existsSync(join(root, '.ia/distributions/projections/pending.json'))).toBe(false);
  });
  it('refuses edits to owned outputs on update, check and removal', () => {
    const root = temporary();
    publishProjection(root, id, product());
    put(root, '.agents/skills/review/SKILL.md', 'edited');
    for (const operation of [
      () => publishProjection(root, id, product('two')),
      () => checkProjection(root, id, product()),
      () => removeProjection(root, id),
    ])
      expect(operation).toThrow('Owned output changed');
    expect(read(root, '.agents/skills/review/SKILL.md')).toBe('edited');
  });
  it('preserves unrelated Codex bytes and subsequent edits across update and removal', () => {
    const root = temporary(),
      original = '# personal settings\r\nmodel = "gpt-5"\r\n[agents.existing]\r\ndescription = "Mine"\r\n';
    put(root, '.codex/config.toml', original);
    publishProjection(root, id, product('one', true));
    const added = '\n[features]\nmulti_agent = true\n';
    put(root, '.codex/config.toml', read(root, '.codex/config.toml') + added);
    expect(checkProjection(root, id, product('one', true)).status).toBe('current');
    publishProjection(root, id, product('two', true));
    expect(read(root, '.codex/config.toml').startsWith(original)).toBe(true);
    expect(read(root, '.codex/config.toml').endsWith(added)).toBe(true);
    expect(checkProjection(root, id, product('two', true)).status).toBe('current');
    removeProjection(root, id);
    expect(read(root, '.codex/config.toml')).toBe(original + added);
  });
  it.each([
    '[agents.review]\ndescription="mine"\n',
    '[agents."review"]\nconfig_file="mine"\n',
    'agents.review = {description="mine"}\n',
    'agents = {review={description="mine"}}\n',
    '[broken',
  ])('refuses conflicting/invalid TOML: %s', (text) => {
    const root = temporary();
    put(root, '.codex/config.toml', text);
    expect(() => publishProjection(root, id, product('one', true))).toThrow('configuration');
    expect(read(root, '.codex/config.toml')).toBe(text);
    expect(existsSync(join(root, '.agents/skills/review/SKILL.md'))).toBe(false);
  });
  it('refuses an edited registration block without changing other outputs', () => {
    const root = temporary();
    publishProjection(root, id, product('one', true));
    put(
      root,
      '.codex/config.toml',
      read(root, '.codex/config.toml').replace('description = "one"', 'description = "edited"'),
    );
    expect(() => publishProjection(root, id, product('two', true))).toThrow('registration block changed');
    expect(read(root, '.agents/skills/review/SKILL.md')).toContain('one');
  });
  it.each(['pending', 'output:0', 'output:1', 'output:2', 'output:3', 'commit', 'complete'])(
    'recovers the complete old or committed product after %s',
    (point) => {
      const root = temporary();
      publishProjection(root, id, product('one', true));
      expect(() =>
        publishProjection(root, id, product('two', true), {
          checkpoint: (name) => {
            if (name === point) throw new Error('power loss');
          },
        }),
      ).toThrow('power loss');
      if (point !== 'complete')
        expect(() => checkProjection(root, id, product('two', true))).toThrow('recover-projection');
      recoverProjection(root);
      const expected = ['commit', 'complete'].includes(point) ? 'two' : 'one';
      expect(checkProjection(root, id, product(expected, true)).status).toBe('current');
      expect(recoverProjection(root).status).toBe('current');
    },
  );
  it('recovers first publication and can recover an interrupted recovery', () => {
    const root = temporary();
    expect(() =>
      publishProjection(root, id, product(), {
        checkpoint: (n) => {
          if (n === 'output:1') throw new Error('stopped');
        },
      }),
    ).toThrow('stopped');
    expect(() =>
      recoverProjection(root, {
        checkpoint: () => {
          throw new Error('again');
        },
      }),
    ).toThrow('again');
    recoverProjection(root);
    expect(existsSync(join(root, '.agents/skills/review/SKILL.md'))).toBe(false);
    expect(checkProjection(root, id, product()).status).toBe('stale');
  });
  it('preflights recovery against local edits and refuses competing writers', () => {
    const root = temporary();
    publishProjection(root, id, product());
    expect(() =>
      publishProjection(root, id, product('two'), {
        checkpoint: (n) => {
          if (n === 'pending')
            expect(() => publishProjection(root, 'second', product())).toThrow('holds the output lock');
          if (n === 'output:0') throw new Error('stopped');
        },
      }),
    ).toThrow('stopped');
    put(root, '.codex/agents/one.toml', 'edited');
    expect(() => recoverProjection(root)).toThrow('local edit');
    expect(read(root, '.agents/skills/review/SKILL.md')).toContain('two');
    expect(read(root, '.codex/agents/one.toml')).toBe('edited');
  });
  it('refuses stale source before writes and rolls back if it changes before commit', () => {
    const root = temporary();
    let calls = 0;
    expect(() =>
      publishProjection(root, id, product(), {
        fresh: () => {
          if (++calls === 2) throw new Error('source changed');
        },
      }),
    ).toThrow('source changed');
    recoverProjection(root);
    expect(existsSync(join(root, '.agents/skills/review/SKILL.md'))).toBe(false);
  });
  it('rejects ancestor links, case aliases, unsafe output and forged recovery state', () => {
    const root = temporary(),
      external = temporary();
    symlinkSync(external, join(root, '.agents'), 'junction');
    expect(() => publishProjection(root, id, product())).toThrow('Link/junction');
    const other = temporary();
    put(other, '.agents/skills/Review/other.md', 'unrelated');
    expect(() => publishProjection(other, id, product())).toThrow('case alias');
    const forged = product();
    (forged.files[0] as { path: string }).path = '.ia/src/overwrite.ia';
    expect(() => publishProjection(temporary(), id, forged)).toThrow('Not a projection output');
  });
});
