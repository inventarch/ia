/** Exact public whole-system and teaching partition. This module never loads handlers. */
import { systemMember } from '@inventarch/db';
import { EditorSnapshot } from '@inventarch/db/editor';
import type { DistributionSnapshot } from '../../apps/distribution/src/snapshot.js';
import type { EdgeReference } from '../../packages/language/src/index.js';

export interface NativeSystemOwner {
  readonly system: string;
  readonly id: string;
  readonly version: string;
  readonly distribution: string;
}
interface ResourceFile {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  encoding: string;
}
interface ResourceManifest {
  format: 'ia.authoring-resources.v1';
  files: ResourceFile[];
  associations: { owner: { source: string; path: string }; resources: { key: { source: string; path: string } }[] }[];
  index: {
    systems: { system: { source: string; path: string } }[];
    artifacts: unknown[];
    profiles: unknown[];
    documents: unknown[];
    lifecycles: unknown[];
  };
}
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const physicalOwner = (path: string): string | undefined => systemMember(path)?.name;
function references(value: unknown, add: (ref: EdgeReference) => void): void {
  if (Array.isArray(value)) {
    value.forEach((row) => {
      references(row, add);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (
    (row['kind'] === 'ref' && typeof row['discriminator'] === 'string' && typeof row['name'] === 'string') ||
    (row['kind'] === 'identity' && typeof row['identity'] === 'string')
  )
    add(row as unknown as EdgeReference);
  Object.values(row).forEach((item) => {
    references(item, add);
  });
}
/** One source owner per archive; immutable floor code is supplied by the installed language. */
export function systemArchivePartitions(
  snapshot: DistributionSnapshot,
  resourceInput: unknown,
  assetInput: ReadonlyMap<string, Buffer>,
  owners: readonly NativeSystemOwner[],
) {
  const resources = resourceInput as ResourceManifest;
  const names = owners.map((owner) => owner.system).sort(order);
  if (
    new Set(names).size !== names.length ||
    JSON.stringify(names) !== JSON.stringify([...snapshot.folders].sort(order))
  )
    throw new Error('System archive owners differ from the exact native inventory');
  if (
    resources?.format !== 'ia.authoring-resources.v1' ||
    JSON.stringify(Object.keys(resources).sort()) !== JSON.stringify(['associations', 'files', 'format', 'index'])
  )
    throw new Error('Unknown public teaching manifest shape');
  if (
    !resources.index ||
    JSON.stringify(Object.keys(resources.index).sort()) !==
      JSON.stringify(['artifacts', 'documents', 'lifecycles', 'profiles', 'systems']) ||
    ['artifacts', 'documents', 'lifecycles', 'profiles'].some((key) => resources.index[key as 'artifacts'].length)
  )
    throw new Error('Unpartitioned public teaching index owner');
  const resourceOwner = (path: string): string => {
    const owner = physicalOwner(path);
    if (owner && names.includes(owner)) return owner;
    if (path === '.ia/src/floor/README.md' || path === '.ia/src/floor/SPEC.md') return 'authoring-system';
    throw new Error('Unowned public teaching resource: ' + path);
  };
  const rowOwner = (row: { source: string; path: string }): string => {
    if (row.source === 'floor' && row.path === '.ia/src/floor/taxonomy.system.ia') return 'authoring-system';
    if (row.source !== 'self') throw new Error('External public teaching owner');
    const owner = physicalOwner(row.path);
    if (!owner || !names.includes(owner)) throw new Error('Unowned public teaching occurrence');
    return owner;
  };
  for (const row of resources.files)
    if (!assetInput.has(row.path)) throw new Error('Missing exact public teaching bytes: ' + row.path);
  for (const association of resources.associations) {
    const owner = rowOwner(association.owner);
    for (const resource of association.resources)
      if (resource.key.source !== 'self' || resourceOwner(resource.key.path) !== owner)
        throw new Error('Cross-owner public teaching asset requires an explicit policy');
  }
  const reader = new EditorSnapshot({ root: '', ...snapshot });
  try {
    if (
      reader.refused.length ||
      reader.inspect().blockedSystems.length ||
      reader.report.findings.some((row) => row.severity === 'error')
    )
      throw new Error('Public system partition input was not admitted');
    const records = reader.records();
    return owners.map((owner) => {
      const dependencies = new Set<string>();
      const declaration = records.find(
        (row) => row.identity === owner.distribution && row.discriminator === 'distribution',
      );
      const declarationOwner = declaration && physicalOwner(declaration.source.path);
      if (!declarationOwner || !names.includes(declarationOwner))
        throw new Error('Missing selected native distribution declaration');
      if (declarationOwner !== owner.system) dependencies.add(declarationOwner);
      const include = (reference: EdgeReference): void => {
        const resolved = reader.resolve(reference);
        if (!resolved.ok) throw new Error('Unresolved system package dependency');
        const target = records.find((record) => record.identity === resolved.identity);
        const name = target && physicalOwner(target.source.path);
        if (name && name !== owner.system) {
          if (!names.includes(name)) throw new Error('Unselected native dependency');
          dependencies.add(name);
        }
      };
      for (const record of records.filter((row) => physicalOwner(row.source.path) === owner.system)) {
        references(record, include);
        if (record.discriminator === 'system')
          for (const requirement of record.sections
            .filter((row) => row.name === 'requires')
            .flatMap((row) => row.fields)) {
            if (!('item' in requirement) || !('text' in requirement.item))
              throw new Error('Invalid system requirement');
            if (requirement.item.text !== 'floor')
              include({ kind: 'ref', discriminator: 'system', name: requirement.item.text });
          }
      }
      const files = resources.files.filter((row) => resourceOwner(row.path) === owner.system);
      const associations = resources.associations.filter((row) => rowOwner(row.owner) === owner.system);
      const systems = resources.index.systems.filter((row) => rowOwner(row.system) === owner.system);
      const manifest = {
        format: resources.format,
        files,
        associations,
        index: { systems, artifacts: [], profiles: [], documents: [], lifecycles: [] },
      };
      const assets = new Map<string, Buffer>([
        ['LICENSE', assetInput.get('LICENSE')!],
        ['NOTICE', assetInput.get('NOTICE')!],
        ...files.map((row) => [row.path, assetInput.get(row.path)!] as const),
        ['.ia/authoring.resources.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
      ]);
      if ([...assets.values()].some((row) => !Buffer.isBuffer(row)))
        throw new Error('Missing public attribution bytes');
      return {
        owner,
        resourceFiles: files.map((row) => row.path),
        descriptor: {
          formatVersion: 1,
          id: owner.id,
          version: owner.version,
          distribution: owner.distribution,
          engine: '^0.1.0',
          language: ['1.0'],
          dependencies: [...dependencies]
            .sort(order)
            .map((name) => {
              const target = owners.find((row) => row.system === name)!;
              return { id: target.id, range: target.version, systems: [name] };
            })
            .sort((a, b) => order(a.id, b.id)),
          assets: [...assets.keys()].sort(order).map((path) => ({
            path,
            role:
              path === 'LICENSE' || path === 'NOTICE'
                ? 'license'
                : path === '.ia/authoring.resources.json'
                  ? 'asset'
                  : 'documentation',
          })),
          source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
          license: 'Apache-2.0',
          description: 'Owned public native system and explicit teaching assets: ' + owner.system,
        },
        assets,
      };
    });
  } finally {
    reader.close();
  }
}
