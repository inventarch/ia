import {
  attempt,
  choice,
  contractRef,
  deepFreeze,
  digestOf,
  exactVersion,
  features,
  flag,
  id,
  integer,
  list,
  record,
  refuse,
  unique,
  versioned,
} from './codec.js';
import type { DescriptorResult, Scope } from './codec.js';
import { bindResource, readInput, resolveEnvelope, scopeOf, snapshotEnvelope, snapshotResources } from './envelope.js';
import type { DescriptorEnvelope, DisclosedResources } from './envelope.js';
import { requireRegistry, resolveContract } from './registry.js';
import type { DescriptorRegistry } from './registry.js';

export type ScalarType =
  | { readonly scalar: 'string'; readonly maxLength: number }
  | { readonly scalar: 'boolean' }
  | { readonly scalar: 'number'; readonly minimum: number; readonly maximum: number }
  | { readonly scalar: 'decimal'; readonly precision: number; readonly scale: number }
  | { readonly scalar: 'timestamp' }
  | { readonly scalar: 'enum'; readonly values: readonly string[] };
/** Cross-resource IDs qualify their model and version (DESC-02). */
export interface ModelEntityRef {
  readonly model: string;
  readonly entity: string;
  readonly version: string;
}
export type FieldType =
  | ScalarType
  | { readonly value: string }
  | { readonly reference: ModelEntityRef; readonly cardinality: 'one' | 'many' };
export interface DomainField {
  readonly name: string;
  readonly required: boolean;
  readonly type: FieldType;
}
export type IdCodec = 'uuid' | 'text' | 'integer';
export interface DomainEntity {
  readonly key: string;
  readonly id: { readonly field: string; readonly codec: IdCodec };
  readonly fields: readonly DomainField[];
}
export interface BoundOperation {
  readonly name: string;
  readonly contract: string;
  readonly implementation: string;
  readonly input: string;
  readonly output: string;
  readonly error: string;
}
export interface BoundInvariant {
  readonly name: string;
  readonly validator: string;
  readonly entity: string;
  readonly required: boolean;
  readonly status: 'bound' | 'unavailable';
  readonly implementation?: string;
}
/** A reference into another model: an explicit resource-level mapping, never a native graph edge. */
export interface ExternalReference {
  readonly entity: string;
  readonly field: string;
  readonly target: ModelEntityRef;
  readonly cardinality: 'one' | 'many';
}
export interface DefinitionDigests {
  readonly input: string;
  readonly resource: string;
  readonly registry: string;
  readonly definition: string;
}
export interface CompiledDomainModel {
  readonly format: 1;
  readonly kind: 'domain-model';
  readonly owner: string;
  readonly source: string;
  readonly resource: { readonly key: string; readonly digest: string };
  readonly model: string;
  readonly version: string;
  readonly values: readonly { readonly name: string; readonly type: ScalarType }[];
  readonly entities: readonly DomainEntity[];
  readonly commands: readonly BoundOperation[];
  readonly queries: readonly BoundOperation[];
  readonly invariants: readonly BoundInvariant[];
  readonly references: readonly ExternalReference[];
  /** Structural compilation and business-invariant evaluation are separate results (DOM-01). */
  readonly evaluation: { readonly structural: 'compiled'; readonly invariants: 'not-evaluated' };
  readonly digests: DefinitionDigests;
}
export interface DomainInput {
  readonly envelope: DescriptorEnvelope;
  readonly resources: DisclosedResources;
  readonly registry: DescriptorRegistry;
}

const compiled = new WeakSet<object>();
export const isCompiledDomainModel = (value: unknown): value is CompiledDomainModel =>
  value !== null && typeof value === 'object' && compiled.has(value);

/** Pure semantic compiler for one domain-model envelope and its disclosed resource. No I/O, DDL or code execution. */
export function compileDomainModel(input: DomainInput): DescriptorResult<CompiledDomainModel> {
  let scope: Scope = { owner: '', source: '' };
  return attempt(
    () => scope,
    () => {
      const given = readInput(input, ['envelope', 'resources', 'registry']),
        shot = snapshotEnvelope(given['envelope']);
      scope = scopeOf(shot);
      const envelope = resolveEnvelope(shot as DescriptorEnvelope, 'domain-model');
      const registry = requireRegistry(given['registry']);
      scope = { owner: envelope.owner, source: envelope.source, resource: envelope.resource.key };
      const decoded = bindResource(envelope, snapshotResources(given['resources']));
      const row = versioned(decoded.value, [
        'format',
        'model',
        'version',
        'features',
        'values',
        'entities',
        'commands',
        'queries',
        'invariants',
      ]);
      const model = id(row['model'], 'model'),
        version = exactVersion(row['version'], 'version');
      features(row['features'], 'features');
      if (model !== envelope.name)
        refuse('DESC-ENVELOPE-MISMATCH', 'model', 'Resource model differs from the owning record name');
      if (version !== envelope.fields['version'])
        refuse('DESC-ENVELOPE-MISMATCH', 'model.version', 'Envelope version differs from the resource version');
      const values = unique(
        list(row['values'], 'values').map((entry, index) => {
          const path = `values[${index}]`,
            value = record(entry, path, ['name', 'type']);
          return { name: id(value['name'], `${path}.name`), type: scalar(value['type'], `${path}.type`) };
        }),
        'values',
        (value) => value.name,
      );
      const entities = unique(
        list(row['entities'], 'entities', 1).map((entry, index) =>
          entity(
            entry,
            `entities[${index}]`,
            values.map((value) => value.name),
          ),
        ),
        'entities',
        (item) => item.key,
        'key',
      );
      const references: ExternalReference[] = [];
      entities.forEach((item, index) => {
        item.fields.forEach((field, at) => {
          if (!('reference' in field.type)) return;
          const target = field.type.reference,
            path = `entities[${index}].fields[${at}].type.reference`;
          if (target.model === model) {
            if (target.version !== version || !entities.some((candidate) => candidate.key === target.entity))
              refuse(
                'DESC-REFERENCE-UNRESOLVED',
                path,
                'Same-model reference must name an entity of this model version',
              );
          } else references.push({ entity: item.key, field: field.name, target, cardinality: field.type.cardinality });
        });
      });
      const operations = (key: 'commands' | 'queries', kind: 'command' | 'query'): BoundOperation[] => [
        ...unique(
          list(row[key], key).map((entry, index) => {
            const path = `${key}[${index}]`,
              value = record(entry, path, ['name', 'contract', 'input', 'output', 'error']);
            const name = id(value['name'], `${path}.name`),
              contract = resolveContract(
                registry,
                contractRef(value['contract'], `${path}.contract`),
                kind,
                `${path}.contract`,
              );
            const bound: Record<string, string> = {
              name,
              contract: `${contract.id}@${contract.version}`,
              implementation: contract.implementation,
            };
            for (const schema of ['input', 'output', 'error'] as const) {
              const declared = contractRef(value[schema], `${path}.${schema}`).text;
              if (declared !== contract[schema])
                refuse(
                  'DESC-CONTRACT-SCHEMA',
                  `${path}.${schema}`,
                  `Declared ${schema} schema differs from the trusted contract`,
                );
              bound[schema] = declared;
            }
            return bound as unknown as BoundOperation;
          }),
          key,
          (item) => item.name,
        ),
      ];
      const commands = operations('commands', 'command'),
        queries = operations('queries', 'query');
      const invariants = unique(
        list(row['invariants'], 'invariants').map((entry, index): BoundInvariant => {
          const path = `invariants[${index}]`,
            value = record(entry, path, ['name', 'validator', 'entity', 'required']);
          const name = id(value['name'], `${path}.name`),
            ref = contractRef(value['validator'], `${path}.validator`),
            target = id(value['entity'], `${path}.entity`),
            required = flag(value['required'], `${path}.required`);
          if (!entities.some((item) => item.key === target))
            refuse(
              'DESC-REFERENCE-UNRESOLVED',
              `${path}.entity`,
              'Invariant names an entity this model does not define',
            );
          const available = registry.contracts.find(
            (contract) => contract.id === ref.id && contract.version === ref.version && contract.kind === 'validator',
          );
          if (!available && !required)
            return { name, validator: ref.text, entity: target, required, status: 'unavailable' };
          const contract = resolveContract(registry, ref, 'validator', `${path}.validator`);
          return {
            name,
            validator: ref.text,
            entity: target,
            required,
            status: 'bound',
            implementation: contract.implementation,
          };
        }),
        'invariants',
        (item) => item.name,
      );
      const body = {
        format: 1 as const,
        kind: 'domain-model' as const,
        owner: envelope.owner,
        source: envelope.source,
        resource: envelope.resource,
        model,
        version,
        values,
        entities,
        commands,
        queries,
        invariants,
        references,
        evaluation: { structural: 'compiled' as const, invariants: 'not-evaluated' as const },
      };
      const result = deepFreeze({
        ...body,
        digests: {
          input: envelope.digest,
          resource: decoded.digest,
          registry: registry.digest,
          definition: digestOf({ ...body, registry: registry.digest }),
        },
      });
      compiled.add(result);
      return result;
    },
  );
}

function scalar(value: unknown, path: string): ScalarType {
  const kind = choice(
    record(value, path, ['scalar'], ['max-length', 'minimum', 'maximum', 'precision', 'scale', 'values'])['scalar'],
    `${path}.scalar`,
    ['string', 'boolean', 'number', 'decimal', 'timestamp', 'enum'] as const,
  );
  switch (kind) {
    case 'string': {
      const row = record(value, path, ['scalar', 'max-length']);
      return { scalar: kind, maxLength: integer(row['max-length'], `${path}.max-length`, 1, 1_048_576) };
    }
    case 'number': {
      const row = record(value, path, ['scalar', 'minimum', 'maximum']),
        minimum = integer(row['minimum'], `${path}.minimum`),
        maximum = integer(row['maximum'], `${path}.maximum`);
      if (minimum > maximum) refuse('DESC-FIELD-INVALID', `${path}.maximum`, 'Number bounds are inverted');
      return { scalar: kind, minimum, maximum };
    }
    case 'decimal': {
      const row = record(value, path, ['scalar', 'precision', 'scale']),
        precision = integer(row['precision'], `${path}.precision`, 1, 38);
      return { scalar: kind, precision, scale: integer(row['scale'], `${path}.scale`, 0, precision) };
    }
    case 'enum': {
      const row = record(value, path, ['scalar', 'values']);
      return {
        scalar: kind,
        values: [
          ...unique(
            list(row['values'], `${path}.values`, 1).map((item, index) => id(item, `${path}.values[${index}]`)),
            `${path}.values`,
            (item) => item,
            '',
          ),
        ],
      };
    }
    default:
      record(value, path, ['scalar']);
      return { scalar: kind };
  }
}
function fieldType(value: unknown, path: string, valueNames: readonly string[]): FieldType {
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'reference')) {
    const row = record(value, path, ['reference', 'cardinality']),
      target = record(row['reference'], `${path}.reference`, ['model', 'entity', 'version']);
    return {
      reference: {
        model: id(target['model'], `${path}.reference.model`),
        entity: id(target['entity'], `${path}.reference.entity`),
        version: exactVersion(target['version'], `${path}.reference.version`),
      },
      cardinality: choice(row['cardinality'], `${path}.cardinality`, ['one', 'many'] as const),
    };
  }
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'value')) {
    const name = id(record(value, path, ['value'])['value'], `${path}.value`);
    if (!valueNames.includes(name))
      refuse('DESC-REFERENCE-UNRESOLVED', `${path}.value`, 'Field names an undefined value type');
    return { value: name };
  }
  return scalar(value, path);
}
function entity(value: unknown, path: string, valueNames: readonly string[]): DomainEntity {
  const row = record(value, path, ['key', 'id', 'fields']),
    key = id(row['key'], `${path}.key`);
  const fields = unique(
    list(row['fields'], `${path}.fields`, 1).map((entry, index) => {
      const at = `${path}.fields[${index}]`,
        field = record(entry, at, ['name', 'required', 'type']);
      return {
        name: id(field['name'], `${at}.name`),
        required: flag(field['required'], `${at}.required`),
        type: fieldType(field['type'], `${at}.type`, valueNames),
      };
    }),
    `${path}.fields`,
    (field) => field.name,
  );
  const identity = record(row['id'], `${path}.id`, ['field', 'codec']),
    idField = id(identity['field'], `${path}.id.field`),
    codec = choice(identity['codec'], `${path}.id.codec`, ['uuid', 'text', 'integer'] as const);
  const target = fields.find((field) => field.name === idField);
  const compatible =
    target?.required === true &&
    'scalar' in target.type &&
    (codec === 'integer' ? target.type.scalar === 'number' : target.type.scalar === 'string');
  if (!compatible)
    refuse(
      'DESC-FIELD-INVALID',
      `${path}.id.field`,
      'Identifier must be a required field whose scalar matches the ID codec',
    );
  return { key, id: { field: idField, codec }, fields };
}
export type ChangeKind =
  | 'entity-added'
  | 'entity-removed'
  | 'field-added'
  | 'field-removed'
  | 'requiredness-tightened'
  | 'requiredness-relaxed'
  | 'identifier-changed'
  | 'enum-widened'
  | 'enum-narrowed'
  | 'type-changed'
  | 'command-added'
  | 'command-removed'
  | 'command-changed'
  | 'query-added'
  | 'query-removed'
  | 'query-changed'
  | 'invariant-added'
  | 'invariant-removed'
  | 'invariant-changed';
export interface ModelChange {
  readonly subject: 'entity' | 'command' | 'query' | 'invariant';
  readonly name: string;
  readonly field?: string;
  readonly change: ChangeKind;
  readonly compatibility: 'compatible' | 'breaking';
}
export interface ModelChangeReport {
  readonly model: string;
  readonly from: { readonly version: string; readonly digest: string };
  readonly to: { readonly version: string; readonly digest: string };
  readonly changes: readonly ModelChange[];
  readonly compatibility: 'identical' | 'compatible' | 'breaking';
}
/**
 * DOM-02: classify the change between two compiled versions of one model against its consumers. Field types are
 * compared after resolving named value types. Tightening, removal and reinterpretation are breaking; so is any
 * change to a command, query or invariant contract, and adding a required invariant. This pure report never proves
 * a migration or rewrites values.
 */
export function classifyModelChange(previous: CompiledDomainModel, next: CompiledDomainModel): ModelChangeReport {
  if (!isCompiledDomainModel(previous) || !isCompiledDomainModel(next))
    throw new TypeError('Classify only compiled domain models');
  if (previous.model !== next.model) throw new TypeError('Cannot classify different models');
  const changes: ModelChange[] = [];
  const push = (
    subject: ModelChange['subject'],
    name: string,
    change: ChangeKind,
    compatibility: ModelChange['compatibility'],
    field?: string,
  ): void => {
    changes.push({ subject, name, ...(field === undefined ? {} : { field }), change, compatibility });
  };
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
        : item,
    );
  /** Resolve named value types and ignore the self-reference version, which changes with every model version. */
  const resolved = (type: FieldType, model: CompiledDomainModel): FieldType => {
    if ('value' in type) return model.values.find((value) => value.name === type.value)?.type ?? type;
    if ('reference' in type && type.reference.model === model.model)
      return { ...type, reference: { ...type.reference, version: '' } };
    return type;
  };
  for (const before of previous.entities) {
    const after = next.entities.find((item) => item.key === before.key);
    if (!after) {
      push('entity', before.key, 'entity-removed', 'breaking');
      continue;
    }
    if (before.id.field !== after.id.field || before.id.codec !== after.id.codec)
      push('entity', before.key, 'identifier-changed', 'breaking');
    for (const field of before.fields) {
      const now = after.fields.find((item) => item.name === field.name);
      if (!now) {
        push('entity', before.key, 'field-removed', 'breaking', field.name);
        continue;
      }
      if (!field.required && now.required) push('entity', before.key, 'requiredness-tightened', 'breaking', field.name);
      if (field.required && !now.required) push('entity', before.key, 'requiredness-relaxed', 'compatible', field.name);
      const a = resolved(field.type, previous),
        b = resolved(now.type, next);
      if (stable(a) === stable(b)) continue;
      if ('scalar' in a && 'scalar' in b && a.scalar === 'enum' && b.scalar === 'enum') {
        const removed = a.values.some((item) => !b.values.includes(item));
        push(
          'entity',
          before.key,
          removed ? 'enum-narrowed' : 'enum-widened',
          removed ? 'breaking' : 'compatible',
          field.name,
        );
      } else push('entity', before.key, 'type-changed', 'breaking', field.name);
    }
    for (const field of after.fields)
      if (!before.fields.some((item) => item.name === field.name))
        push('entity', before.key, 'field-added', field.required ? 'breaking' : 'compatible', field.name);
  }
  for (const after of next.entities)
    if (!previous.entities.some((item) => item.key === after.key))
      push('entity', after.key, 'entity-added', 'compatible');
  const contracts = (
    subject: 'command' | 'query',
    from: readonly BoundOperation[],
    to: readonly BoundOperation[],
  ): void => {
    for (const item of from) {
      const now = to.find((candidate) => candidate.name === item.name);
      if (!now) push(subject, item.name, `${subject}-removed`, 'breaking');
      else if (stable({ ...item, implementation: '' }) !== stable({ ...now, implementation: '' }))
        push(subject, item.name, `${subject}-changed`, 'breaking');
    }
    for (const item of to)
      if (!from.some((candidate) => candidate.name === item.name))
        push(subject, item.name, `${subject}-added`, 'compatible');
  };
  contracts('command', previous.commands, next.commands);
  contracts('query', previous.queries, next.queries);
  const rule = (item: BoundInvariant): string =>
    stable({ validator: item.validator, entity: item.entity, required: item.required });
  for (const item of previous.invariants) {
    const now = next.invariants.find((candidate) => candidate.name === item.name);
    if (!now) push('invariant', item.name, 'invariant-removed', 'breaking');
    else if (rule(item) !== rule(now)) push('invariant', item.name, 'invariant-changed', 'breaking');
  }
  for (const item of next.invariants)
    if (!previous.invariants.some((candidate) => candidate.name === item.name))
      push('invariant', item.name, 'invariant-added', item.required ? 'breaking' : 'compatible');
  const identical = previous.resource.digest === next.resource.digest;
  return deepFreeze({
    model: previous.model,
    from: { version: previous.version, digest: previous.resource.digest },
    to: { version: next.version, digest: next.resource.digest },
    changes,
    compatibility: identical
      ? 'identical'
      : changes.some((change) => change.compatibility === 'breaking')
        ? 'breaking'
        : 'compatible',
  });
}
