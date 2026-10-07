import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

interface InstalledCatalog {
  installedImplementationDigest(): string;
}
const composition = resolve(import.meta.dirname, '..'),
  runtime = realpathSync(resolve(composition, 'node_modules/@inventarch/workspace-runtime'));

/**
 * The contract of the composition `additional` entry, over a copied install of the emitted packages: the composition
 * digest is the generic workspace-runtime inventory plus this package's own installed directory. A changed compiler
 * module moves only the composition digest; a changed workspace-runtime module moves both.
 */
it('moves only the composition digest for a compiler change and both digests for a runtime change', async () => {
  const install = mkdtempSync(join(tmpdir(), 'ia-installed-catalog-'));
  try {
    const packages = join(install, 'packages'),
      scope = join(install, 'node_modules', '@inventarch');
    mkdirSync(scope, { recursive: true });
    // The two packages under test are copied and installed by link, so the copied composition module resolves the
    // copied runtime exactly as an installed consumer does; every other installed dependency is linked unchanged.
    for (const [name, from] of [
      ['agent-composition-system', composition],
      ['workspace-runtime', runtime],
    ] as const) {
      if (!existsSync(join(from, 'dist/installed-catalog.js'))) throw new Error(`Build @inventarch/${name} first`);
      // Sources ride along only so the emitted source maps resolve; the digest walks the emitted directory.
      for (const folder of ['dist', 'src'])
        cpSync(join(from, folder), join(packages, name, folder), { recursive: true });
      symlinkSync(join(packages, name), join(scope, name), 'junction');
      writeFileSync(
        join(packages, name, 'package.json'),
        JSON.stringify({
          name: `@inventarch/${name}`,
          type: 'module',
          exports: { './installed-catalog': './dist/installed-catalog.js' },
        }),
      );
    }
    for (const name of [
      'agent-system',
      'authoring-system',
      'db',
      'graph',
      'language',
      'runtime',
      'session-system',
      'template-system',
    ])
      symlinkSync(realpathSync(join(runtime, 'node_modules/@inventarch', name)), join(scope, name), 'junction');
    const load = async (name: string): Promise<InstalledCatalog> =>
        (await import(pathToFileURL(join(packages, name, 'dist/installed-catalog.js')).href)) as InstalledCatalog,
      generic = await load('workspace-runtime'),
      composed = await load('agent-composition-system'),
      pins = () => ({
        generic: generic.installedImplementationDigest(),
        composed: composed.installedImplementationDigest(),
      });
    const installed = pins();
    expect(installed.composed).not.toBe(installed.generic);
    expect(pins()).toEqual(installed);

    appendFileSync(
      join(packages, 'agent-composition-system/dist/compile.js'),
      `${EOL}// changed compiler module${EOL}`,
    );
    const compiler = pins();
    expect(compiler.generic).toBe(installed.generic);
    expect(compiler.composed).not.toBe(installed.composed);

    appendFileSync(join(packages, 'workspace-runtime/dist/corpus.js'), `${EOL}// changed runtime module${EOL}`);
    const moved = pins();
    expect(moved.generic).not.toBe(compiler.generic);
    expect(moved.composed).not.toBe(compiler.composed);
  } finally {
    if (!install.startsWith(resolve(tmpdir(), 'ia-installed-catalog-')))
      throw new Error('Unexpected temporary cleanup path');
    rmSync(install, { recursive: true, force: true });
  }
}, 60_000);
