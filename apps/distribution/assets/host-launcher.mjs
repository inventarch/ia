// Packaged artifact entrypoint. Its inventory pin is inserted by release assembly.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  pin = '__INVENTORY_DIGEST__';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// `child` is `parent` or under it on disk, compared by device and inode from its deepest existing ancestor up, so another
// spelling a case- or normalization-folding volume opens as the same directory is inside too (#315).
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
  const visit = (path = '', depth = 0) => {
    if (depth > 32) throw Error('Plugin cache directory depth exceeds 32');
    for (const name of readdirSync(join(root, path))) {
      if (++entries > 20000) throw Error('Plugin cache filesystem inventory exceeds its bound');
      const rel = path ? path + '/' + name : name,
        full = join(root, rel),
        stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw Error('Plugin cache links are unsupported');
      if (stat.isDirectory()) visit(rel, depth + 1);
      else {
        if (!stat.isFile() || stat.nlink !== 1) throw Error('Plugin cache file is aliased');
        if (rel === 'inventory.json' || rel === 'scripts/ia.mjs' || rel === 'release.json') continue;
        const file = expected.get(rel);
        if (!file && (name === '.DS_Store' || name.startsWith('._'))) continue;
        if (
          !file ||
          stat.size !== file.bytes ||
          (total += stat.size) > 256 * 1024 * 1024 ||
          hash(readFileSync(full)) !== file.sha256
        )
          throw Error('Plugin cache payload differs: ' + rel);
        count++;
      }
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
    const { runContextHook } = await import('../runtime/node_modules/@ia/steward-hook/dist/context.js');
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
      process.argv = [process.argv[0], join(root, 'runtime/node_modules/@ia/distribution/dist/cli.js'), ...args];
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
      const { runCli } = await import('../runtime/node_modules/@ia/cli/dist/main.js');
      const result = runCli(args);
      process.stdout.write(result.stdout);
      process.exitCode = result.exitCode;
    } else if (mode === 'mcp') {
      if (args.length !== 2 || args[0] !== '--root') throw Error('mcp requires exactly --root');
      const { serve } = await import('../runtime/node_modules/@ia/mcp-door/dist/main.js');
      await serve(args[1]);
    } else {
      if (mode === 'claude-guard' && args.length) throw Error('Claude binding accepts no event-selected arguments');
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 1024 * 1024) throw Error('Hook input exceeds 1 MiB');
      }
      const { runHook } = await import('../runtime/node_modules/@ia/steward-hook/dist/main.js');
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
