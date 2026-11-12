// dec-018's normalisation of one command's JSON output: the workspace root made relative, and the fields that
// differ between two runs of the same build on the same tree removed.

/** Capture's prior-state fields: they describe the snapshot the run replaced, not the tree. */
const CAPTURE_PRIOR = ['prior', 'previous', 'rotated', 'changed', 'new'];
/** Fields dropped wherever they appear. */
const ANYWHERE = new Set(['observedAt', 'timings']);
/** Fields dropped inside a `cache` object. */
const CACHE = new Set(['state', 'observations']);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A pattern for the root in either separator, then the rest of the path it starts. */
function rootPattern(root) {
  const segments = root
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(escape);
  const lead = /^[\\/]/.test(root) ? '[\\\\/]' : '';
  return new RegExp(`${lead}${segments.join('[\\\\/]+')}((?:[\\\\/][^\\s"'\`]*)?)`, 'gi');
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
 * @param {unknown} envelope the command's parsed JSON output
 * @param {string} root the absolute workspace root the command ran on
 * @returns {unknown}
 */
export function normalise(command, envelope, root) {
  const pattern = rootPattern(root);
  const out = walk(envelope, pattern, false);
  if (command === 'capture' && out && typeof out === 'object' && !Array.isArray(out))
    for (const key of CAPTURE_PRIOR) delete out[key];
  return out;
}
