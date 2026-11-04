// Test double for npm, pnpm, yarn and bun as the console's batch runs them (console/batch-run.ts). A shim passes the
// manager's name first: `fake-pm.mjs <manager> <args...>`. Every call is appended to $FAKE_PM_LOG as one JSON line
// {manager, argv, cwd}.
//
// $FAKE_PM_MODE: `ok` (the default) acts; `conflict` prints a dependency-resolution error and exits 1; `fail` exits 1.
// $FAKE_PM_FROZEN=fail: a frozen install (`ci`, `--frozen-lockfile` or `--immutable`) exits 1, as one does when the
// lockfile no longer matches the manifest; a plain install still acts.
//
// On `ok` the command is classified the way the real manager reads it, by whether it names a package, not by its verb:
// - a dependency mutation names a package spec after the verb (`npm install -D [--prefix <dir>] @inventarch/cli@X`,
//   `npm i`/`npm add`, `pnpm [--dir <dir>] add -D [-w] …`, `yarn [--cwd <dir>] add -D [-W] …`, `bun add -d [--cwd <dir>] …`);
// - a plain install is `install`, `i` or `ci` with no package spec; X is then the version the targeted package.json
//   lists for @inventarch/cli, or a range's lower bound (its first x.y.z).
// Either way it writes a copy of @inventarch/cli at version X into <dir>/node_modules exactly where findLocalCli looks:
// a package.json with name, version and bin, and dist/bin.js (and dist/main.js), a script that appends {argv, cwd,
// version} to $FAKE_IA_LOG and exits 0. A mutation also writes devDependencies["@inventarch/cli"] = X into the targeted
// package.json. The targeted directory is the --prefix, --dir, -C or --cwd value, resolved against the working
// directory, or the working directory.
//
// $FAKE_PM_ENTRY points the copy's bin at an absolute path, and $FAKE_PM_DIST makes its dist folder a link to a
// directory; both lead the entry out of the worktree while the package folder stays inside it.
// $FAKE_PM_DEFECT writes a copy findLocalCli rejects: `name` (another package name), `version` (none), `bin` (none) or
// `entry` (the bin names a file that is not there). $FAKE_PM_LINKS, a JSON array of [path, target] pairs, makes each
// path (relative to the targeted directory) a link to target: a junction on Windows, a directory symlink elsewhere.
//
// Imported (by the grammar test), it only exports `classify`; run as a program, it acts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = '@inventarch/cli';
export const DIRECTORY_OPTIONS = ['--prefix', '--dir', '-C', '--cwd'];

/** The command as the managers read it: the targeted directory, the verb and the package specs after it. */
export function classify(args) {
  let directory = null;
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const split = token.indexOf('=');
    const key = split === -1 ? token : token.slice(0, split);
    if (DIRECTORY_OPTIONS.includes(key)) {
      directory = split === -1 ? args[++index] : token.slice(split + 1);
      continue;
    }
    if (token.startsWith('-')) continue;
    positionals.push(token);
  }
  const [verb, ...specs] = positionals;
  const kind =
    specs.length > 0 && ['install', 'i', 'add'].includes(verb)
      ? 'mutation'
      : ['install', 'i', 'ci'].includes(verb)
        ? 'install'
        : 'other';
  return { directory, verb, specs, kind };
}

function main() {
  const [manager, ...argv] = process.argv.slice(2);
  const cwd = process.cwd();
  if (process.env.FAKE_PM_LOG) appendFileSync(process.env.FAKE_PM_LOG, `${JSON.stringify({ manager, argv, cwd })}\n`);
  const mode = process.env.FAKE_PM_MODE ?? 'ok';
  const frozen = argv.includes('ci') || argv.includes('--frozen-lockfile') || argv.includes('--immutable');
  if (frozen && process.env.FAKE_PM_FROZEN === 'fail') {
    process.stderr.write('the lockfile does not match package.json\n');
    process.exit(1);
  }
  if (mode === 'conflict') {
    process.stderr.write('ERESOLVE could not resolve the dependency tree\n');
    process.exit(1);
  }
  if (mode === 'fail') {
    process.stderr.write('install failed\n');
    process.exit(1);
  }

  const command = classify(argv);
  const target = resolve(cwd, command.directory ?? '.');
  const manifestPath = join(target, 'package.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  let version = null;
  if (command.kind === 'mutation') {
    const spec = command.specs.find((entry) => entry.startsWith(`${CLI}@`));
    if (spec !== undefined) {
      version = spec.slice(CLI.length + 1);
      manifest.devDependencies = { ...(manifest.devDependencies ?? {}), [CLI]: version };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  } else if (command.kind === 'install') {
    const range = manifest.dependencies?.[CLI] ?? manifest.devDependencies?.[CLI];
    version = typeof range === 'string' ? (/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(range)?.[0] ?? null) : null;
  }

  if (version !== null) {
    const copy = join(target, 'node_modules', CLI);
    // $FAKE_PM_DIST makes the copy's dist folder a link to that directory, which holds its own bin.js.
    const outside = process.env.FAKE_PM_DIST;
    if (outside === undefined) mkdirSync(join(copy, 'dist'), { recursive: true });
    else {
      mkdirSync(copy, { recursive: true });
      symlinkSync(outside, join(copy, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const defect = process.env.FAKE_PM_DEFECT ?? '';
    const pkg = {
      name: defect === 'name' ? '@inventarch/other' : CLI,
      version,
      type: 'module',
      bin: { ia: 'dist/bin.js' },
    };
    if (defect === 'version') delete pkg.version;
    if (defect === 'bin') delete pkg.bin;
    if (defect === 'entry') pkg.bin = { ia: 'dist/missing.js' };
    // $FAKE_PM_ENTRY names the bin's target as an absolute path, wherever it is.
    if (process.env.FAKE_PM_ENTRY) pkg.bin = { ia: process.env.FAKE_PM_ENTRY };
    writeFileSync(join(copy, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    const script = [
      "import { appendFileSync } from 'node:fs';",
      `const version = ${JSON.stringify(version)};`,
      'if (process.env.FAKE_IA_LOG)',
      '  appendFileSync(process.env.FAKE_IA_LOG, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), version })}\\n`);',
      '',
    ].join('\n');
    if (outside === undefined) {
      writeFileSync(join(copy, 'dist', 'bin.js'), script);
      writeFileSync(join(copy, 'dist', 'main.js'), script);
    }
  }

  for (const [path, to] of JSON.parse(process.env.FAKE_PM_LINKS ?? '[]')) {
    const link = resolve(target, path);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(to, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  process.exit(0);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  main();
