// dec-018's normalisation of one command's output or written file: the workspace root made relative, and the
// fields that differ between two runs of the same build on the same tree removed or blanked.

/** Capture's prior-state fields: they describe the snapshot the run replaced, not the tree. */
const CAPTURE_PRIOR = ['prior', 'previous', 'rotated', 'changed', 'new'];
/** Fields dropped wherever they appear: the evidence times and timings that change on every run. */
const ANYWHERE = new Set(['observedAt', 'capturedAt', 'timings']);
/** Fields dropped inside a `cache` object. */
const CACHE = new Set(['state', 'observations']);
/** The same evidence times in a written `.ia` file's text, whose values are blanked. */
const TEXT_TIMES = /^(\s*(?:observed-at|captured-at) )"[^"\n]*"$/gm;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A pattern for the root in either separator, then the rest of the path it starts. The root must stand alone: not
 * the end of a longer path, and not the start of a longer name.
 */
function rootPattern(root) {
  const segments = root
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(escape);
  const lead = /^[\\/]/.test(root) ? '(?<![\\w.:-])[\\\\/]' : '(?<![\\w.:\\\\/-])';
  return new RegExp(`${lead}${segments.join('[\\\\/]+')}(?![\\w.-])((?:[\\\\/][^\\s"'\`]*)?)`, 'gi');
}

function walk(value, pattern, inCache) {
  if (typeof value === 'string') return value.replace(pattern, (_, tail) => `<root>${tail.replace(/\\/g, '/')}`);
  if (Array.isArray(value)) return value.map((item) => walk(item, pattern, false));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (ANYWHERE.has(key) || (inCache && CACHE.has(key))) continue;
      out[key] = walk(item, pattern, key === 'cache');
    }
    return out;
  }
  return value;
}

/**
 * @param {string} command the probe's command name, such as `validate` or `capture`
 * @param {unknown} envelope the command's parsed JSON output, or the text of an output that is not JSON
 * @param {string} root the absolute workspace root the command ran on
 * @returns {unknown}
 */
export function normalise(command, envelope, root) {
  const pattern = rootPattern(root);
  if (typeof envelope === 'string') return walk(envelope, pattern, false).replace(TEXT_TIMES, '$1"<time>"');
  const out = walk(envelope, pattern, false);
  if (command === 'capture' && out && typeof out === 'object' && !Array.isArray(out))
    for (const key of CAPTURE_PRIOR) delete out[key];
  return out;
}
