/**
 * Fold a prose (`"""`) value. Spec 2.4 as amended by plan 1: a line break plus the
 * continuation line's leading indentation becomes one space; a blank line becomes one
 * paragraph break (`\n`); runs of blank lines collapse to one; the whole is trimmed.
 * Characters inside a line are never changed.
 */
export function foldProse(raw: string): string {
  const lines = raw.split('\n').map((line) => line.trim());
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs.join('\n').trim();
}
