import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Interrupted } from '../src/consumer.js';
import { applyInit, collectInit, gitIn } from '../src/init.js';
import { cleanup, scratch } from './scratch-fixture.js';
import { cli, repository, run } from './workspace-fixture.js';

afterAll(cleanup);
async function workspace(): Promise<string> {
  const root = join(scratch('host-plugin'), 'ws');
  const result = await run(['init', root, '--apply', '--yes', '--host', 'none', '--json']);
  expect(result.exitCode, result.stdout).toBe(0);
  return root;
}
const validate = (root: string) => run(['validate', '--root', root, '--json']);
const capability = (mode: string): string =>
  [
    '#! ia 1.0',
    '',
    '@capability probe-skill',
    '  meaning',
    '    says "A probe skill."',
    '    answers "Does the invocation section admit?"',
    '  execution',
    '    effects []',
    '  invocation',
    `    mode ${mode}`,
    '    argument-hint "[target]"',
    '    triggers ["probe this", "run the probe"]',
    '',
  ].join('\n');

describe('invocation section', () => {
  it('admits a capability invocation section', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.ia/src/probe.ia'), capability('user'));
    const result = await validate(root);
    expect(result.exitCode, result.stdout).toBe(0);
  });
  it('refuses an invocation mode outside the closed set', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.ia/src/probe.ia'), capability('sometimes'));
    const result = await validate(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('IA-COMP-FIELD-VALUE');
  });
});

describe('product section', () => {
  const distribution = (hosts: string): string =>
    [
      '#! ia 1.0',
      '',
      '@distribution probe-distribution',
      '  meaning',
      '    says "A probe plugin."',
      '    answers "Which records does the probe ship?"',
      '  distribution',
      '    records [@capability probe-skill]',
      '  product',
      '    name probe',
      '    display-name "Probe"',
      '    version "0.1.0"',
      '    description "A probe plugin."',
      `    hosts [${hosts}]`,
      '',
    ].join('\n');
  it('admits a product section', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.ia/src/probe.ia'), capability('user'));
    writeFileSync(join(root, '.ia/src/probe-distribution.ia'), distribution('claude, codex'));
    expect((await validate(root)).exitCode).toBe(0);
  });
  it('refuses a host outside the closed set', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.ia/src/probe.ia'), capability('user'));
    writeFileSync(join(root, '.ia/src/probe-distribution.ia'), distribution('claude, cursor'));
    const result = await validate(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('IA-COMP-FIELD-VALUE');
  });
});

const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;
const SAMPLE = resolve(repository, 'tools/projections/fixtures/host-plugin/sample');
async function lowered(): Promise<string> {
  const kit = join(scratch('host-plugin-kit'), 'sample-kit');
  const plan = await run(['init', kit, '--from', SAMPLE, '--json']);
  expect(plan.exitCode, plan.stdout).toBe(0);
  expect(existsSync(kit)).toBe(false);
  const applied = await run(['init', kit, '--from', SAMPLE, '--apply', '--yes', '--json']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  return kit;
}
describe('ia init --from', () => {
  it('plans without writing, then lowers the sample into an admitted workspace', async () => {
    const kit = await lowered();
    expect(readFileSync(join(kit, '.ia/src/systems/sample-kit/plugin/skills/sample-run/SKILL.body.md'), 'utf8')).toBe(
      '\nRun the sample method on $ARGUMENTS.\n',
    );
    const release = JSON.parse(readFileSync(join(kit, '.ia/release.json'), 'utf8')) as { assets: unknown[] };
    expect(release.assets).toContainEqual({
      path: 'assets/plugin/LICENSE',
      role: 'license',
    });
    expect((await validate(kit)).exitCode).toBe(0);
  });
  it('refuses a plugin with an unresolved construct and writes nothing', async () => {
    const plugin = join(scratch('host-plugin-hooks'), 'sample');
    cpSync(SAMPLE, plugin, { recursive: true });
    mkdirSync(join(plugin, 'hooks'));
    writeFileSync(join(plugin, 'hooks/hooks.json'), '{}\n');
    const kit = join(scratch('host-plugin-hooks-kit'), 'sample-kit');
    const result = await run(['init', kit, '--from', plugin, '--json']);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)['code']).toBe('IA-LOWER-UNRESOLVED');
    expect(result.stdout).toContain('hooks/hooks.json');
    expect(existsSync(kit)).toBe(false);
  });
  it('refuses a plugin directory that does not exist, even before a name resolves', async () => {
    const kit = join(scratch('host-plugin-missing-kit'), 'sample-kit');
    const result = await run(['init', kit, '--from', join(kit, 'no-such-plugin'), '--json']);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-INPUT');
    expect(existsSync(kit)).toBe(false);
  });
  it('reports the already-initialized conflict, not a lowering refusal', async () => {
    const kit = await lowered();
    const again = await run(['init', kit, '--from', SAMPLE, '--json']);
    expect(again.exitCode, again.stdout).toBe(0);
    expect(again.stdout).toContain('already initialized');
  });
  it('writes the lowered license asset with the sample bytes', async () => {
    const kit = await lowered();
    const written = readFileSync(join(kit, 'assets/plugin/LICENSE'));
    expect(written.equals(readFileSync(join(SAMPLE, 'LICENSE')))).toBe(true);
  });
});

describe('ia project --product plugin', () => {
  it('plans, then writes the plugin into an empty directory', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-out'), 'sample');
    const plan = await run(['project', 'claude', '--product', 'plugin', '--out', out, '--root', kit, '--json']);
    expect(plan.exitCode, plan.stdout).toBe(0);
    expect(existsSync(out)).toBe(false);
    const applied = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--root',
      kit,
      '--apply',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(readFileSync(join(out, 'skills/sample-run/SKILL.md'), 'utf8')).toBe(
      readFileSync(join(SAMPLE, 'skills/sample-run/SKILL.md'), 'utf8'),
    );
  });
  it('refuses a non-empty --out before writing anything', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-busy'), 'busy');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'mine\n');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--root',
      kit,
      '--apply',
      '--yes',
      '--json',
    ]);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
    expect(readdirSync(out)).toEqual(['keep.txt']);
  });
  it('refuses a resource edited after lowering, writing nothing', async () => {
    const kit = await lowered();
    writeFileSync(join(kit, '.ia/src/systems/sample-kit/plugin/skills/sample-run/SKILL.body.md'), 'edited\n');
    const out = join(scratch('host-plugin-digest'), 'sample');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--root',
      kit,
      '--apply',
      '--yes',
      '--json',
    ]);
    expect(json(result.stdout)['code']).toBe('IA-RESOURCE-DIGEST');
    expect(existsSync(out)).toBe(false);
  });
});

describe('ia project --product plugin: bytes and refusals', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const project = (kit: string, out: string, ...more: string[]) =>
    run(['project', 'claude', '--product', 'plugin', '--out', out, '--root', kit, '--json', ...more]);

  it('writes every file byte-identical to the sample', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-tree'), 'sample');
    const applied = await project(kit, out, '--apply', '--yes');
    expect(applied.exitCode, applied.stdout).toBe(0);
    const names = (dir: string) =>
      walk(dir)
        .map((file) => relative(dir, file))
        .sort();
    expect(names(out)).toEqual(names(SAMPLE));
    for (const name of names(SAMPLE))
      expect(readFileSync(join(out, name)).equals(readFileSync(join(SAMPLE, name))), name).toBe(true);
  });
  it('refuses a manifest path that escapes the workspace', async () => {
    const kit = await lowered();
    const file = join(kit, '.ia/authoring.resources.json');
    const manifest = json(readFileSync(file, 'utf8')) as {
      files: { path: string }[];
    };
    manifest.files[0]!.path = '../../etc/hosts';
    writeFileSync(file, JSON.stringify(manifest));
    const out = join(scratch('host-plugin-escape'), 'sample');
    const result = await project(kit, out, '--apply', '--yes');
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-PRODUCT');
    expect(existsSync(out)).toBe(false);
  });
  it('refuses a missing authoring manifest with a code', async () => {
    const kit = await lowered();
    rmSync(join(kit, '.ia/authoring.resources.json'));
    const out = join(scratch('host-plugin-nomanifest'), 'sample');
    const result = await project(kit, out, '--apply', '--yes');
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-PRODUCT');
    expect(result.exitCode).not.toBe(3);
    expect(existsSync(out)).toBe(false);
  });
  it('refuses an --out that is a file', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-file'), 'afile');
    writeFileSync(out, 'x');
    const result = await project(kit, out, '--apply', '--yes');
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
  });
  it('refuses an --out inside the workspace', async () => {
    const kit = await lowered();
    const out = join(kit, '.ia/out');
    const result = await project(kit, out, '--apply', '--yes');
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
    expect(existsSync(out)).toBe(false);
  });
  it('refuses a non-empty --out while planning', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-planbusy'), 'busy');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'mine\n');
    const result = await project(kit, out);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
  });
});

describe('ia project --product plugin --check', () => {
  it('passes on the sample: content-exact against the original and a fixed point', async () => {
    const kit = await lowered();
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      '--compare',
      SAMPLE,
      '--root',
      kit,
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const report = json(result.stdout) as {
      drift: unknown[];
      fixedPoint: unknown[];
    };
    expect(report.drift).toEqual([]);
    expect(report.fixedPoint).toEqual([]);
  });
  it('reports drift when a regenerated file cannot be explained by a rule', async () => {
    const plugin = join(scratch('host-plugin-drift'), 'sample');
    cpSync(SAMPLE, plugin, { recursive: true });
    const kit = join(scratch('host-plugin-drift-kit'), 'sample-kit');
    expect((await run(['init', kit, '--from', plugin, '--apply', '--yes', '--json'])).exitCode).toBe(0);
    writeFileSync(join(plugin, 'README.md'), '# Changed after lowering\n');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      '--compare',
      plugin,
      '--root',
      kit,
      '--json',
    ]);
    expect(json(result.stdout)['code']).toBe('IA-ROUNDTRIP-DRIFT');
  });
});

describe('ia project --product plugin --check: reports and refusals', () => {
  const readdirRecursive = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .sort();
  const check = (kit: string, ...compare: string[]) =>
    run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      ...(compare.length > 0 ? ['--compare', compare[0]!] : []),
      '--root',
      kit,
      '--json',
    ]);
  type Report = {
    compared: boolean;
    diffs: { path: string; status: string }[];
    drift: unknown[];
    fixedPoint: string[];
    unresolved: string[];
  };
  async function pair(label: string): Promise<{ plugin: string; kit: string }> {
    const plugin = join(scratch(`host-plugin-${label}`), 'sample');
    cpSync(SAMPLE, plugin, { recursive: true });
    const kit = join(scratch(`host-plugin-${label}-kit`), 'sample-kit');
    expect((await run(['init', kit, '--from', plugin, '--apply', '--yes', '--json'])).exitCode).toBe(0);
    return { plugin, kit };
  }

  it('reports the compared files and no unresolved entries on the sample', async () => {
    const kit = await lowered();
    const result = await check(kit, SAMPLE);
    const report = json(result.stdout) as unknown as Report;
    expect(report.compared).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(report.diffs.map((d) => d.path)).toEqual(readdirRecursive(SAMPLE));
    expect(report.diffs.every((d) => d.status === 'identical')).toBe(true);
  });
  it('says it is a fixed point only, without --compare', async () => {
    const kit = await lowered();
    const result = await run(['project', 'claude', '--product', 'plugin', '--check', '--root', kit]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('fixed point');
    expect(result.stdout).not.toContain('content-exact');
  });
  it('names a lowered file the workspace holds differently, and keeps the report in the refusal', async () => {
    const kit = await lowered();
    const map = join(kit, 'assets/lowering-map.json');
    writeFileSync(map, JSON.stringify(JSON.parse(readFileSync(map, 'utf8'))));
    const result = await check(kit);
    const body = json(result.stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    expect((body['details'] as Report).fixedPoint).toContain('assets/lowering-map.json');
    expect(String(body['message'])).toContain('assets/lowering-map.json');
  });
  it('names a stray file under the plugin resources as a fixed-point mismatch', async () => {
    const kit = await lowered();
    writeFileSync(join(kit, '.ia/src/systems/sample-kit/plugin/stray.md'), 'not indexed\n');
    const body = json((await check(kit)).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    expect((body['details'] as Report).fixedPoint).toContain('.ia/src/systems/sample-kit/plugin/stray.md');
  });
  it('reports unresolved entries when the rendered plugin cannot be lowered again', async () => {
    const kit = await lowered();
    writeFileSync(join(kit, 'assets/plugin/README.md'), 'one\r\ntwo\r\n');
    const body = json((await check(kit)).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    expect((body['details'] as Report).unresolved.length).toBeGreaterThan(0);
  });
  it('reports a file the original lacks as extra and one it holds as missing, and re-runs with --compare', async () => {
    const { plugin, kit } = await pair('extra-missing');
    rmSync(join(plugin, 'README.md'));
    writeFileSync(join(plugin, 'NOTES.md'), 'added after lowering\n');
    const body = json((await check(kit, plugin)).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    const byPath = new Map((body['details'] as Report).diffs.map((d) => [d.path, d.status]));
    expect(byPath.get('README.md')).toBe('extra');
    expect(byPath.get('NOTES.md')).toBe('missing');
    expect(String(body['next'])).toContain('--compare');
  });
  it('calls frontmatter the lowering never parsed drift', async () => {
    const { plugin, kit } = await pair('unparsed');
    const agent = join(plugin, 'agents/sample-reader.md');
    writeFileSync(agent, readFileSync(agent, 'utf8').replace('\n---\n', '\nmetadata:\n  owner: someone-else\n---\n'));
    const body = json((await check(kit, plugin)).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    const drift = (body['details'] as { drift: { path: string }[] }).drift;
    expect(drift.map((d) => d.path)).toContain('agents/sample-reader.md');
  });
  it('refuses a workspace that does not hold exactly one system', async () => {
    const kit = await lowered();
    mkdirSync(join(kit, '.ia/src/systems/other'), { recursive: true });
    const body = json((await check(kit)).stdout);
    expect(body['code']).toBe('IA-PLUGIN-PRODUCT');
  });
  it('counts directories only under .ia/src/systems', async () => {
    const kit = await lowered();
    writeFileSync(join(kit, '.ia/src/systems/NOTES.txt'), 'a file, not a system\n');
    const result = await check(kit, SAMPLE);
    expect(result.exitCode, result.stdout).toBe(0);
  });
});

describe('final review: lowering admits only what renders back', () => {
  const AGENT = 'agents/sample-reader.md';
  const CODEX = '.codex-plugin/plugin.json';
  const CLAUDE = '.claude-plugin/plugin.json';
  const TOOLS = 'tools: Read, Grep, Glob';
  const edit = (plugin: string, path: string, change: (text: string) => string): void =>
    writeFileSync(join(plugin, path), change(readFileSync(join(plugin, path), 'utf8')));
  const manifest = (plugin: string, path: string, change: (value: Record<string, unknown>) => void): void =>
    edit(plugin, path, (text) => {
      const value = json(text);
      change(value);
      return `${JSON.stringify(value, null, 2)}\n`;
    });
  type Variant = readonly [label: string, change: (plugin: string) => void, refused: boolean];
  const VARIANTS: readonly Variant[] = [
    ['the sample', () => {}, false],
    ['reordered tools', (p) => edit(p, AGENT, (t) => t.replace(TOOLS, 'tools: Glob, Grep, Read')), false],
    ['double-quoted tools', (p) => edit(p, AGENT, (t) => t.replace(TOOLS, 'tools: "Read, Grep, Glob"')), false],
    [
      'swapped frontmatter keys',
      (p) =>
        edit(p, AGENT, (t) =>
          t.replace(/name: (.*)\ndescription: (.*)\n/, (_m, n: string, d: string) => `description: ${d}\nname: ${n}\n`),
        ),
      false,
    ],
    // The renderer omits the default, so the lowering map of the output lacks the key and the fixed point would fail.
    [
      'an explicit default disable-model-invocation',
      (p) =>
        edit(p, 'skills/sample-guide/SKILL.md', (t) =>
          t.replace('\n---\n', '\ndisable-model-invocation: false\n---\n'),
        ),
      true,
    ],
    [
      'a Codex manifest without hooks',
      (p) =>
        manifest(p, CODEX, (m) => {
          delete m['hooks'];
        }),
      false,
    ],
    [
      'a reordered, minified Claude manifest',
      (p) =>
        edit(p, CLAUDE, (t) => {
          const value = json(t);
          return JSON.stringify({ license: value['license'], ...value });
        }),
      false,
    ],
    ['list-form tools', (p) => edit(p, AGENT, (t) => t.replace(TOOLS, 'tools: [Read, Grep, Glob]')), true],
    ['tools without spaces', (p) => edit(p, AGENT, (t) => t.replace(TOOLS, 'tools: Read,Grep,Glob')), true],
    [
      'a Codex interface without displayName',
      (p) =>
        manifest(p, CODEX, (m) => {
          delete (m['interface'] as Record<string, unknown>)['displayName'];
        }),
      true,
    ],
    [
      'a Codex manifest without interface',
      (p) =>
        manifest(p, CODEX, (m) => {
          delete m['interface'];
        }),
      true,
    ],
  ];
  it.each(VARIANTS)(
    '%s: zero unresolved entries means the check finds only identical or ruled files',
    async (_label, change, refused) => {
      const plugin = join(scratch('host-plugin-variant'), 'sample');
      cpSync(SAMPLE, plugin, { recursive: true });
      change(plugin);
      const kit = join(scratch('host-plugin-variant-kit'), 'sample-kit');
      const plan = await run(['init', kit, '--from', plugin, '--json']);
      if (refused) {
        expect(plan.exitCode, plan.stdout).toBe(1);
        expect(json(plan.stdout)['code']).toBe('IA-LOWER-UNRESOLVED');
        expect(existsSync(kit)).toBe(false);
        return;
      }
      expect(plan.exitCode, plan.stdout).toBe(0);
      const applied = await run(['init', kit, '--from', plugin, '--apply', '--yes', '--json']);
      expect(applied.exitCode, applied.stdout).toBe(0);
      const result = await run([
        'project',
        'claude',
        '--product',
        'plugin',
        '--check',
        '--compare',
        plugin,
        '--root',
        kit,
        '--json',
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      const report = json(result.stdout) as { diffs: { path: string; status: string }[] };
      expect(report.diffs.filter((d) => d.status !== 'identical' && d.status !== 'ruled')).toEqual([]);
    },
  );
});

describe('final review: ia project plugin flags', () => {
  it.each([[['--out', 'elsewhere']], [['--check']], [['--compare', 'elsewhere']]])(
    'refuses %j without --product plugin as usage, naming the --product plugin form',
    async (flags) => {
      const result = await run(['project', 'claude', ...flags, '--json']);
      expect(result.exitCode, result.stdout).toBe(2);
      const body = json(result.stdout);
      expect(body['code']).toBe('IA-CLI-USAGE');
      expect(String(body['next'])).toContain('--product plugin');
    },
  );
  it('refuses --compare without --check', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-compare-out'), 'sample');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--compare',
      SAMPLE,
      '--root',
      kit,
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(2);
    expect(json(result.stdout)['code']).toBe('IA-CLI-USAGE');
    expect(String(json(result.stdout)['message'])).toContain('--check');
  });
  it.each(['grok', 'cursor'])('refuses the host %s for --product plugin as usage', async (host) => {
    const kit = await lowered();
    const result = await run(['project', host, '--product', 'plugin', '--check', '--root', kit, '--json']);
    expect(result.exitCode, result.stdout).toBe(2);
    expect(json(result.stdout)['code']).toBe('IA-CLI-USAGE');
  });
  it('refuses a --compare directory that does not exist with IA-PLUGIN-INPUT', async () => {
    const kit = await lowered();
    const missing = join(scratch('host-plugin-nocompare'), 'absent');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      '--compare',
      missing,
      '--root',
      kit,
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(1);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-INPUT');
    // The next action is about the comparison directory, not a link, and its rerun keeps --compare.
    const next = String(json(result.stdout)['next']);
    expect(next).toMatch(/existing plugin directory/);
    expect(next).not.toMatch(/link/);
    expect(next).toContain(`--compare ${missing}`);
  });
  it('judges an --out reached through a link or junction into the workspace as inside it', async () => {
    const kit = await lowered();
    const link = join(scratch('host-plugin-outlink'), 'into-kit');
    try {
      symlinkSync(kit, link, 'junction');
    } catch {
      return; // a platform that can create neither a junction nor a directory link: only this case is skipped
    }
    const out = join(link, 'out');
    const result = await run(['project', 'claude', '--product', 'plugin', '--out', out, '--root', kit, '--json']);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
    expect(existsSync(join(kit, 'out'))).toBe(false);
  });
  it('judges an --out named ..x below the workspace as inside it', async () => {
    const kit = await lowered();
    const out = join(kit, '..x');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--root',
      kit,
      '--apply',
      '--yes',
      '--json',
    ]);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
    expect(existsSync(out)).toBe(false);
  });
  it.each(['.ia/src/systems/sample-kit/plugin/skills', 'assets/plugin/tests'])(
    'refuses a resource or asset read through a link or junction at %s',
    async (directory) => {
      const kit = await lowered();
      const linked = join(kit, directory);
      const real = join(scratch('host-plugin-linked'), 'real');
      cpSync(linked, real, { recursive: true });
      rmSync(linked, { recursive: true });
      try {
        symlinkSync(real, linked, 'junction');
      } catch {
        return; // a platform that can create neither a junction nor a directory link: only this case is skipped
      }
      const result = await run(['project', 'claude', '--product', 'plugin', '--check', '--root', kit, '--json']);
      expect(result.exitCode, result.stdout).toBe(1);
      expect(json(result.stdout)['code']).toBe('IA-PLUGIN-INPUT');
    },
  );
  it('separates the drift counts from the file list, and a --json refusal does not ask for --json', async () => {
    const plugin = join(scratch('host-plugin-wording'), 'sample');
    cpSync(SAMPLE, plugin, { recursive: true });
    const kit = join(scratch('host-plugin-wording-kit'), 'sample-kit');
    expect((await run(['init', kit, '--from', plugin, '--apply', '--yes', '--json'])).exitCode).toBe(0);
    writeFileSync(join(plugin, 'README.md'), '# Changed after lowering\n');
    const argv = ['project', 'claude', '--product', 'plugin', '--check', '--compare', plugin, '--root', kit];
    const body = json((await run([...argv, '--json'])).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    expect(String(body['message'])).toMatch(/^1 drifted, 0 fixed-point mismatches, 0 unresolved\. Files: README\.md /);
    expect(String(body['next'])).not.toContain('--json');
    const human = await run(argv);
    expect(human.exitCode).toBe(1);
    expect(human.stderr.replace(/\s+/g, ' ')).toContain('--json');
  });
});

describe('final review: ia init --from', () => {
  const listed = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .sort();
  async function plugin(label: string): Promise<string> {
    const root = join(scratch(`host-plugin-${label}`), 'sample');
    cpSync(SAMPLE, root, { recursive: true });
    return root;
  }
  it('carries --from into the plan, resume and conflict next commands', async () => {
    const source = await plugin('next');
    const kit = join(scratch('host-plugin-next-kit'), 'sample-kit');
    const applyLine = (text: string): string => text.replace(/\s+/g, ' ').match(/Apply with "([^"]*)"/)?.[1] ?? '';
    // The plan's next, as the terminal prints it.
    const planned = await run(['init', kit, '--from', source]);
    expect(planned.exitCode, planned.stderr).toBe(0);
    const command = applyLine(planned.stdout);
    expect(command).toMatch(/^ia init \S+ --from \S+ --apply --yes$/);
    expect(command).toContain(`--from ${source}`);
    // The resume next: an apply interrupted after its first write names the same invocation, --from included.
    const controller = new AbortController();
    const interrupted = applyInit(
      collectInit({
        root: kit,
        host: 'none',
        from: source,
        packageRoot: cli,
        git: gitIn(dirname(kit), {}),
        invocation: command.replace(/ --apply --yes$/, ''),
      }),
      {
        packageRoot: cli,
        signal: controller.signal,
        checkpoint: (name) => {
          if (name === 'init:author') controller.abort();
        },
      },
    );
    await expect(interrupted).rejects.toBeInstanceOf(Interrupted);
    await expect(interrupted).rejects.toMatchObject({
      next: expect.stringContaining(`--from ${source} --apply --yes`),
    });
    // The resumable plan's next comes from invocationOf again and still carries --from.
    const resumable = await run(['init', kit, '--from', source]);
    // The terminal wraps the line at its width, so the phrase is matched with whitespace collapsed.
    expect(resumable.stdout.replace(/\s+/g, ' ')).toContain('Completed steps are skipped');
    expect(applyLine(resumable.stdout)).toContain(`--from ${source} --apply --yes`);
    // The conflict refusal's next.
    const busy = join(scratch('host-plugin-next-busy'), 'sample-kit');
    mkdirSync(join(busy, '.ia/src'), { recursive: true });
    writeFileSync(join(busy, '.ia/src/foreign.ia'), '#! ia 1.0\n');
    const conflict = await run(['init', busy, '--from', source, '--apply', '--yes', '--json']);
    expect(json(conflict.stdout)['code']).toBe('IA-CLI-CONFLICT');
    expect(String(json(conflict.stdout)['next'])).toContain(`--from ${source}`);
  });
  it('refuses ia init --from . run inside the plugin, writing nothing into it', async () => {
    const source = await plugin('self');
    const before = listed(source);
    const result = await run(['init', '--from', '.', '--apply', '--yes', '--json'], { cwd: source });
    expect(result.exitCode, result.stdout).toBe(1);
    const body = json(result.stdout);
    expect(body['code']).toBe('IA-PLUGIN-INPUT');
    expect(String(body['message'])).toMatch(/inside/);
    expect(String(body['next'])).toMatch(/outside/);
    expect(listed(source)).toEqual(before);
  });
  it('refuses ia init ./kit --from . (a target inside the plugin)', async () => {
    const source = await plugin('inside');
    const before = listed(source);
    const result = await run(['init', './kit', '--from', '.', '--apply', '--yes', '--json'], { cwd: source });
    expect(result.exitCode, result.stdout).toBe(1);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-INPUT');
    expect(String(json(result.stdout)['message'])).toMatch(/inside/);
    expect(listed(source)).toEqual(before);
  });
  it('keeps a target that contains the plugin legal', async () => {
    const parent = join(scratch('host-plugin-parent'), 'outer-kit');
    mkdirSync(parent);
    cpSync(SAMPLE, join(parent, 'plugin'), { recursive: true });
    const result = await run(['init', '.', '--from', './plugin', '--json'], { cwd: parent });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).not.toContain('IA-PLUGIN-INPUT');
  });
  it('carries every unresolved entry in the refusal details', async () => {
    const source = await plugin('details');
    mkdirSync(join(source, 'hooks'));
    for (let index = 0; index < 25; index += 1) writeFileSync(join(source, `hooks/h${index}.json`), '{}\n');
    const kit = join(scratch('host-plugin-details-kit'), 'sample-kit');
    const body = json((await run(['init', kit, '--from', source, '--json'])).stdout);
    expect(body['code']).toBe('IA-LOWER-UNRESOLVED');
    expect(body['details']).toHaveLength(25);
  });
  // The licence guard belongs to packing (apps/cli/SPEC.md “Host plugins”); until then a lowered kit's descriptor is
  // UNLICENSED, whatever the plugin's manifest says (the sample's is Apache-2.0).
  it('keeps the descriptor licence UNLICENSED for a lowered kit until the pack-time licence guard', async () => {
    const kit = await lowered();
    expect(json(readFileSync(join(SAMPLE, '.claude-plugin/plugin.json'), 'utf8'))['license']).toBe('Apache-2.0');
    expect(json(readFileSync(join(kit, '.ia/release.json'), 'utf8'))['license']).toBe('UNLICENSED');
  });
  it('admits authored trigger records beside the lowered ones without breaking the fixed point', async () => {
    const kit = await lowered();
    writeFileSync(
      join(kit, '.ia/src/systems/sample-kit/records/triggers.ia'),
      [
        '#! ia 1.0',
        '',
        '@contract sample-guide-triggers',
        '  version "0.1.0"',
        '  meaning',
        '    says "When the sample-guide skill is invoked."',
        '    answers "Does the skill trigger on sample-method questions and not on adjacent work?"',
        '  invariants',
        '    REQ-SAMPLE-01 "The sample-guide skill is invoked for sample-method questions and not for adjacent work."',
        '  relationships',
        '    governs @capability sample-guide',
        '',
        '@case sample-guide-t-01',
        '  meaning',
        '    says "Trigger case sample-guide-t-01."',
        '    answers "Does the skill trigger on this request?"',
        '  scenario',
        '    kind success',
        '    given "A fresh session with the plugin loaded."',
        '    request "When does a fixture need a model-invocable skill?"',
        '    expected "invokes sample-plugin:sample-guide"',
        '    evaluator "eval-triggers.mjs"',
        '  relationships',
        '    implements @contract sample-guide-triggers#REQ-SAMPLE-01',
        '',
        '@case sample-guide-n-01',
        '  meaning',
        '    says "Trigger case sample-guide-n-01."',
        '    answers "Does the skill stay silent on this request?"',
        '  scenario',
        '    kind refusal',
        '    given "A fresh session with the plugin loaded."',
        '    request "Fix the failing build in my web app."',
        '    expected "does not invoke it"',
        '    evaluator "eval-triggers.mjs"',
        '  relationships',
        '    implements @contract sample-guide-triggers#REQ-SAMPLE-01',
        '',
        // Item 17b: a trigger evaluation's result, a learning-system word, in the one lowered system.
        '@observation sample-guide-trigger-run',
        '  meaning',
        '    says "One trigger evaluation of the sample-guide skill."',
        '    answers "Did the skill trigger as its contract requires?"',
        '  evidence',
        '    origin check',
        '    actor "eval-triggers.mjs"',
        '    observed-at "2026-10-14T00:00:00Z"',
        '    captured-at "2026-10-14T00:00:00Z"',
        '    workspace "sample-kit"',
        '    locator "sample-guide-triggers#REQ-SAMPLE-01"',
        '    revision "unversioned"',
        '    bundle ".ia/learning/observations/sample-guide-trigger-run.json"',
        '    digest "0000000000000000000000000000000000000000000000000000000000000000"',
        '    availability unavailable',
        '    verdict success',
        '  interpretation',
        '    applies "The two sample-guide trigger cases only."',
        '    limits "A fixture observation; no host session ran."',
        '    reason "Trigger results are recorded as evidence beside the cases they evaluate."',
        '    basis inference',
        '  retention',
        '    status retained',
        '  relationships',
        '    cites @contract sample-guide-triggers#REQ-SAMPLE-01',
        '',
      ].join('\n'),
    );
    const validated = await validate(kit);
    expect(validated.exitCode, validated.stdout).toBe(0);
    expect(json(validated.stdout)['ok'] ?? true).toBe(true);
    // The observation is admitted, not merely parsed: inspecting its file lists it.
    const inspected = await run([
      'inspect',
      '--path',
      '.ia/src/systems/sample-kit/records/triggers.ia',
      '--root',
      kit,
      '--json',
    ]);
    expect(inspected.exitCode, inspected.stdout).toBe(0);
    expect(inspected.stdout).toContain('sample-guide-trigger-run');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      '--compare',
      SAMPLE,
      '--root',
      kit,
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
  });
});

describe('Track 2B: standalone plugin CLI projection for seated and multi-capability workspaces', () => {
  it('compiles a seated workspace with >4 capabilities, rules, agents and @hook guards into standalone gemini and antigravity plugins', async () => {
    const root = await workspace();
    const caps = ['plan', 'task', 'retrieve', 'check', 'design', 'review']
      .map((slug) =>
        [
          `@playbook pb-${slug}`,
          '  meaning',
          `    says "Method for ${slug}."`,
          `    answers "How does ${slug} proceed?"`,
          '  cognition',
          '    orient',
          '      primary Memory',
          `      Memory means "Orient on ${slug} records."`,
          '    plan',
          '      primary Inference',
          `      Inference means "Plan ${slug} steps."`,
          '    act',
          '      primary Decision',
          `      Decision means "Execute ${slug} cleanly."`,
          '    learn',
          '      primary Learning',
          `      Learning means "Capture ${slug} learnings."`,
          '',
          `@capability cap-${slug}`,
          '  meaning',
          `    says "Capability ${slug} for standalone CLI test."`,
          `    answers "When is ${slug} used?"`,
          '  composition',
          `    playbooks [@playbook pb-${slug}]`,
          '  execution',
          '    effects [read, local-write]',
          '',
        ].join('\n'),
      )
      .join('\n');

    writeFileSync(
      join(root, '.ia/src/standalone.ia'),
      [
        '#! ia 1.0',
        '',
        '@law cli-standalone-law',
        '  meaning',
        '    says "Preserve canonical anchors in every edit."',
        '    answers "What law governs edits?"',
        '  governance',
        '    severity blocking',
        '    requires "Canonical anchors remain intact."',
        '',
        '@hook cli-guard',
        '  meaning',
        '    says "Blocks direct writes to locked/."',
        '    answers "Which directory is guarded?"',
        '  hook',
        '    event PreToolUse',
        '    tools [Write, Edit]',
        '    paths ["locked/**"]',
        '    message "locked/ is read-only."',
        '',
        caps,
      ].join('\n'),
    );
    writeFileSync(
      join(root, '.ia/bindings.json'),
      JSON.stringify(
        {
          format: 1,
          bindings: {
            'work.plan': { kit: 'local', capability: 'cap-plan' },
            'work.task': { kit: 'local', capability: 'cap-task' },
            'knowledge.retrieve': { kit: 'local', capability: 'cap-retrieve' },
            'knowledge.check': { kit: 'local', capability: 'cap-check' },
            'delivery.design': { kit: 'local', capability: 'cap-design' },
            'delivery.review': { kit: 'local', capability: 'cap-review' },
          },
          precedence: ['local'],
          defaults: {},
        },
        null,
        2,
      ),
    );
    expect((await validate(root)).exitCode).toBe(0);

    for (const host of ['gemini', 'antigravity', 'claude', 'codex'] as const) {
      const out = join(scratch(`standalone-cli-${host}`), host);
      const res = await run([
        'project',
        host,
        '--product',
        'plugin',
        '--out',
        out,
        '--root',
        root,
        '--apply',
        '--yes',
        '--json',
      ]);
      expect(res.exitCode, `${host}: ${res.stdout}`).toBe(0);

      const skills = readdirSync(join(out, 'skills'));
      expect(skills.sort()).toEqual(['delivery', 'knowledge', 'work']);
      expect(skills.length).toBeLessThanOrEqual(4);

      if (host === 'antigravity') {
        const manifest = json(readFileSync(join(out, 'plugin.json'), 'utf8'));
        expect(Object.keys(manifest)).toEqual(['name', 'displayName', 'version', 'description', 'author']);
        expect(existsSync(join(out, 'rules/AGENTS.md'))).toBe(true);
        expect(existsSync(join(out, 'hooks.json'))).toBe(true);
        expect(existsSync(join(out, 'scripts/guard.mjs'))).toBe(true);
      } else if (host === 'gemini') {
        const manifest = json(readFileSync(join(out, 'gemini-extension.json'), 'utf8'));
        expect(manifest).toMatchObject({ contextFileName: 'GEMINI.md', skills: './skills/' });
        expect(existsSync(join(out, 'GEMINI.md'))).toBe(true);
        expect(existsSync(join(out, 'hooks/hooks.json'))).toBe(true);
        expect(existsSync(join(out, 'scripts/guard.mjs'))).toBe(true);
      }
    }

    // Workspace projection (`ia project <gemini|antigravity>`) reports authored @hook records as unregistered rather than silently dropping them.
    for (const host of ['gemini', 'antigravity'] as const) {
      const projected = await run(['project', host, '--root', root, '--apply', '--yes', '--json']);
      expect(projected.exitCode, `${host} workspace project: ${projected.stdout}`).toBe(0);
      const envelope = json(projected.stdout) as {
        plan: { unsupported: { identity: string; word: string; reason: string }[] };
        applied: { unsupported: { identity: string; word: string; reason: string }[] };
      };
      const expectedRow = {
        identity: 'hook-authoring-system/binding/hook/cli-guard',
        word: 'hook',
        reason: `Not registered: workspace hook groups run only under "ia host claude --apply"; run "ia project ${host} --product plugin" for a standalone plugin guard`,
      };
      expect(envelope.plan.unsupported).toContainEqual(expectedRow);
      expect(envelope.applied.unsupported).toContainEqual(expectedRow);
    }
  });
});
