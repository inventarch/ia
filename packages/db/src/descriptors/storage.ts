import {
  attempt,
  choice,
  contractRef,
  deepFreeze,
  digest,
  digestOf,
  exactVersion,
  id,
  list,
  record,
  refuse,
  storageId,
  unique,
  versioned,
} from './codec.js';
import type { DescriptorResult, Scope } from './codec.js';
import { isCompiledDomainModel } from './domain.js';
import type { CompiledDomainModel, DefinitionDigests, FieldType } from './domain.js';
import { bindResource, readInput, resolveEnvelope, scopeOf, snapshotEnvelope, snapshotResources } from './envelope.js';
import type { DescriptorEnvelope, DisclosedResources } from './envelope.js';
import { requireRegistry, resolveContract } from './registry.js';
import type { DescriptorRegistry, TransactionBoundary } from './registry.js';

export type StorageCodec = 'uuid' | 'text' | 'integer' | 'numeric' | 'boolean' | 'timestamp' | 'reference';
export interface FieldMapping {
  readonly field: string;
  readonly column: string;
  readonly codec: StorageCodec;
}
export interface EntityMapping {
  readonly entity: string;
  readonly store: string;
  readonly fields: readonly FieldMapping[];
}
export interface CompiledStorageBinding {
  readonly format: 1;
  readonly kind: 'storage-binding';
  readonly owner: string;
  readonly source: string;
  readonly resource: { readonly key: string; readonly digest: string };
  /** The exact model this binding was compiled against: a different version or digest is skew. */
  readonly model: { readonly id: string; readonly version: string; readonly digest: string; readonly owner: string };
  readonly port: string;
  readonly adapter: string;
  readonly adapterImplementation: string;
  readonly schemaVersion: string;
  readonly transaction: TransactionBoundary;
  /** The storage column that carries the host-supplied isolation key; tenant values come from the API at each operation. */
  readonly isolation: { readonly column: string };
  readonly entities: readonly EntityMapping[];
  readonly projections: readonly {
    readonly name: string;
    readonly classification: 'authoritative' | 'derived' | 'cache';
  }[];
  readonly migrationPolicy: string;
  readonly digests: DefinitionDigests;
}
export interface StorageInput {
  readonly envelope: DescriptorEnvelope;
  readonly resources: DisclosedResources;
  readonly registry: DescriptorRegistry;
  readonly model: CompiledDomainModel;
}

/**
 * Pure mapping compiler. It validates the binding against the exact compiled model and the trusted port/adapter
 * contracts; it opens no connection, emits or runs no DDL and proposes no migration (OS09 STORE-01/02 hosts do).
 */
export function compileStorageBinding(input: StorageInput): DescriptorResult<CompiledStorageBinding> {
  let scope: Scope = { owner: '', source: '' };
  return attempt(
    () => scope,
    () => {
      const given = readInput(input, ['envelope', 'resources', 'registry', 'model']),
        shot = snapshotEnvelope(given['envelope']);
      scope = scopeOf(shot);
      const envelope = resolveEnvelope(shot as DescriptorEnvelope, 'storage-binding');
      const registry = requireRegistry(given['registry']);
      if (!isCompiledDomainModel(given['model']))
        refuse('DESC-SKEW', 'storage.model', 'Compile against a model returned by compileDomainModel');
      const model = given['model'],
        fields = envelope.fields;
      if (fields['model'] !== `@domain-model ${model.model}` || fields['model-version'] !== model.version)
        refuse('DESC-SKEW', 'storage.model', 'Envelope model ref or version differs from the supplied compiled model');
      scope = { owner: envelope.owner, source: envelope.source, resource: envelope.resource.key };
      const decoded = bindResource(envelope, snapshotResources(given['resources']));
      const row = versioned(decoded.value, [
        'format',
        'model',
        'model-version',
        'model-digest',
        'port',
        'adapter',
        'schema-version',
        'transaction',
        'isolation',
        'entities',
        'projections',
        'migration-policy',
      ]);
      if (id(row['model'], 'model') !== model.model)
        refuse('DESC-SKEW', 'model', 'Resource model differs from the compiled model');
      if (exactVersion(row['model-version'], 'model-version') !== model.version)
        refuse('DESC-SKEW', 'model-version', 'Resource model version differs from the compiled model');
      if (digest(row['model-digest'], 'model-digest') !== model.resource.digest)
        refuse('DESC-SKEW', 'model-digest', 'Binding was written for a different model resource');
      const portRef = contractRef(row['port'], 'port'),
        adapterRef = contractRef(row['adapter'], 'adapter');
      if (portRef.id !== fields['port'])
        refuse('DESC-ENVELOPE-MISMATCH', 'port', 'Resource port differs from the envelope port');
      if (adapterRef.id !== fields['adapter'])
        refuse('DESC-ENVELOPE-MISMATCH', 'adapter', 'Resource adapter differs from the envelope adapter');
      const port = resolveContract(registry, portRef, 'port', 'port'),
        adapter = resolveContract(registry, adapterRef, 'adapter', 'adapter');
      if (adapter.port !== `${port.id}@${port.version}`)
        refuse('DESC-STORAGE-UNSUPPORTED', 'adapter', 'Adapter does not implement this repository port version');
      const schemaVersion = exactVersion(row['schema-version'], 'schema-version');
      if (schemaVersion !== fields['schema-version'])
        refuse(
          'DESC-ENVELOPE-MISMATCH',
          'storage.schema-version',
          'Envelope storage schema version differs from the resource',
        );
      const transaction = choice(row['transaction'], 'transaction', ['entity', 'model'] as const);
      if (!adapter.transactions?.includes(transaction))
        refuse('DESC-STORAGE-UNSUPPORTED', 'transaction', 'Adapter does not guarantee this transaction boundary');
      const isolation = {
        column: storageId(record(row['isolation'], 'isolation', ['column'])['column'], 'isolation.column'),
      };
      if (adapter.isolation !== true)
        refuse('DESC-STORAGE-UNSUPPORTED', 'isolation', 'Adapter cannot enforce the required isolation key');
      const entities = unique(
        list(row['entities'], 'entities', 1).map((entry, index): EntityMapping => {
          const path = `entities[${index}]`,
            value = record(entry, path, ['entity', 'store', 'fields']),
            key = id(value['entity'], `${path}.entity`);
          const target = model.entities.find((item) => item.key === key);
          if (!target) refuse('DESC-MAPPING', `${path}.entity`, 'Mapped entity is not defined by the model');
          const mapped = unique(
            list(value['fields'], `${path}.fields`, 1).map((item, at): FieldMapping => {
              const where = `${path}.fields[${at}]`,
                mapping = record(item, where, ['field', 'column', 'codec']),
                name = id(mapping['field'], `${where}.field`);
              const field = target.fields.find((candidate) => candidate.name === name);
              if (!field) refuse('DESC-MAPPING', `${where}.field`, 'Mapped field is not defined by the entity');
              const codec = choice(mapping['codec'], `${where}.codec`, [
                'uuid',
                'text',
                'integer',
                'numeric',
                'boolean',
                'timestamp',
                'reference',
              ] as const);
              const identifier = target.id.field === name ? target.id.codec : undefined;
              if (!compatible(field.type, codec, identifier, model))
                refuse('DESC-MAPPING', `${where}.codec`, 'Storage codec is incompatible with the field type');
              return { field: name, column: storageId(mapping['column'], `${where}.column`), codec };
            }),
            `${path}.fields`,
            (item) => item.field,
            'field',
          );
          unique(mapped, `${path}.fields`, (item) => item.column, 'column');
          if (mapped.some((item) => item.column === isolation.column))
            refuse(
              'DESC-MAPPING',
              `${path}.fields`,
              'The isolation column is host-supplied and cannot map a model field',
            );
          const missing = target.fields.find(
            (field) => field.required && !mapped.some((item) => item.field === field.name),
          );
          if (missing) refuse('DESC-MAPPING', `${path}.fields`, `Required field ${missing.name} is not mapped`);
          return { entity: key, store: storageId(value['store'], `${path}.store`), fields: mapped };
        }),
        'entities',
        (item) => item.entity,
        'entity',
      );
      unique(entities, 'entities', (item) => item.store, 'store');
      // STORE-01: a model entity with required fields must be stored. Every entity's identifier is required, so the
      // binding maps the whole model; required same-model references therefore always point at stored entities.
      const unstored = model.entities.find(
        (item) =>
          item.fields.some((field) => field.required) && !entities.some((mapping) => mapping.entity === item.key),
      );
      if (unstored) refuse('DESC-MAPPING', 'entities', `Entity ${unstored.key} has required fields but no mapping`);
      const projections = unique(
        list(row['projections'], 'projections').map((entry, index) => {
          const path = `projections[${index}]`,
            value = record(entry, path, ['name', 'classification']);
          return {
            name: id(value['name'], `${path}.name`),
            classification: choice(value['classification'], `${path}.classification`, [
              'authoritative',
              'derived',
              'cache',
            ] as const),
          };
        }),
        'projections',
        (item) => item.name,
      );
      const policy = resolveContract(
        registry,
        contractRef(row['migration-policy'], 'migration-policy'),
        'migration-policy',
        'migration-policy',
      );
      const body = {
        format: 1 as const,
        kind: 'storage-binding' as const,
        owner: envelope.owner,
        source: envelope.source,
        resource: envelope.resource,
        model: { id: model.model, version: model.version, digest: model.resource.digest, owner: model.owner },
        port: portRef.text,
        adapter: adapterRef.text,
        adapterImplementation: adapter.implementation,
        schemaVersion,
        transaction,
        isolation,
        entities,
        projections,
        migrationPolicy: `${policy.id}@${policy.version}`,
      };
      return deepFreeze({
        ...body,
        digests: {
          input: envelope.digest,
          resource: decoded.digest,
          registry: registry.digest,
          definition: digestOf({ ...body, registry: registry.digest }),
        },
      });
    },
  );
}

function compatible(
  type: FieldType,
  codec: StorageCodec,
  identifier: 'uuid' | 'text' | 'integer' | undefined,
  model: CompiledDomainModel,
): boolean {
  if (identifier !== undefined) return codec === identifier;
  if ('reference' in type) return codec === 'reference';
  const scalar = 'value' in type ? model.values.find((value) => value.name === type.value)?.type : type;
  if (!scalar) return false;
  const expected: Record<string, readonly StorageCodec[]> = {
    string: ['text'],
    enum: ['text'],
    number: ['integer'],
    decimal: ['numeric'],
    boolean: ['boolean'],
    timestamp: ['timestamp'],
  };
  return expected[scalar.scalar]?.includes(codec) ?? false;
}
