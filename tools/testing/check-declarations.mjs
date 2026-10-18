import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { checkWrite } from '../shared/check-write.mjs';
import ts from 'typescript';
import { isEntry } from '../entry/is-entry.mjs';

const declaredSources = [
  'entry/is-entry.mjs',
  'entry/package-manager.mjs',
  'shared/args.mjs',
  'shared/paths.mjs',
  'native/public-manifest.mjs',
  'release/recipe.mjs',
];

/** Emit in memory so package consumers can keep allowJs disabled without hand-maintained interfaces. */
export function entryDeclarations(root) {
  const files = declaredSources.map((file) => resolve(root, 'tools', file));
  const options = {
    allowJs: true,
    checkJs: true,
    strict: true,
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
  };
  const host = ts.createCompilerHost(options);
  const canonical = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  const generated = new Set(files.map((file) => canonical(file.replace(/\.mjs$/, '.d.mts'))));
  const fileExists = host.fileExists;
  // Generated siblings must never mask the implementations or become inputs to their own next emission.
  host.fileExists = (path) => !generated.has(canonical(path)) && fileExists(path);
  const program = ts.createProgram(files, options, host);
  const outputs = new Map();
  const emitted = program.emit(undefined, (path, text) =>
    outputs.set(
      path,
      execFileSync(
        process.execPath,
        [resolve(root, 'node_modules/@biomejs/biome/bin/biome'), 'format', '--stdin-file-path=' + path],
        {
          cwd: root,
          input:
            '// Generated from checked JavaScript; run node tools/testing/check-declarations.mjs --write.\n' + text,
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
    ),
  );
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    );
  return outputs;
}

/** Keep compiler output membership explicit; shared output validation owns all filesystem effects. */
function checkDeclarations(root, mode) {
  const outputs = entryDeclarations(root);
  const expected = new Set(declaredSources.map((name) => resolve(root, 'tools', name.replace(/\.mjs$/, '.d.mts'))));
  if (outputs.size !== expected.size || [...outputs.keys()].some((path) => !expected.has(resolve(path))))
    throw new Error('Declaration output escapes its explicit contained set');
  const generated = new Map([...outputs].map(([path, text]) => [relative(root, path).replaceAll('\\', '/'), text]));
  const result = checkWrite(root, generated, { write: mode === '--write', normalizeNewlines: true });
  if (mode === '--check' && result.changed.length)
    throw new Error('Stale generated declaration: ' + result.changed.join(', '));
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
    console.error('Usage: check-declarations.mjs --check|--write');
    process.exitCode = 2;
  } else
    try {
      checkDeclarations(resolve(import.meta.dirname, '../..'), args[0]);
      console.log('Package-facing declarations match checked implementations.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
