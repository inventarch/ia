import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import { emitFrontmatter, type FrontField } from '../host-plugin/frontmatter.js';
import { HostPluginError } from '../host-plugin/errors.js';
import { MANIFESTS, type PluginHost } from '../host-plugin/inventory.js';
import { toolsOf } from '../host-plugin/lower.js';
import { type PluginProduct, pluginManifest } from '../host-plugin/manifest.js';
import { stated, textsAt, valuesAt } from './format.js';

export interface PluginResource {
  readonly owner: string;
  readonly role: string;
  readonly delivery: 'inline' | 'installed-reference';
  /** Plugin-relative output path for an installed reference; unused for an inline body. */
  readonly output: string;
  readonly bytes: Buffer;
}
export interface PluginAsset {
  readonly output: string;
  readonly bytes: Buffer;
}
export interface PluginFile {
  readonly path: string;
  readonly bytes: Buffer;
}

const AUTHORED = 100;
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const plain = (text: string): FrontField['value'] => ({ kind: 'string', text, style: 'plain' });

/** The plugin a workspace's one product `@distribution` describes: manifests, skills, agents, references and assets. */
export function renderPlugin(
  reader: ReadHandle,
  within: string,
  resources: readonly PluginResource[],
  assets: readonly PluginAsset[],
): readonly PluginFile[] {
  const records = reader.records({ within });
  const authored = (word: string): Node[] =>
    records
      .filter((node) => node.discriminator === word && node.band === AUTHORED)
      .sort((a, b) => (a.identity < b.identity ? -1 : 1));
  const one = (node: Node, field: string): string | undefined => textsAt(node, field)[0];
  const products = authored('distribution').filter((node) => stated(node, 'product.name'));
  if (products.length !== 1)
    throw new HostPluginError(
      'IA-PLUGIN-PRODUCT',
      `A plugin product needs exactly one @distribution with a product section; found ${products.length}`,
    );
  const d = products[0]!;
  const out: PluginFile[] = [];
  /** A plugin-relative output path that is the same on every host: relative, POSIX, with no dot segment. */
  const portable = (output: string): string => {
    if (
      output === '' ||
      output.startsWith('/') ||
      output.includes('\\') ||
      /^[A-Za-z]:/.test(output) ||
      output.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    )
      throw new HostPluginError('IA-PLUGIN-PRODUCT', `${output} is not a portable plugin path`);
    return output;
  };
  const add = (path: string, bytes: Buffer): void => {
    if (out.some((file) => file.path === path))
      throw new HostPluginError('IA-PLUGIN-PRODUCT', `Two sources render ${path}`);
    out.push(Object.freeze({ path, bytes }));
  };
  const name = one(d, 'product.name');
  if (name === undefined) throw new HostPluginError('IA-PLUGIN-PRODUCT', `${d.identity}: product.name is not a name`);
  const product: PluginProduct = {
    name,
    displayName: one(d, 'product.display-name'),
    version: one(d, 'product.version'),
    description: one(d, 'product.description'),
    author: one(d, 'product.author'),
    license: one(d, 'product.license'),
    keywords: stated(d, 'product.keywords') ? textsAt(d, 'product.keywords') : undefined,
    shortDescription: one(d, 'product.short-description'),
    category: one(d, 'product.category'),
  };
  // One plugin carries every host its product lists; a product that lists none would render a plugin with no manifest.
  const hosts = textsAt(d, 'product.hosts').filter((host): host is PluginHost => Object.hasOwn(MANIFESTS, host));
  if (hosts.length === 0)
    throw new HostPluginError(
      'IA-PLUGIN-PRODUCT',
      `${d.identity}: product.hosts names no host; a plugin needs at least one manifest`,
    );
  for (const host of hosts) add(MANIFESTS[host], json(pluginManifest(product, host)));
  const bodyOf = (owner: string): Buffer => {
    const bodies = resources.filter((r) => r.owner === owner && r.role === 'body' && r.delivery === 'inline');
    if (bodies.length !== 1)
      throw new HostPluginError(
        'IA-PLUGIN-PRODUCT',
        `${owner} needs exactly one inline body resource; found ${bodies.length}`,
      );
    return bodies[0]!.bytes;
  };
  for (const capability of authored('capability').filter((node) => stated(node, 'invocation.mode'))) {
    const mode = one(capability, 'invocation.mode');
    if (mode === 'none') continue;
    if (mode === 'delegated')
      throw new HostPluginError(
        'IA-PROJECT-FEATURE',
        `${capability.identity}: delegated skills are not rendered by this version of ia`,
      );
    const fields: FrontField[] = [
      { key: 'name', value: plain(capability.name) },
      { key: 'description', value: plain(one(capability, 'meaning.says') ?? '') },
      ...(mode === 'user'
        ? [{ key: 'disable-model-invocation', value: { kind: 'boolean' as const, value: true } }]
        : []),
      ...(one(capability, 'invocation.argument-hint') === undefined
        ? []
        : [{ key: 'argument-hint', value: plain(one(capability, 'invocation.argument-hint')!) }]),
    ];
    add(
      `skills/${capability.name}/SKILL.md`,
      Buffer.concat([Buffer.from(emitFrontmatter(fields)), bodyOf(capability.identity)]),
    );
    for (const reference of resources.filter(
      (r) => r.owner === capability.identity && r.delivery === 'installed-reference',
    ))
      add(portable(reference.output), reference.bytes);
  }
  const nodes = new Map(records.map((node) => [node.identity, node]));
  // An agent-profile without an invocation mode is not a plugin entry point (ruling R3).
  for (const profile of authored('agent-profile').filter((node) => stated(node, 'invocation.mode'))) {
    const mode = one(profile, 'invocation.mode');
    if (mode === 'none') continue;
    if (mode === 'delegated')
      throw new HostPluginError(
        'IA-PROJECT-FEATURE',
        `${profile.identity}: delegated agents are not rendered by this version of ia`,
      );
    const effects = valuesAt(profile, 'composition.capabilities').flatMap((value) => {
      const resolved = value.kind === 'ref' ? reader.resolve(value, { within }) : undefined;
      const target = resolved?.ok ? nodes.get(resolved.identity) : undefined;
      if (!target) throw new HostPluginError('IA-PLUGIN-PRODUCT', `${profile.identity}: an unresolved capability`);
      return textsAt(target, 'execution.effects');
    });
    const tools = toolsOf(effects);
    if (tools.length === 0)
      throw new HostPluginError('IA-PROJECT-FEATURE', `${profile.identity}: its capabilities allow no host tool`);
    const optional = (key: string, field: string): FrontField[] =>
      one(profile, field) === undefined ? [] : [{ key, value: plain(one(profile, field)!) }];
    const fields: FrontField[] = [
      { key: 'name', value: plain(profile.name) },
      { key: 'description', value: plain(one(profile, 'meaning.says') ?? '') },
      { key: 'tools', value: plain(tools.join(', ')) },
      ...optional('model', 'execution.model-profile'),
      ...optional('color', 'presentation.color'),
      ...optional('effort', 'execution.effort'),
    ];
    add(`agents/${profile.name}.md`, Buffer.concat([Buffer.from(emitFrontmatter(fields)), bodyOf(profile.identity)]));
  }
  for (const asset of assets) add(portable(asset.output), asset.bytes);
  return Object.freeze(out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

export {
  compileStandalonePlugin,
  type StandaloneBindingRow,
  type StandalonePluginHost,
  type StandalonePluginOptions,
} from './standalone-plugin.js';
