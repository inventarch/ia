import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';

/** Select an argv-safe invocation of a trusted installed package-manager entry. Never invoke a shell. */
export function packageManagerCommand(launcher, args, nodePath = process.execPath) {
  if (typeof launcher !== 'string' || !launcher || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error('Invalid package-manager invocation');
  // Open before judging, so the type check and the header read are of one file. Links stay followed, as an installed
  // launcher is often one; NONBLOCK keeps a FIFO from blocking the open and NOCTTY keeps a terminal from becoming ours.
  let file;
  try {
    file = openSync(launcher, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
  } catch (error) {
    // Report a launcher that cannot be opened as the stat by name did: a missing one by its stat error, and a directory,
    // which Windows will not open, as not a regular file. Anything else, such as EACCES, is the open's error, as before.
    if (!statSync(launcher).isFile()) throw new Error('Package-manager launcher must be a regular file');
    throw error;
  }
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
