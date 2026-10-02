import {
  attempt,
  choice,
  contractRef,
  deepFreeze,
  digest,
  digestOf,
  flag,
  id,
  integer,
  list,
  record,
  refuse,
  refuseEnvelope,
  snapshot,
  unique,
  versioned,
} from './codec.js';
import type { ContractRef, DescriptorResult } from './codec.js';

export type ContractKind =
  | 'command'
  | 'query'
  | 'validator'
  | 'view'
  | 'operation'
  | 'port'
  | 'adapter'
  | 'migration-policy';
export type EffectClass = 'read' | 'write' | 'external';
export type TransactionBoundary = 'entity' | 'model';
/** One trusted contract: an installed implementation identified by digest. The registry never holds code. */
export interface RegisteredContract {
  readonly kind: ContractKind;
  readonly id: string;
  readonly version: number;
  /** Digest of the installed code the host joined to this contract. */
  readonly implementation: string;
  readonly input?: string;
  readonly output?: string;
  readonly error?: string;
  readonly effect?: EffectClass;
  readonly targets?: readonly string[];
  readonly port?: string;
  readonly transactions?: readonly TransactionBoundary[];
  readonly isolation?: boolean;
}
export interface DescriptorRegistry {
  readonly format: 1;
  readonly targets: readonly string[];
  readonly contracts: readonly RegisteredContract[];
  /** Digest of the canonical registry data; compiled definitions record it. */
  readonly digest: string;
}
const KINDS: readonly ContractKind[] = [
  'command',
  'query',
  'validator',
  'view',
  'operation',
  'port',
  'adapter',
  'migration-policy',
];
const FIELDS: Readonly<Record<ContractKind, readonly string[]>> = {
  command: ['input', 'output', 'error'],
  query: ['input', 'output', 'error', 'targets'],
  validator: [],
  view: ['targets'],
  operation: ['input', 'output', 'effect', 'targets'],
  port: [],
  adapter: ['port', 'transactions', 'isolation'],
  'migration-policy': [],
};
const trusted = new WeakSet<object>();
const scope = { owner: 'registry', source: 'registry' };

/**
 * Build the trusted registry from host-owned data. Only a value returned here is accepted by the compilers;
 * a structurally equal copy is refused. Accessors, functions and non-data values refuse without being invoked.
 */
export function createDescriptorRegistry(data: unknown): DescriptorResult<DescriptorRegistry> {
  return attempt(scope, () => {
    const row = versioned(snapshot(data, 'DESC-REGISTRY-INVALID', ''), ['format', 'targets', 'contracts'], [], false);
    const targets = unique(
      list(row['targets'], 'targets', 1).map((entry, index) => id(entry, `targets[${index}]`)),
      'targets',
      (name) => name,
      '',
    );
    const contracts = list(row['contracts'], 'contracts').map((entry, index): RegisteredContract => {
      const path = `contracts[${index}]`,
        base = record(
          entry,
          path,
          ['kind', 'id', 'version', 'implementation'],
          [...new Set(Object.values(FIELDS).flat())],
        );
      const kind = choice(base['kind'], `${path}.kind`, KINDS),
        allowed = FIELDS[kind];
      const fields = record(base, path, ['kind', 'id', 'version', 'implementation', ...allowed]);
      const contract: Record<string, unknown> = {
        kind,
        id: id(fields['id'], `${path}.id`),
        version: integer(fields['version'], `${path}.version`, 1, 999_999),
        implementation: digest(fields['implementation'], `${path}.implementation`),
      };
      for (const key of ['input', 'output', 'error', 'port'] as const)
        if (allowed.includes(key)) contract[key] = contractRef(fields[key], `${path}.${key}`).text;
      if (allowed.includes('effect'))
        contract['effect'] = choice(fields['effect'], `${path}.effect`, ['read', 'write', 'external'] as const);
      if (allowed.includes('targets'))
        contract['targets'] = unique(
          list(fields['targets'], `${path}.targets`, 1).map((target, at) => {
            const name = id(target, `${path}.targets[${at}]`);
            if (!targets.includes(name))
              refuse(
                'DESC-TARGET-UNSUPPORTED',
                `${path}.targets[${at}]`,
                'Contract names a target profile the registry does not declare',
              );
            return name;
          }),
          `${path}.targets`,
          (name) => name,
          '',
        );
      if (allowed.includes('transactions'))
        contract['transactions'] = unique(
          list(fields['transactions'], `${path}.transactions`, 1).map((value, at) =>
            choice(value, `${path}.transactions[${at}]`, ['entity', 'model'] as const),
          ),
          `${path}.transactions`,
          (name) => name,
          '',
        );
      if (allowed.includes('isolation')) contract['isolation'] = flag(fields['isolation'], `${path}.isolation`);
      return contract as unknown as RegisteredContract;
    });
    unique(contracts, 'contracts', (contract) => `${contract.kind}:${contract.id}@${contract.version}`, '');
    const value = { format: 1 as const, targets, contracts };
    const registry = deepFreeze({ ...value, digest: digestOf(value) });
    trusted.add(registry);
    return registry;
  });
}
export function isTrustedRegistry(registry: unknown): registry is DescriptorRegistry {
  return registry !== null && typeof registry === 'object' && trusted.has(registry);
}
export function requireRegistry(registry: unknown): DescriptorRegistry {
  if (!isTrustedRegistry(registry))
    refuseEnvelope(
      'DESC-REGISTRY-INVALID',
      'registry',
      'Compile only against a registry built by createDescriptorRegistry',
    );
  return registry;
}
/** Resolve a descriptor's contract reference against the trusted registry. */
export function resolveContract(
  registry: DescriptorRegistry,
  ref: ContractRef,
  kind: ContractKind,
  path: string,
): RegisteredContract {
  const same = registry.contracts.filter((contract) => contract.id === ref.id);
  const exact = same.find((contract) => contract.kind === kind && contract.version === ref.version);
  if (exact) return exact;
  if (same.some((contract) => contract.kind === kind))
    refuse('DESC-CONTRACT-VERSION', path, `Trusted ${kind} contract version is not installed`);
  if (same.some((contract) => contract.version === ref.version))
    refuse('DESC-CONTRACT-KIND', path, `Contract is not a ${kind}`);
  refuse('DESC-CONTRACT-UNKNOWN', path, `No trusted ${kind} contract has this id`);
}
