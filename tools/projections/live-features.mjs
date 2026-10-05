// PT9 (#274) helpers for the synthetic fixture's host feature matrix. Node built-ins only.
// featureRows builds an ia.host-feature-matrix.v1 value from per-host observations; requestCarries decides
// from one captured model request whether the host supplied a projected feature; resourcesResolve checks an
// installed (relocated) product's resource references. None of them runs a host or a model.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

export const STATUSES = Object.freeze(['unsupported', 'generated', 'process', 'live-host']);
export const MATRIX_FORMAT = 'ia.host-feature-matrix.v1';
// No host process ran for these statuses, so the row may carry no host version.
const HOSTLESS = new Set(['unsupported', 'generated']);
const ROW_FIELDS = ['feature', 'host', 'hostVersion', 'profileDigest', 'os', 'runtime', 'status', 'evidence'];

export class LiveFeatureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveFeatureError';
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new LiveFeatureError(code, message);
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** Actual installed qualifier join: runtime metadata never attests resource bytes. */
export const featureFiles = (manifest, feature) =>
  manifest.outputs.filter((output) =>
    feature.resource
      ? output.role === 'resource' && output.resources.some((key) => key.path === feature.resource)
      : output.role !== 'resource' &&
        output.role !== 'plugin' &&
        (output.path
          .split('/')
          .some((part) => [feature.name, feature.name + '.md', feature.name + '.toml'].includes(part)) ||
          (feature.name === 'fictional-reviewer' && output.path === '.codex/config.toml')),
  );
export function assignFeatures(host, manifest, features) {
  for (const output of manifest.outputs.filter((output) => output.role !== 'plugin')) {
    if (
      output.role === 'resource' &&
      (output.resources.length !== 1 ||
        !(
          output.path ===
            `resources/${manifest.resourcesDigest}/${output.resources[0].source}/${output.resources[0].revision}/${output.resources[0].path}` ||
          output.path.endsWith(
            `/parts/${output.resources[0].source}/${output.resources[0].revision}/${output.resources[0].path}`,
          )
        ))
    )
      fail('IA-PT9-RESOURCE-PROVENANCE', `${host}: ${output.path} does not attest its own resource bytes`);
    if (output.path.endsWith('/verify-resources.mjs') && (output.role !== 'host-metadata' || output.resources.length))
      fail('IA-PT9-RESOURCE-PROVENANCE', `${host}: verifier is runtime metadata, not a resource`);
    if (features.filter((feature) => featureFiles(manifest, feature).includes(output)).length !== 1)
      fail('IA-PT9-FEATURE-OWNERSHIP', `${host}: ${output.path} must belong to exactly one feature`);
  }
  for (const feature of features)
    if (!featureFiles(manifest, feature).length) fail('IA-PT9-FEATURE-MISSING', `${host}: ${feature.id} has no output`);
}
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with object keys sorted by code unit at every depth; array order is kept. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item ?? null)).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort(byCodeUnit)
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** One row per feature and host, sorted by (feature, host), with a digest over the canonical matrix. */
export function featureRows(inventory, observations) {
  const features = new Map(inventory.features.map((feature) => [feature.id, feature])),
    seen = new Set(),
    rows = [];
  for (const observation of observations) {
    const named = `Row ${observation.feature} on ${observation.host}`;
    if (!STATUSES.includes(observation.status))
      fail('IA-PT9-STATUS-UNKNOWN', `${named}: unknown status ${JSON.stringify(observation.status)}`);
    if (!features.has(observation.feature)) fail('IA-PT9-FEATURE-UNKNOWN', `${named}: feature is not in the inventory`);
    if (observation.hostVersion === null && !HOSTLESS.has(observation.status))
      fail('IA-PT9-HOST-VERSION', `${named}: ${observation.status} needs a host version`);
    if (observation.status === 'live-host' && !observation.evidence?.observation)
      fail('IA-PT9-OBSERVATION-MISSING', `${named}: live-host needs an observation reference`);
    const key = JSON.stringify([observation.feature, observation.host]);
    if (seen.has(key)) fail('IA-PT9-ROW-DUPLICATE', `${named} appears more than once`);
    seen.add(key);
    rows.push(Object.fromEntries(ROW_FIELDS.map((field) => [field, observation[field]])));
  }
  for (const feature of inventory.features)
    for (const host of feature.requiredHosts) {
      if (!seen.has(JSON.stringify([feature.id, host])))
        fail('IA-PT9-ROW-MISSING', `Feature ${feature.id} has no row for required host ${host}`);
    }
  rows.sort((a, b) => byCodeUnit(a.feature, b.feature) || byCodeUnit(a.host, b.host));
  const body = { format: MATRIX_FORMAT, inventoryDigest: inventory.digest, rows };
  return { ...body, digest: sha256(canonicalJson(body)) };
}

/** A command file's body as a host injects it: YAML frontmatter removed, surrounding blank lines trimmed. */
export function commandBody(file) {
  const end = file.startsWith('---\n') ? file.indexOf('\n---\n', 3) : -1;
  return (end < 0 ? file : file.slice(end + 5)).trim();
}

const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
};
const word = /[A-Za-z0-9_-]/;
// Occurrences with no name character directly before or after: `fictional-review` is not inside `fictional-reviewer`.
const bounded = (text, needle) => {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : text[at - 1],
      after = text[at + needle.length] ?? '';
    if (!word.test(before) && !word.test(after)) count++;
  }
  return count;
};

/**
 * Whether a captured model request (its parsed body or JSON text) carries a projected feature that the host,
 * not the user's prompt, supplied. Exactly one of `text` (a description or name) or `command` (a command file,
 * whose body must appear with `$ARGUMENTS[0]` replaced by `argument`). The user's own prompt text is blanked out
 * of every string before the search, so a needle the user typed is never counted.
 */
export function requestCarries(request, expectation) {
  const { text, command, argument, prompt } = expectation;
  const named = [text, command].filter((value) => typeof value === 'string' && value !== '');
  if (named.length !== 1 || (text !== undefined && command !== undefined))
    fail('IA-PT9-EXPECTATION-INVALID', 'An expectation names exactly one non-empty text or command');
  let needle = text;
  if (command !== undefined) {
    const body = commandBody(command);
    if (!body.includes('$ARGUMENTS[0]') || typeof argument !== 'string' || argument === '')
      fail('IA-PT9-EXPECTATION-INVALID', 'A command expectation needs a body with $ARGUMENTS[0] and an argument');
    needle = body.replaceAll('$ARGUMENTS[0]', argument);
  }
  const body = typeof request === 'string' ? JSON.parse(request) : request;
  let occurrences = 0;
  for (const value of strings(body))
    occurrences += bounded(prompt ? value.split(prompt).join('\u0000') : value, needle);
  return { carried: occurrences > 0, occurrences };
}

const EXTERNAL = /^(?:https?|mailto):/i;
const LINK = /\]\((?:<([^>\n]+)>|([^\s)<>]+))(?:\s+"[^"\n]*")?\)/g;

/**
 * Checks an installed product, after relocation, against its projection manifest: every output is a regular file
 * inside the root, reached without a symbolic link, with its recorded SHA-256; every local Markdown link reaches such a
 * file; and every output that uses a resource links to that resource's installed destination. External (`http:`,
 * `https:`, `mailto:`) and fragment-only links name no file. Any other scheme, an absolute path, a backslash or a path
 * above the root resolves outside the product.
 */
export function resourcesResolve(productRoot, manifest) {
  const root = realpathSync(productRoot);
  const reach = (path, from, shown) => {
    let current = root;
    for (const [index, part] of path.split('/').entries()) {
      current = join(current, part);
      let stat;
      try {
        stat = lstatSync(current);
      } catch {
        fail('IA-PT9-RESOURCE-MISSING', `${from}: ${shown} does not reach a file`);
      }
      if (stat.isSymbolicLink())
        fail(
          'IA-PT9-RESOURCE-LINK',
          `${from}: ${shown} passes through the symbolic link ${path
            .split('/')
            .slice(0, index + 1)
            .join('/')}`,
        );
      if (index === path.split('/').length - 1 && !stat.isFile())
        fail('IA-PT9-RESOURCE-NOT-FILE', `${from}: ${shown} is not a regular file`);
    }
    if (!realpathSync(current).startsWith(root + sep))
      fail('IA-PT9-RESOURCE-ESCAPE', `${from}: ${shown} resolves outside the product`);
    return current;
  };
  const inside = (path) => path !== '' && path !== '..' && !path.startsWith('../') && !path.startsWith('/');
  const outputs = [],
    references = [];
  for (const output of manifest.outputs) {
    const path = posix.normalize(output.path);
    if (!inside(path) || output.path.includes('\\'))
      fail('IA-PT9-RESOURCE-ESCAPE', `manifest: ${output.path} resolves outside the product`);
    const bytes = readFileSync(reach(path, 'manifest', output.path));
    if (sha256(bytes) !== output.sha256)
      fail('IA-PT9-RESOURCE-DIGEST', `${output.path}: installed bytes differ from the manifest`);
    outputs.push({ path: output.path, sha256: output.sha256 });
  }
  for (const output of manifest.outputs) {
    if (!output.path.endsWith('.md')) continue;
    const text = readFileSync(join(root, ...output.path.split('/')), 'utf8');
    for (const match of text.matchAll(LINK)) {
      const link = match[1] ?? match[2];
      if (EXTERNAL.test(link) || link.startsWith('#')) continue;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link) || link.startsWith('/') || link.includes('\\'))
        fail('IA-PT9-RESOURCE-ESCAPE', `${output.path}: ${link} resolves outside the product`);
      let decoded;
      try {
        decoded = decodeURIComponent(link.split('#')[0]);
      } catch {
        fail('IA-PT9-RESOURCE-MISSING', `${output.path}: ${link} does not reach a file`);
      }
      const target = posix.normalize(posix.join(posix.dirname(output.path), decoded));
      if (!inside(target)) fail('IA-PT9-RESOURCE-ESCAPE', `${output.path}: ${link} resolves outside the product`);
      reach(target, output.path, link);
      references.push({ from: output.path, link, target });
    }
    if (output.role === 'resource') continue;
    for (const key of output.resources) {
      const destination = `resources/${manifest.resourcesDigest}/${key.source}/${key.revision}/${key.path}`;
      const destinations = [
        destination,
        ...(output.path.endsWith('/SKILL.md')
          ? [`${posix.dirname(output.path)}/parts/${key.source}/${key.revision}/${key.path}`]
          : []),
      ];
      if (!references.some((reference) => reference.from === output.path && destinations.includes(reference.target)))
        fail(
          'IA-PT9-RESOURCE-UNREFERENCED',
          `${output.path}: required resource ${key.path} has no link to ${destination}`,
        );
    }
  }
  return { outputs, references };
}
