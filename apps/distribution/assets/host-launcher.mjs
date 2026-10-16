// Packaged artifact entrypoint. Its inventory pin is inserted by release assembly.
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  pin = '__INVENTORY_DIGEST__';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// `child` is `parent` or under it on disk, compared by device and inode from its deepest existing ancestor up, so another
// spelling a case- or normalization-folding volume opens as the same directory is inside too (crowncodes/ia#315).
const within = (parent, child) => {
  const target = statSync(parent, { bigint: true });
  let entry = child;
  while (!statSync(entry, { throwIfNoEntry: false })) {
    if (dirname(entry) === entry) return false;
    entry = dirname(entry);
  }
  for (entry = realpathSync.native(entry); ; entry = dirname(entry)) {
    const stat = statSync(entry, { bigint: true });
    if (stat.dev === target.dev && stat.ino === target.ino) return true;
    if (dirname(entry) === entry) return false;
  }
};
const deny = (message) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'IA-HOOK-INPUT-INVALID: ' + message,
  },
});
const mode = process.argv[2];
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22 or later required');
  if (realpathSync(root) !== root) throw Error('Aliased plugin cache');
  const bytes = readFileSync(join(root, 'inventory.json'));
  if (bytes.length > 4 * 1024 * 1024 || hash(bytes) !== pin)
    throw Error('Plugin inventory differs from pinned release');
  const inventory = JSON.parse(bytes),
    expected = new Map(inventory.files.map((f) => [f.path, f]));
  let count = 0,
    total = 0,
    entries = 0;
  // The launcher's own files, and unpinned platform files, which the walk never reads.
  const skipped = (rel, name, file) =>
    rel === 'inventory.json' ||
    rel === 'scripts/ia.mjs' ||
    rel === 'release.json' ||
    (!file && (name === '.DS_Store' || name.startsWith('._')));
  // What the walk does with a file, from its stat (bigint): a link, a special file or a second link refuses; a skipped
  // file is skipped (false); an unpinned, resized or over-budget file refuses; any other file is read and hashed (true).
  const judge = (stat, rel, name, file) => {
    if (stat.isSymbolicLink()) throw Error('Plugin cache links are unsupported');
    if (!stat.isFile() || stat.nlink !== 1n) throw Error('Plugin cache file is aliased');
    if (skipped(rel, name, file)) return false;
    if (
      !file ||
      !Number.isSafeInteger(file.bytes) ||
      stat.size !== BigInt(file.bytes) ||
      (total += file.bytes) > 256 * 1024 * 1024
    )
      throw Error('Plugin cache payload differs: ' + rel);
    return true;
  };
  // An entry its listed name no longer reaches: removed since its directory was read, or listed under a name that is not
  // UTF-8, which Node decodes lossily on Linux. It is never admitted: a pinned one is left uncounted, so it is missing
  // (false), and any other, one the walk would skip included, is no file the inventory pins.
  const gone = (rel, file) => {
    if (file) return false;
    throw Error('Plugin cache payload differs: ' + rel);
  };
  // The lstat (bigint) of `path`, or undefined once its name reaches nothing.
  const named = (path) => {
    try {
      return lstatSync(path, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    }
  };
  // Whether the file entry at `rel` is pinned and verified. It is opened before it is judged, so the file judged is the
  // file hashed (CodeQL js/file-system-race): never through a link where the platform refuses one at the open, never
  // waiting on a FIFO, read through that descriptor at most one byte past its pinned size, and still the file at `rel`
  // afterwards, which on Windows, without either open flag, is the one check of a link swapped in after the listing.
  const verified = (rel, name, file) => {
    const full = join(root, rel);
    let fd;
    try {
      fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      // Of the failures that keep a file from opening, only that of a pinned file the walk may not read (EACCES, EPERM)
      // prints its system error, as before. A name that reaches nothing is gone, and a link the open refused (ELOOP;
      // EMLINK on FreeBSD) is refused as one. Anything else is judged by its name, as before the walk opened files
      // (Windows may refuse to open a directory); a pinned file that some other failure kept from opening, one swapped
      // back after the open or one the system would not open, cannot be verified and refuses as a payload that differs.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return gone(rel, file);
      if (error.code === 'ELOOP' || error.code === 'EMLINK') throw Error('Plugin cache links are unsupported');
      const stat = named(full);
      if (!stat) return gone(rel, file);
      if (!judge(stat, rel, name, file)) return false;
      if (error.code === 'EACCES' || error.code === 'EPERM') throw error;
      throw Error('Plugin cache payload differs: ' + rel);
    }
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!judge(opened, rel, name, file)) return false;
      const bytes = Buffer.alloc(file.bytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, null);
        if (!read) break;
        length += read;
      }
      const after = fstatSync(fd, { bigint: true }),
        stat = named(full);
      if (!stat) return gone(rel, file);
      if (stat.isSymbolicLink()) throw Error('Plugin cache links are unsupported');
      if (!stat.isFile() || stat.nlink !== 1n) throw Error('Plugin cache file is aliased');
      if (
        stat.dev !== opened.dev ||
        stat.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs ||
        length !== file.bytes ||
        hash(bytes.subarray(0, length)) !== file.sha256
      )
        throw Error('Plugin cache payload differs: ' + rel);
      return true;
    } finally {
      closeSync(fd);
    }
  };
  const visit = (path = '', depth = 0) => {
    if (depth > 32) throw Error('Plugin cache directory depth exceeds 32');
    let listed;
    try {
      listed = readdirSync(join(root, path), { withFileTypes: true });
    } catch (error) {
      // A directory its listed name no longer reaches is no part of the payload.
      if (path && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
        throw Error('Plugin cache payload differs: ' + path);
      throw error;
    }
    for (const entry of listed) {
      if (++entries > 20000) throw Error('Plugin cache filesystem inventory exceeds its bound');
      const name = entry.name,
        rel = path ? path + '/' + name : name,
        file = expected.get(rel);
      // A special file is refused from its directory entry, before anything is opened. Windows lists every reparse point
      // as a link, so a listed link is confirmed by its lstat, as the walk judged every entry before it opened files: only
      // a real link refuses, a placeholder or deduplicated entry is judged by the type its lstat gives, and a file is still
      // judged by the descriptor it is read through.
      const kind = entry.isSymbolicLink() ? named(join(root, rel)) : entry;
      if (!kind) gone(rel, file);
      else if (kind.isSymbolicLink()) throw Error('Plugin cache links are unsupported');
      else if (kind.isDirectory()) visit(rel, depth + 1);
      else if (!kind.isFile()) throw Error('Plugin cache file is aliased');
      else if (verified(rel, name, file)) count++;
    }
  };
  visit();
  if (count !== expected.size) throw Error('Plugin cache payload is missing');
  const args = process.argv.slice(3);
  if (mode === 'verify') {
    if (args.length) throw Error('verify takes no arguments');
    process.stdout.write(
      JSON.stringify({
        status: 'verified',
        inventory: pin,
        native: inventory.native ?? null,
        host: inventory.host ?? null,
      }) + '\n',
    );
  } else if (mode === 'context') {
    const identity = args.length === 1 && args[0] === 'identity';
    if (
      !identity &&
      (![4, 6].includes(args.length) ||
        (args.length === 6 && (args[4] !== '--part' || !/^(?:[0-9]|1[01])$/.test(args[5]))) ||
        args[0] !== '--root' ||
        !isAbsolute(args[1]) ||
        resolve(args[1]) === root ||
        args[2] !== '--binding' ||
        !isAbsolute(args[3]))
    )
      throw Error('Context requires identity or exact absolute root and binding');
    const chunks = [];
    let size = 0;
    if (!identity)
      for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if ((size += bytes.length) > 1024 * 1024) throw Error('Context stdin exceeds 1 MiB');
        chunks.push(bytes);
      }
    const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const { runContextHook } = await import('../runtime/node_modules/@inventarch/steward-hook/dist/context.js');
    process.stdout.write(JSON.stringify(await runContextHook(args, input)) + '\n');
  } else {
    const argsFor = mode === 'claude-guard' ? ['--root', process.env.CLAUDE_PROJECT_DIR] : args;
    if (!['distribution', 'mcp', 'door', 'guard', 'claude-guard'].includes(mode))
      throw Error('Expected verify, distribution, mcp, door or guard');
    const index = argsFor.indexOf('--root');
    if (index < 0 || !argsFor[index + 1] || !isAbsolute(argsFor[index + 1]))
      throw Error('Explicit absolute consumer --root required');
    const consumerRoot = resolve(argsFor[index + 1]),
      consumerRel = relative(root, consumerRoot);
    if (consumerRel === '' || (!consumerRel.startsWith('..') && !isAbsolute(consumerRel)) || within(root, consumerRoot))
      throw Error('Explicit absolute consumer --root required');
    if (mode === 'distribution') {
      process.argv = [
        process.argv[0],
        join(root, 'runtime/node_modules/@inventarch/distribution/dist/cli.js'),
        ...args,
      ];
      await import(pathToFileURL(process.argv[1]).href);
    } else if (mode === 'door') {
      const [operation, ...rest] = args,
        seen = new Set();
      for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i];
        if (!['--root', '--params'].includes(flag) || rest[i + 1] === undefined || seen.has(flag))
          throw Error('door requires <operation> --root <absolute> [--params <JSON|->]');
        seen.add(flag);
      }
      if (!operation || operation.startsWith('-') || rest.length % 2 !== 0 || !seen.has('--root'))
        throw Error('door requires <operation> --root <absolute> [--params <JSON|->]');
      const { runCli } = await import('../runtime/node_modules/@inventarch/cli/dist/main.js');
      const result = runCli(args);
      process.stdout.write(result.stdout);
      process.exitCode = result.exitCode;
    } else if (mode === 'mcp') {
      if (args.length !== 2 || args[0] !== '--root') throw Error('mcp requires exactly --root');
      const { serve } = await import('../runtime/node_modules/@inventarch/mcp-door/dist/main.js');
      await serve(args[1]);
    } else {
      if (mode === 'claude-guard' && args.length) throw Error('Claude binding accepts no event-selected arguments');
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 1024 * 1024) throw Error('Hook input exceeds 1 MiB');
      }
      const { runHook } = await import('../runtime/node_modules/@inventarch/steward-hook/dist/main.js');
      process.stdout.write(JSON.stringify(runHook(argsFor, input)) + '\n');
    }
  }
} catch (error) {
  if (mode === 'context') {
    process.stdout.write(
      JSON.stringify({
        systemMessage: 'IA lifecycle context unavailable (IA-LIFECYCLE-UNAVAILABLE). No context was generated.',
      }) + '\n',
    );
    if (process.argv[3] === 'identity') process.exitCode = 1;
  } else if (mode === 'guard' || mode === 'claude-guard')
    process.stdout.write(JSON.stringify(deny(error.message)) + '\n');
  else {
    process.stderr.write(JSON.stringify({ status: 'refused', message: error.message }) + '\n');
    process.exitCode = 1;
  }
}
