import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

/** Select an argv-safe invocation of a trusted installed package-manager entry. Never invoke a shell. */
export function packageManagerCommand(launcher, args, nodePath = process.execPath) {
  if (typeof launcher !== 'string' || !launcher || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error('Invalid package-manager invocation');
  if (!statSync(launcher).isFile()) throw new Error('Package-manager launcher must be a regular file');
  const file = openSync(launcher, 'r');
  let header;
  try {
    if (!fstatSync(file).isFile()) throw new Error('Package-manager launcher must be a regular file');
    const bytes = Buffer.alloc(4096);
    header = bytes.subarray(0, readSync(file, bytes, 0, bytes.length, 0));
  } finally {
    closeSync(file);
  }
  const magic = header.subarray(0, 4).toString('hex');
  const native =
    header.subarray(0, 2).toString('ascii') === 'MZ' ||
    [
      '7f454c46',
      'feedface',
      'cefaedfe',
      'feedfacf',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca',
    ].includes(magic);
  if (native) return { command: launcher, args: [...args] };
  const firstLine = header.toString('utf8').split(/\r?\n/, 1)[0];
  const nodeScript =
    /^#![^\r\n]*[/\s]node(?:[ \t]|$)/.test(firstLine) ||
    (!firstLine.startsWith('#!') && /\.[cm]?js$/i.test(launcher) && !header.includes(0));
  if (nodeScript) return { command: nodePath, args: [launcher, ...args] };
  throw new Error('Unsupported package-manager launcher: require a native executable or Node entry script');
}
