import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { portablePath } from '@inventarch/db/distribution';
import { readWorkspaceBytes } from '@inventarch/db';
/** An export is an explicit workspace file, never an authored input or a linked destination. */
export function knowledgeOutput(root: string, given: string, protectedPaths: readonly string[], bytes: string) {
  const absolute = resolve(root, given),
    path = relative(root, absolute).replaceAll('\\', '/');
  portablePath(path);
  if (
    !path ||
    isAbsolute(path) ||
    path === '..' ||
    path.startsWith('../') ||
    ['.ia', '.git'].includes(path.split('/')[0]!.toLowerCase()) ||
    protectedPaths.some((p) => p.toLowerCase() === path.toLowerCase())
  )
    throw new Error('Knowledge output must be outside authored and selected paths within the workspace');
  const parents = () => {
    let parent = root;
    const rows = [];
    for (const part of path.split('/')) {
      const stat = lstatSync(parent, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe knowledge output directory');
      const names = readdirSync(parent);
      if (names.some((name) => name !== part && name.toLowerCase() === part.toLowerCase()))
        throw new Error('Knowledge output has a case alias');
      // Short-name aliases are not a distinct governance coordinate.
      const child = join(parent, part);
      const present = lstatSync(child, { throwIfNoEntry: false });
      if (present && !names.includes(part)) throw new Error('Knowledge output has a filesystem alias');
      rows.push({ path: parent, dev: String(stat.dev), ino: String(stat.ino), real: realpathSync(parent) });
      parent = child;
    }
    return JSON.stringify(rows);
  };
  const before = parents();
  const current = () => {
    if (parents() !== before) throw new Error('Knowledge output directory changed');
    const leaf = lstatSync(absolute, { throwIfNoEntry: false });
    if (!leaf) return false;
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) throw new Error('Unsafe knowledge output');
    if (!Buffer.from(readWorkspaceBytes(root, path, 20 * 1024 * 1024)).equals(Buffer.from(bytes)))
      throw new Error('Knowledge output already contains different bytes');
    return true;
  };
  return {
    absolute,
    path,
    unchanged: current(),
    write() {
      if (current()) return false;
      const fd = openSync(
        absolute,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const opened = fstatSync(fd, { bigint: true }),
          named = lstatSync(absolute, { bigint: true });
        if (
          parents() !== before ||
          !opened.isFile() ||
          opened.nlink !== 1n ||
          named.isSymbolicLink() ||
          opened.dev !== named.dev ||
          opened.ino !== named.ino ||
          realpathSync(dirname(absolute)) !== realpathSync(dirname(resolve(root, path)))
        )
          throw new Error('Knowledge output changed before writing');
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        return true;
      } finally {
        closeSync(fd);
      }
    },
  };
}
