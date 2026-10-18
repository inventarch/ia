// Repository test support for projected feature ownership and relocated resource verification.
export interface ManifestKey {
  source: string;
  revision: string;
  path: string;
}
export interface ProductManifest {
  resourcesDigest: string;
  outputs: readonly { path: string; role: string; sha256: string; resources: readonly ManifestKey[] }[];
}
export interface FeatureSelector {
  id: string;
  name?: string;
  resource?: string;
}
export interface ResolvedProduct {
  outputs: { path: string; sha256: string }[];
  references: { from: string; link: string; target: string }[];
}
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

export class LiveFeatureError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LiveFeatureError';
    this.code = code;
  }
}
function fail(code: string, message: string): never {
  throw new LiveFeatureError(code, message);
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Actual installed qualifier join: runtime metadata never attests resource bytes. */
export const featureFiles = (
  manifest: ProductManifest,
  feature: FeatureSelector,
): ProductManifest['outputs'][number][] =>
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
export function assignFeatures(host: string, manifest: ProductManifest, features: readonly FeatureSelector[]): void {
  for (const output of manifest.outputs.filter((output) => output.role !== 'plugin')) {
    if (
      output.role === 'resource' &&
      (output.resources.length !== 1 ||
        !(
          output.path ===
            `resources/${manifest.resourcesDigest}/${output.resources[0]!.source}/${output.resources[0]!.revision}/${output.resources[0]!.path}` ||
          output.path.endsWith(
            `/parts/${output.resources[0]!.source}/${output.resources[0]!.revision}/${output.resources[0]!.path}`,
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
const EXTERNAL = /^(?:https?|mailto):/i;
const LINK = /\]\((?:<([^>\n]+)>|([^\s)<>]+))(?:\s+"[^"\n]*")?\)/g;

/**
 * Checks an installed product, after relocation, against its projection manifest: every output is a regular file
 * inside the root, reached without a symbolic link, with its recorded SHA-256; every local Markdown link reaches such a
 * file; and every output that uses a resource links to that resource's installed destination. External (`http:`,
 * `https:`, `mailto:`) and fragment-only links name no file. Any other scheme, an absolute path, a backslash or a path
 * above the root resolves outside the product.
 */
export function resourcesResolve(productRoot: string, manifest: ProductManifest): ResolvedProduct {
  const root = realpathSync(productRoot);
  const reach = (path: string, from: string, shown: string): string => {
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
  const inside = (path: string) => path !== '' && path !== '..' && !path.startsWith('../') && !path.startsWith('/');
  const outputs: ResolvedProduct['outputs'] = [],
    references: ResolvedProduct['references'] = [];
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
      const link = match[1] ?? match[2]!;
      if (EXTERNAL.test(link) || link.startsWith('#')) continue;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link) || link.startsWith('/') || link.includes('\\'))
        fail('IA-PT9-RESOURCE-ESCAPE', `${output.path}: ${link} resolves outside the product`);
      let decoded;
      try {
        decoded = decodeURIComponent(link.split('#')[0]!);
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
