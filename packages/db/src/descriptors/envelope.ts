import semver from 'semver';
import type { CompiledChild, CompiledRecord } from '@inventarch/language';
import { types } from 'node:util';
import { attempt, deepFreeze, digestOf, parseResource, refuse, refuseEnvelope, snapshot } from './codec.js';
import type { DecodedResource, DescriptorKind, DescriptorResult, Scope } from './codec.js';

/**
 * The native owner/resource envelope: the owned section of one admitted record, as text. Refs keep their
 * canonical `@discriminator name` rendering; lists are arrays. A host extracts it with envelopeFromRecord.
 */
export interface DescriptorEnvelope {
  readonly kind: DescriptorKind;
  /** Canonical native identity `system/kind/discriminator/name` of the record that owns the resource. */
  readonly owner: string;
  /** Source path of that record, for attribution. */
  readonly source: string;
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
}
/** Same-envelope resource bytes the host has disclosed to this compilation, keyed by relative resource key. */
export type DisclosedResources = Readonly<Record<string, string>>;

export const SECTIONS: Readonly<
  Record<DescriptorKind, { readonly section: string; readonly lowering: string; readonly fields: readonly string[] }>
> = Object.freeze({
  'domain-model': { section: 'model', lowering: 'definition', fields: ['format', 'version', 'resource', 'digest'] },
  'storage-binding': {
    section: 'storage',
    lowering: 'binding',
    fields: ['format', 'model', 'model-version', 'port', 'adapter', 'schema-version', 'resource', 'digest'],
  },
  'app-composition': {
    section: 'app',
    lowering: 'definition',
    fields: ['format', 'app-id', 'version', 'resource', 'digest', 'capabilities'],
  },
});
const LIST_FIELDS = new Set(['capabilities']);

/** Read the owned envelope section of an admitted native record; native admission itself stays in the view. */
export function envelopeFromRecord(record: CompiledRecord): DescriptorResult<DescriptorEnvelope> {
  return attempt(
    () => ({ owner: record.identity, source: record.source.path }),
    () => {
      const kind = record.discriminator as DescriptorKind,
        shape = SECTIONS[kind];
      if (!Object.hasOwn(SECTIONS, kind) || shape === undefined)
        refuseEnvelope('DESC-ENVELOPE-INVALID', 'discriminator', 'Record is not a descriptor envelope');
      const section = record.sections.find((candidate) => candidate.name === shape.section);
      if (!section) refuseEnvelope('DESC-ENVELOPE-INVALID', shape.section, 'Descriptor envelope section is missing');
      const fields: Record<string, string | readonly string[]> = {};
      for (const child of section.fields as readonly CompiledChild[]) {
        if (!('key' in child))
          refuseEnvelope('DESC-ENVELOPE-INVALID', shape.section, 'Descriptor envelope holds only fields');
        const value = child.value;
        if (value.kind === 'list')
          fields[child.key] = value.items.map((item, index) =>
            item.kind === 'ref'
              ? `@${item.discriminator} ${item.name}`
              : item.kind === 'scalar' || item.kind === 'string'
                ? item.text
                : refuseEnvelope(
                    'DESC-ENVELOPE-INVALID',
                    `${shape.section}.${child.key}[${index}]`,
                    'Unsupported envelope list item',
                  ),
          );
        else if (value.kind === 'ref') fields[child.key] = `@${value.discriminator} ${value.name}`;
        else if (value.kind === 'scalar' || value.kind === 'string') fields[child.key] = value.text;
        else refuseEnvelope('DESC-ENVELOPE-INVALID', `${shape.section}.${child.key}`, 'Unsupported envelope value');
      }
      return deepFreeze({ kind, owner: record.identity, source: record.source.path, fields });
    },
  );
}

export interface ResolvedEnvelope {
  readonly kind: DescriptorKind;
  readonly owner: string;
  readonly source: string;
  readonly name: string;
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
  readonly resource: { readonly key: string; readonly digest: string };
  /** Digest of the canonical envelope: the compilation's input digest. */
  readonly digest: string;
}
export const scopeOf = (envelope: unknown): Scope => {
  const row = envelope !== null && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : {};
  return {
    owner: typeof row['owner'] === 'string' ? row['owner'] : '',
    source: typeof row['source'] === 'string' ? row['source'] : '',
  };
};
const RESOURCE_KEY = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,7}\.json$/;

/**
 * Read each compiler input field exactly once, as a data property of a plain non-proxy object. Envelope and
 * resource values are then snapshotted as plain data, so no getter or proxy can change what later checks see.
 */
export function readInput(input: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input))
    refuseEnvelope('DESC-ENVELOPE-INVALID', '', 'Compiler input must be a plain object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    refuseEnvelope('DESC-ENVELOPE-INVALID', '', 'Compiler input must be a plain object');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined && !('value' in descriptor))
      refuseEnvelope('DESC-ENVELOPE-INVALID', key, 'Compiler input fields must be data properties');
    result[key] = descriptor?.value;
  }
  return result;
}
export const snapshotEnvelope = (value: unknown): unknown =>
  snapshot(value, 'DESC-ENVELOPE-INVALID', '', { depth: 3, nodes: 1_000 });
/** Missing permission is absence: a resource the host did not put in this map is undisclosed (DESC-01). */
export const snapshotResources = (value: unknown): DisclosedResources =>
  snapshot(value, 'DESC-RESOURCE-UNDISCLOSED', 'resources', { depth: 1, nodes: 10_001 }) as DisclosedResources;
/** Validate the closed envelope for one kind. Faults are attributed to `section.field`. */
export function resolveEnvelope(envelope: DescriptorEnvelope, kind: DescriptorKind): ResolvedEnvelope {
  const shape = SECTIONS[kind],
    at = (field: string): string => `${shape.section}.${field}`;
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    Object.keys(envelope).sort().join() !== 'fields,kind,owner,source'
  )
    refuseEnvelope('DESC-ENVELOPE-INVALID', shape.section, 'Envelope needs exactly kind, owner, source and fields');
  if (envelope.kind !== kind) refuseEnvelope('DESC-ENVELOPE-INVALID', 'kind', `Expected a ${kind} envelope`);
  const identity = typeof envelope.owner === 'string' ? envelope.owner.split('/') : [];
  if (
    identity.length !== 4 ||
    identity.some((part) => !/^[a-z][a-z0-9-]*$/.test(part)) ||
    identity[1] !== shape.lowering ||
    identity[2] !== kind
  )
    refuseEnvelope(
      'DESC-ENVELOPE-INVALID',
      'owner',
      'Owner must be the canonical native identity of the envelope record',
    );
  // The source must be a record file of the owner's system: authored, or inside a verified installed store. Segments
  // use [A-Za-z0-9._-] only, so no control, bidi or separator characters reach compiled output or diagnostics.
  const source = typeof envelope.source === 'string' && envelope.source.length <= 1024 ? envelope.source : '';
  const system = identity[0]!,
    prefix = /^\.ia\/distributions\/store\/[a-f0-9]{64}\//.exec(source)?.[0] ?? '';
  if (
    !source.startsWith(`${prefix}.ia/src/systems/${system}/`) ||
    !source.endsWith('.ia') ||
    source.split('/').some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')
  )
    refuseEnvelope('DESC-ENVELOPE-INVALID', 'source', "Source must be a native record path inside the owner's system");
  const fields = envelope.fields;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields))
    refuseEnvelope('DESC-ENVELOPE-INVALID', shape.section, 'Envelope fields must be an object');
  for (const key of Object.keys(fields))
    if (!shape.fields.includes(key)) refuseEnvelope('DESC-ENVELOPE-INVALID', at(key), 'Unknown envelope field');
  for (const key of shape.fields) {
    const value = fields[key];
    if (value === undefined) refuseEnvelope('DESC-ENVELOPE-INVALID', at(key), 'Required envelope field is missing');
    if (
      LIST_FIELDS.has(key)
        ? !Array.isArray(value) || value.some((item) => typeof item !== 'string')
        : typeof value !== 'string'
    )
      refuseEnvelope('DESC-ENVELOPE-INVALID', at(key), 'Envelope field has the wrong shape');
  }
  const text = (key: string): string => fields[key] as string;
  if (!/^[+-]?\d+$/.test(text('format')))
    refuseEnvelope('DESC-ENVELOPE-INVALID', at('format'), 'Envelope format must be an integer');
  if (Number(text('format')) !== 1)
    refuseEnvelope('DESC-FORMAT-UNSUPPORTED', at('format'), 'Unsupported envelope format');
  for (const key of ['version', 'model-version', 'schema-version'])
    if (key in fields && semver.valid(text(key)) !== text(key))
      refuseEnvelope('DESC-ENVELOPE-INVALID', at(key), 'Expected an exact SemVer version');
  for (const key of ['port', 'adapter', 'app-id'])
    if (key in fields && !/^[a-z][a-z0-9-]{0,63}$/.test(text(key)))
      refuseEnvelope(
        /[:/.]/.test(text(key)) ? 'DESC-EXECUTABLE-REFUSED' : 'DESC-ENVELOPE-INVALID',
        at(key),
        'Expected a native id',
      );
  if ('model' in fields && !/^@domain-model [a-z][a-z0-9-]{0,63}$/.test(text('model')))
    refuseEnvelope('DESC-ENVELOPE-INVALID', at('model'), 'Expected a ref to domain-model');
  if (kind === 'app-composition') {
    const names = fields['capabilities'] as readonly string[];
    names.forEach((item, index) => {
      if (!/^@capability [a-z][a-z0-9-]{0,63}$/.test(item))
        refuseEnvelope('DESC-ENVELOPE-INVALID', `${at('capabilities')}[${index}]`, 'Expected a ref to capability');
    });
    if (new Set(names).size !== names.length)
      refuseEnvelope('DESC-NAME-DUPLICATE', at('capabilities'), 'Capability refs must be unique');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(text('digest')))
    refuseEnvelope('DESC-ENVELOPE-INVALID', at('digest'), 'Expected sha256:<64 lowercase hex>');
  const key = text('resource');
  if (!RESOURCE_KEY.test(key) || key.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.')))
    refuseEnvelope(
      'DESC-RESOURCE-REFERENCE',
      at('resource'),
      'Resource must be a same-envelope relative .json key, never a URL, absolute path or import',
    );
  const copy: Record<string, string | readonly string[]> = Object.fromEntries(
    shape.fields.map((name) => [
      name,
      LIST_FIELDS.has(name) ? [...(fields[name] as readonly string[])] : (fields[name] as string),
    ]),
  );
  const canonical = { kind, owner: envelope.owner, source: envelope.source, fields: copy };
  return deepFreeze({
    kind,
    owner: envelope.owner,
    source: envelope.source,
    name: identity[3]!,
    fields: copy,
    resource: { key, digest: text('digest') },
    digest: digestOf(canonical),
  });
}

/** Resolve the disclosed resource and verify the envelope digest binding. */
export function bindResource(envelope: ResolvedEnvelope, resources: DisclosedResources): DecodedResource {
  const section = SECTIONS[envelope.kind].section;
  if (resources === null || typeof resources !== 'object' || Array.isArray(resources))
    refuseEnvelope('DESC-RESOURCE-UNDISCLOSED', `${section}.resource`, 'Disclosed resources must be a key/text map');
  const text = Object.hasOwn(resources, envelope.resource.key) ? resources[envelope.resource.key] : undefined;
  if (typeof text !== 'string')
    refuseEnvelope(
      'DESC-RESOURCE-UNDISCLOSED',
      `${section}.resource`,
      'The envelope resource was not disclosed to this compilation',
    );
  const decoded = parseResource(text);
  if (decoded.digest !== envelope.resource.digest)
    refuse('DESC-DIGEST-MISMATCH', `${section}.digest`, 'Canonical resource digest differs from the envelope digest');
  return decoded;
}

/** Public codec entry: strict parse and canonical digest of resource text, without envelope binding. */
export function decodeDescriptorResource(text: string): DescriptorResult<DecodedResource> {
  return attempt({ owner: '', source: '' }, () => parseResource(text));
}
