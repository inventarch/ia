import {
  DESCRIPTOR_LIMITS,
  attempt,
  freeText,
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
  makeDiagnostic,
  record,
  refuse,
  refuseEnvelope,
  snapshot,
  unique,
  versioned,
} from './codec.js';
import type { DescriptorDiagnostic, DescriptorResult, Scope } from './codec.js';
import type { DefinitionDigests } from './domain.js';
import { bindResource, readInput, resolveEnvelope, scopeOf, snapshotEnvelope, snapshotResources } from './envelope.js';
import type { DescriptorEnvelope, DisclosedResources } from './envelope.js';
import { requireRegistry, resolveContract } from './registry.js';
import type { DescriptorRegistry, EffectClass } from './registry.js';

export type LayoutValue = number | boolean | string;
export interface ContractBinding {
  readonly contract: string;
  readonly implementation: string;
}
export interface CompiledScreen {
  readonly name: string;
  readonly title?: string;
  readonly view: ContractBinding;
  readonly layout: Readonly<Record<string, LayoutValue>>;
  readonly queries: readonly ContractBinding[];
  readonly actions: readonly string[];
}
export interface CompiledAction {
  readonly name: string;
  readonly capability: string;
  readonly operation: ContractBinding;
  readonly input: string;
  readonly output: string;
  readonly effect: EffectClass;
}
export type ConfigurationValue = number | boolean | string;
/** Secret entries are references only: they never carry a value. */
export interface CompiledConfiguration {
  readonly key: string;
  readonly visibility: 'public' | 'server';
  readonly secret: boolean;
  readonly default?: ConfigurationValue;
}
export interface TargetSupport {
  readonly profile: string;
  readonly status: 'supported' | 'unsupported';
  readonly diagnostics: readonly DescriptorDiagnostic[];
}
export interface CompiledAppComposition {
  readonly format: 1;
  readonly kind: 'app-composition';
  readonly owner: string;
  readonly source: string;
  readonly resource: { readonly key: string; readonly digest: string };
  readonly app: string;
  readonly version: string;
  /** Required capabilities from the native envelope refs; rendering never grants them. */
  readonly capabilities: readonly string[];
  readonly targets: readonly TargetSupport[];
  readonly screens: readonly CompiledScreen[];
  readonly navigation: readonly { readonly from: string; readonly to: string }[];
  readonly actions: readonly CompiledAction[];
  readonly configuration: readonly CompiledConfiguration[];
  /** Only keys the host explicitly allowlisted; server and secret keys never appear here. */
  readonly publicConfiguration: readonly { readonly key: string; readonly default?: ConfigurationValue }[];
  readonly requirements: readonly {
    readonly name: string;
    readonly kind: 'domain-model' | 'storage-binding';
    readonly id: string;
    readonly version: string;
  }[];
  readonly digests: DefinitionDigests;
}
export interface AppInput {
  readonly envelope: DescriptorEnvelope;
  readonly resources: DisclosedResources;
  readonly registry: DescriptorRegistry;
  /** Host allowlist of configuration keys that may enter a public/browser projection (APPD-02). */
  readonly publicConfiguration?: readonly string[];
}

const compiled = new WeakSet<object>();

/** Pure app compiler: joins view/operation IDs to trusted installed contracts; creates no context and renders nothing. */
export function compileAppComposition(input: AppInput): DescriptorResult<CompiledAppComposition> {
  let scope: Scope = { owner: '', source: '' };
  return attempt(
    () => scope,
    () => {
      const given = readInput(input, ['envelope', 'resources', 'registry', 'publicConfiguration']),
        shot = snapshotEnvelope(given['envelope']);
      scope = scopeOf(shot);
      const envelope = resolveEnvelope(shot as DescriptorEnvelope, 'app-composition');
      const registry = requireRegistry(given['registry']);
      scope = { owner: envelope.owner, source: envelope.source, resource: envelope.resource.key };
      const decoded = bindResource(envelope, snapshotResources(given['resources']));
      const row = versioned(decoded.value, [
        'format',
        'app',
        'version',
        'features',
        'targets',
        'screens',
        'navigation',
        'actions',
        'configuration',
        'requirements',
      ]);
      const app = id(row['app'], 'app'),
        version = exactVersion(row['version'], 'version');
      features(row['features'], 'features');
      if (app !== envelope.fields['app-id'] || app !== envelope.name)
        refuse('DESC-ENVELOPE-MISMATCH', 'app', 'Resource app differs from the envelope app-id');
      if (version !== envelope.fields['version'])
        refuse('DESC-ENVELOPE-MISMATCH', 'app.version', 'Envelope version differs from the resource version');
      const capabilities = (envelope.fields['capabilities'] as readonly string[]).map((ref) =>
        ref.slice('@capability '.length),
      );
      const targets = unique(
        list(row['targets'], 'targets', 1).map((entry, index) => id(entry, `targets[${index}]`)),
        'targets',
        (name) => name,
        '',
      );
      const actions = unique(
        list(row['actions'], 'actions').map((entry, index): CompiledAction => {
          const path = `actions[${index}]`,
            value = record(entry, path, ['name', 'capability', 'operation', 'input', 'output', 'effect']);
          const name = id(value['name'], `${path}.name`),
            capability = id(value['capability'], `${path}.capability`);
          if (!capabilities.includes(capability))
            refuse(
              'DESC-CAPABILITY-UNDECLARED',
              `${path}.capability`,
              'Action capability is not required by the app envelope',
            );
          const operation = resolveContract(
            registry,
            contractRef(value['operation'], `${path}.operation`),
            'operation',
            `${path}.operation`,
          );
          const declared = {
            input: contractRef(value['input'], `${path}.input`).text,
            output: contractRef(value['output'], `${path}.output`).text,
            effect: choice(value['effect'], `${path}.effect`, ['read', 'write', 'external'] as const),
          };
          for (const key of ['input', 'output', 'effect'] as const)
            if (declared[key] !== operation[key])
              refuse('DESC-CONTRACT-SCHEMA', `${path}.${key}`, `Declared ${key} differs from the trusted operation`);
          return {
            name,
            capability,
            operation: { contract: `${operation.id}@${operation.version}`, implementation: operation.implementation },
            ...declared,
          };
        }),
        'actions',
        (item) => item.name,
      );
      const screens = unique(
        list(row['screens'], 'screens', 1).map((entry, index): CompiledScreen => {
          const path = `screens[${index}]`,
            value = record(entry, path, ['name', 'view', 'layout', 'queries', 'actions'], ['title']);
          const view = resolveContract(registry, contractRef(value['view'], `${path}.view`), 'view', `${path}.view`);
          const queries = list(value['queries'], `${path}.queries`).map((item, at) => {
            const query = resolveContract(
              registry,
              contractRef(item, `${path}.queries[${at}]`),
              'query',
              `${path}.queries[${at}]`,
            );
            return { contract: `${query.id}@${query.version}`, implementation: query.implementation };
          });
          const named = unique(
            list(value['actions'], `${path}.actions`).map((item, at) => {
              const action = id(item, `${path}.actions[${at}]`);
              if (!actions.some((candidate) => candidate.name === action))
                refuse('DESC-REFERENCE-UNRESOLVED', `${path}.actions[${at}]`, 'Screen names an undefined action');
              return action;
            }),
            `${path}.actions`,
            (item) => item,
            '',
          );
          return {
            name: id(value['name'], `${path}.name`),
            ...(value['title'] === undefined ? {} : { title: freeText(value['title'], `${path}.title`) }),
            view: { contract: `${view.id}@${view.version}`, implementation: view.implementation },
            layout: layout(value['layout'], `${path}.layout`),
            queries,
            actions: [...named],
          };
        }),
        'screens',
        (item) => item.name,
      );
      const navigation = list(row['navigation'], 'navigation').map((entry, index) => {
        const path = `navigation[${index}]`,
          value = record(entry, path, ['from', 'to']),
          from = id(value['from'], `${path}.from`),
          to = id(value['to'], `${path}.to`);
        for (const [key, name] of [
          ['from', from],
          ['to', to],
        ] as const)
          if (!screens.some((screen) => screen.name === name))
            refuse('DESC-REFERENCE-UNRESOLVED', `${path}.${key}`, 'Navigation names an undefined screen');
        return { from, to };
      });
      unique(navigation, 'navigation', (item) => `${item.from}>${item.to}`, '');
      const configuration = unique(
        list(row['configuration'], 'configuration').map((entry, index): CompiledConfiguration => {
          const path = `configuration[${index}]`,
            value = record(entry, path, ['key', 'visibility', 'secret'], ['default']);
          const key = id(value['key'], `${path}.key`),
            visibility = choice(value['visibility'], `${path}.visibility`, ['public', 'server'] as const),
            secret = flag(value['secret'], `${path}.secret`);
          if (secret && value['default'] !== undefined)
            refuse(
              'DESC-SECRET-REFUSED',
              `${path}.default`,
              'A secret setting is a reference; its value never enters a descriptor',
            );
          if (secret && visibility === 'public')
            refuse('DESC-SECRET-REFUSED', `${path}.visibility`, 'A secret setting cannot be public');
          return {
            key,
            visibility,
            secret,
            ...(value['default'] === undefined
              ? {}
              : { default: configurationValue(value['default'], `${path}.default`) }),
          };
        }),
        'configuration',
        (item) => item.key,
        'key',
      );
      const requirements = unique(
        list(row['requirements'], 'requirements').map((entry, index) => {
          const path = `requirements[${index}]`,
            value = record(entry, path, ['name', 'kind', 'id', 'version']);
          return {
            name: id(value['name'], `${path}.name`),
            kind: choice(value['kind'], `${path}.kind`, ['domain-model', 'storage-binding'] as const),
            id: id(value['id'], `${path}.id`),
            version: exactVersion(value['version'], `${path}.version`),
          };
        }),
        'requirements',
        (item) => item.name,
      );
      const publicConfiguration = allowlisted(
        given['publicConfiguration'] === undefined
          ? undefined
          : (snapshot(given['publicConfiguration'], 'DESC-FIELD-INVALID', 'publicConfiguration', {
              depth: 1,
              nodes: 1_001,
            }) as readonly string[]),
        configuration,
      );
      const support = targets.map((profile, index): TargetSupport => {
        const diagnostics: DescriptorDiagnostic[] = [];
        const miss = (field: string, message: string): void => {
          diagnostics.push(
            makeDiagnostic(
              { owner: envelope.owner, source: envelope.source, resource: envelope.resource.key },
              'DESC-TARGET-UNSUPPORTED',
              field,
              message,
            ),
          );
        };
        if (!registry.targets.includes(profile))
          miss(`targets[${index}]`, 'The trusted registry declares no such target profile');
        else {
          const supports = (contract: string, kind: 'view' | 'query' | 'operation'): boolean =>
            registry.contracts
              .find((item) => item.kind === kind && `${item.id}@${item.version}` === contract)
              ?.targets?.includes(profile) ?? false;
          screens.forEach((screen, at) => {
            if (!supports(screen.view.contract, 'view'))
              miss(`screens[${at}].view`, 'View is not installed for this target profile');
            screen.queries.forEach((query, index) => {
              if (!supports(query.contract, 'query'))
                miss(`screens[${at}].queries[${index}]`, 'Query is not installed for this target profile');
            });
          });
          actions.forEach((action, at) => {
            if (!supports(action.operation.contract, 'operation'))
              miss(`actions[${at}].operation`, 'Operation is not installed for this target profile');
          });
        }
        return { profile, status: diagnostics.length ? 'unsupported' : 'supported', diagnostics };
      });
      const body = {
        format: 1 as const,
        kind: 'app-composition' as const,
        owner: envelope.owner,
        source: envelope.source,
        resource: envelope.resource,
        app,
        version,
        capabilities,
        targets: support,
        screens,
        navigation,
        actions,
        configuration,
        publicConfiguration,
        requirements,
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

/** Activation is refused for an unsupported or undeclared target; inspection of the compiled definition continues. */
export function activateTarget(
  app: CompiledAppComposition,
  target: string,
): DescriptorResult<{
  readonly app: string;
  readonly version: string;
  readonly target: string;
  readonly definition: string;
}> {
  const trusted = app !== null && typeof app === 'object' && compiled.has(app);
  return attempt(
    () => (trusted ? { owner: app.owner, source: app.source } : { owner: '', source: '' }),
    () => {
      if (!trusted)
        refuseEnvelope(
          'DESC-DEFINITION-UNTRUSTED',
          'definition',
          'Activate only a definition returned by compileAppComposition',
        );
      const index = app.targets.findIndex((item) => item.profile === target);
      if (index < 0)
        refuseEnvelope('DESC-TARGET-UNSUPPORTED', 'targets', 'The app does not declare this target profile');
      if (app.targets[index]!.status !== 'supported')
        refuseEnvelope(
          'DESC-TARGET-UNSUPPORTED',
          `targets[${index}]`,
          'The target profile lacks installed views or operations',
        );
      return deepFreeze({ app: app.app, version: app.version, target, definition: app.digests.definition });
    },
  );
}

function layout(value: unknown, path: string): Readonly<Record<string, LayoutValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('DESC-FIELD-INVALID', path, 'Layout must be an object of bounded values');
  const entries = Object.entries(value);
  if (entries.length > DESCRIPTOR_LIMITS.entries)
    refuse('DESC-ENTRIES-EXCEEDED', path, `Collection exceeds ${DESCRIPTOR_LIMITS.entries} entries`);
  return Object.fromEntries(
    entries.map(([key, item]) => [
      id(key, `${path}.${key}`),
      typeof item === 'string'
        ? id(item, `${path}.${key}`)
        : typeof item === 'boolean'
          ? item
          : integer(item, `${path}.${key}`, -1_000_000, 1_000_000),
    ]),
  );
}
function configurationValue(value: unknown, path: string): ConfigurationValue {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return integer(value, path);
  return freeText(value, path, 256);
}
function allowlisted(
  keys: readonly string[] | undefined,
  configuration: readonly CompiledConfiguration[],
): CompiledAppComposition['publicConfiguration'] {
  if (keys === undefined) return [];
  if (!Array.isArray(keys) || keys.length > DESCRIPTOR_LIMITS.entries)
    refuseEnvelope(
      'DESC-FIELD-INVALID',
      'publicConfiguration',
      'Public configuration allowlist must be a bounded list',
    );
  return keys.map((key, index) => {
    const path = `publicConfiguration[${index}]`;
    if (typeof key !== 'string') refuseEnvelope('DESC-FIELD-INVALID', path, 'Allowlist entries are configuration keys');
    if (keys.indexOf(key) !== index) refuseEnvelope('DESC-NAME-DUPLICATE', path, 'Allowlist keys must be unique');
    const entry = configuration.find((item) => item.key === key);
    if (!entry) refuseEnvelope('DESC-REFERENCE-UNRESOLVED', path, 'Allowlisted key is not configured by the app');
    if (entry.secret || entry.visibility !== 'public')
      refuseEnvelope('DESC-SECRET-REFUSED', path, 'Only non-secret public keys can enter a public projection');
    return { key, ...(entry.default === undefined ? {} : { default: entry.default }) };
  });
}
