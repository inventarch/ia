/**
 * Lexical normalisation of a source path (spec 1.4): forward slashes; no empty, `.` or resolvable
 * `..` segments; no leading `./`. Case is kept as given, because compile has no file system to ask.
 */
export function canonicalPath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('\\').join('/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}
