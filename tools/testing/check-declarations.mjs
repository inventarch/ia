import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { isEntry } from '../entry/is-entry.mjs';

/** Emit in memory so package consumers can keep allowJs disabled without hand-maintained interfaces. */
export function entryDeclarations(root) {
  const files = ['is-entry.mjs', 'package-manager.mjs'].map((file) => resolve(root, 'tools/entry', file));
  const program = ts.createProgram(files, {
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
  });
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

/** Validate the complete, fixed output set before any write, including every existing ancestor. */
function declarationTargets(root, outputs) {
  const canonical = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  if (canonical(realpathSync(root)) !== canonical(resolve(root)) || lstatSync(root).isSymbolicLink())
    throw new Error('Declaration root crosses an alias');
  const expected = new Set(
    ['is-entry.d.mts', 'package-manager.d.mts'].map((name) => resolve(root, 'tools/entry', name)),
  );
  if (outputs.size !== expected.size || [...outputs.keys()].some((path) => !expected.has(resolve(path))))
    throw new Error('Declaration output escapes its explicit contained set');
  for (const path of outputs.keys()) {
    for (const directory of [root, join(root, 'tools'), join(root, 'tools/entry')]) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Declaration directory crosses an alias');
    }
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
        throw new Error('Declaration output is aliased or hardlinked');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function checkDeclarations(root, mode) {
  const outputs = entryDeclarations(root);
  declarationTargets(root, outputs);
  for (const [path, text] of outputs) {
    let existing;
    try {
      existing = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing === text) continue;
    if (mode === '--check') throw new Error('Stale generated declaration: ' + path);
    const temporary = path + '.' + randomUUID() + '.tmp';
    let created = false;
    try {
      writeFileSync(temporary, text, { flag: 'wx' });
      created = true;
      declarationTargets(root, outputs);
      renameSync(temporary, path);
    } finally {
      if (created) rmSync(temporary, { force: true });
    }
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
    console.error('Usage: check-declarations.mjs --check|--write');
    process.exitCode = 2;
  } else
    try {
      checkDeclarations(resolve(import.meta.dirname, '../..'), args[0]);
      console.log('Entry declarations match checked implementations.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
