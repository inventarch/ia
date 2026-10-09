import { createHash } from 'node:crypto';
import { EditorSnapshot } from '@inventarch/db/editor';
import { systemMember } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { CompiledRecord, CompiledValue } from '@inventarch/language';
import { context } from '@inventarch/runtime';
import { canonical, copy, digest } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import { MAX_MODEL_REQUEST_BYTES } from '@inventarch/agent-system';
import type { OutcomeKind } from '@inventarch/agent-system';
import { verifyCapture } from '@inventarch/workspace-runtime/corpus';
import type { Capture } from '@inventarch/workspace-runtime/corpus';
import type {
  CatalogGroup,
  CompositionCatalog,
  EffectClass,
  HostContract,
  Installed,
  ResourceLimits,
} from './catalog.js';
import { CompositionError } from './compiled.js';
import type { Compilation, CompiledCapability, CompiledHarness, CompiledProfile, ComponentPin } from './compiled.js';
import { closedFields, fail, field, LIMIT_KEYS, limits, list, minimum, strings, unique, value } from './fields.js';
import { compatibleInputs } from './inputs.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const effects: EffectClass[] = ['read', 'local-write', 'external-write'];
const outcomeKinds: OutcomeKind[] = [
  'answer',
  'deliverable',
  'clarification',
  'proposal',
  'follow-up',
  'handoff',
  'blocked',
  'refusal',
  'failure',
];
const sort = <T>(values: T[], key: (item: T) => string): T[] =>
  values.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
type CatalogValue<G extends CatalogGroup> = CompositionCatalog[G][string] extends Installed<infer V> ? V : never;
export interface CompileOptions {
  harness: string;
  entry: string;
  catalog: CompositionCatalog;
  /** Service-owned executable definitions may differ from the captured task corpus. */
  definitions?: Capture;
}

class Compiler {
  readonly reader: EditorSnapshot;
  readonly scope: string;
  readonly records: readonly CompiledRecord[];
  readonly components = new Map<string, ComponentPin>();
  readonly sources = new Map<string, string>();
  readonly implementations = new Map<string, { group: string; id: string; digest: string }>();
  readonly provenance: Record<string, string[]> = {};
  readonly capabilities: CompiledHarness['capabilities'] = {};
  readonly operations: CompiledHarness['operations'] = {};
  readonly profiles: CompiledHarness['profiles'] = {};
  readonly bindings: CompiledHarness['bindings'] = [];
  readonly systems = new Set<string>();
  readonly compilingCapabilities = new Set<string>();
  readonly compilingProfiles = new Set<string>();
  readonly operationBindings = new Map<string, CompiledRecord[]>();
  readonly profileNodes = new Map<string, CompiledRecord>();
  host!: HostContract;
  harness!: CompiledRecord;
  constructor(
    readonly task: Capture,
    readonly definitions: Capture,
    readonly options: CompileOptions,
  ) {
    this.reader = new EditorSnapshot({
      root: process.cwd(),
      sources: definitions.sources,
      folders: definitions.folders,
      floorOrigin: definitions.floorOrigin,
      fingerprint: definitions.revision,
      ...(definitions.activation ? { activation: definitions.activation } : {}),
    });
    this.scope = this.reader.resolveScope().token;
    this.records = this.reader.records({ within: this.scope });
    for (const source of definitions.sources.filter((s) => s.location.placement.kind === 'floor'))
      this.source(source.path);
  }
  source(path: string): string {
    const source = this.definitions.sources.find((s) => s.path === path);
    if (!source) fail('IA-COMPOSITION-REFERENCE', 'Admitted component source is unavailable');
    const hash = sha(source.text);
    this.sources.set(path, hash);
    return hash;
  }
  pin(node: CompiledRecord, reason?: string): void {
    if (reason) this.provenance[reason] = unique([...(this.provenance[reason] ?? []), node.identity]);
    if (this.components.has(node.identity)) return;
    if (this.components.size >= 2000)
      fail('IA-COMPOSITION-UNAVAILABLE', 'Executable closure exceeds 2,000 components', node);
    // A component pin digests the admitted record as it did before graph G13 added the per-record digest.
    const { digest: _recordDigest, ...record } = node as Node;
    this.components.set(node.identity, {
      identity: node.identity,
      owner: node.system,
      physicalOwner: systemMember(node.source.path)?.name ?? null,
      schema: node.schema,
      source: { ...node.source, digest: this.source(node.source.path) },
      digest: digest(record),
    });
    const registry = this.reader.inspect().graph.registry;
    const schema = registry.schemas.get(registry.registrations.get(node.discriminator)?.schema ?? node.name);
    if (schema) this.source(schema.path);
    this.pinSystem(node.system);
    const physical = systemMember(node.source.path)?.name;
    if (physical) this.pinSystem(physical);
  }
  pinSystem(name: string): void {
    if (this.systems.has(name)) return;
    this.systems.add(name);
    // The selected floor is a built-in registry dependency; its exact source bytes are pinned above.
    if (name === 'floor') return;
    const declaration = this.reader.inspect().graph.registry.systems.get(name);
    if (!declaration) fail('IA-COMPOSITION-REFERENCE', `System ${name} is unavailable`);
    this.source(declaration.path);
    for (const requirement of declaration.requires) this.pinSystem(requirement.name);
    if (declaration.steward) this.pin(this.reference({ kind: 'ref', ...declaration.steward }, undefined, 'steward'));
  }
  select(id: string, discriminator: string): CompiledRecord {
    const candidates = this.records.filter(
      (r) => r.discriminator === discriminator && (r.identity === id || r.name === id),
    );
    if (candidates.length !== 1) {
      const refused = this.reader.refused.find((r) => r.identity === id || r.identity.endsWith(`/${id}`));
      if (refused)
        throw new CompositionError({
          code: 'IA-COMPOSITION-REFERENCE',
          message: `Expected one admitted ${discriminator}: ${id}`,
          source: { identity: refused.identity, path: refused.path, line: refused.line },
          admission: this.reader.report.findings
            .filter((f) => f.path === refused.path)
            .slice(0, 8)
            .map(({ code, path, line }) => ({ code, path, line })),
        });
      fail('IA-COMPOSITION-REFERENCE', `Expected one admitted ${discriminator}: ${id}`);
    }
    const result = candidates[0]!;
    this.pin(result);
    return result;
  }
  reference(ref: CompiledValue | undefined, from?: CompiledRecord, path?: string, expected?: string): CompiledRecord {
    if (!ref || ref.kind !== 'ref' || ref.fragment || (expected && ref.discriminator !== expected))
      fail(
        'IA-COMPOSITION-REFERENCE',
        `Expected an admitted ${expected ?? 'record'} reference without fragment`,
        from,
        path,
      );
    const resolution = this.reader.resolve(ref, { within: this.scope });
    if (!resolution.ok) fail('IA-COMPOSITION-REFERENCE', resolution.code, from, path);
    const node = this.reader.get(resolution.identity, { within: this.scope });
    if (!node || (expected && node.discriminator !== expected))
      fail('IA-COMPOSITION-REFERENCE', 'Referenced record is unavailable', from, path);
    this.pin(node, from && path ? `${from.identity}:${path}` : undefined);
    return node;
  }
  refs(node: CompiledRecord, section: string, key: string, expected: string): CompiledRecord[] {
    const found = list(node, section, key).map((ref) => this.reference(ref, node, `${section}.${key}`, expected));
    if (new Set(found.map((r) => r.identity)).size !== found.length)
      fail('IA-COMPOSITION-CONFLICT', 'Duplicate component reference', node, `${section}.${key}`);
    return found;
  }
  use<G extends CatalogGroup>(group: G, id: string, node: CompiledRecord, path: string): CatalogValue<G> {
    const entries = this.options.catalog[group];
    const descriptor = entries && Object.hasOwn(entries, id) ? entries[id] : undefined;
    if (!descriptor)
      fail('IA-COMPOSITION-UNAVAILABLE', `Installed ${group} contract is unavailable: ${id}`, node, path);
    let valid = false;
    try {
      valid =
        descriptor.version === 1 &&
        descriptor.digest === digest({ version: descriptor.version, value: descriptor.value });
    } catch {
      /* non-serializable descriptors refuse */
    }
    if (!valid)
      fail('IA-COMPOSITION-CONFLICT', `Installed ${group} contract digest/version mismatch: ${id}`, node, path);
    const address = `${group}:${id}`;
    this.implementations.set(address, { group, id, digest: descriptor.digest });
    this.provenance[`${node.identity}:${path}`] = unique([
      ...(this.provenance[`${node.identity}:${path}`] ?? []),
      address,
    ]);
    return copy(descriptor.value) as CatalogValue<G>;
  }
  effectList(values: readonly string[], node: CompiledRecord, path: string): EffectClass[] {
    if (values.some((v) => !effects.includes(v as EffectClass)) || new Set(values).size !== values.length)
      fail('IA-COMPOSITION-CONFLICT', 'Unknown or duplicate effect class', node, path);
    return [...values] as EffectClass[];
  }
  bounds(values: ResourceLimits, node: CompiledRecord): ResourceLimits {
    if (
      Object.keys(values).some((k) => !LIMIT_KEYS.includes(k as (typeof LIMIT_KEYS)[number])) ||
      Object.entries(values).some(([k, v]) => !Number.isSafeInteger(v) || v < 0 || (k === 'durationMs' && v === 0))
    )
      fail('IA-COMPOSITION-CONFLICT', 'Invalid installed resource limits', node);
    return values;
  }
  input(id: string, node: CompiledRecord, path: string): Json {
    const { schema } = this.use('validators', id, node, path);
    // Validate the schema itself, not a guessed sample value. Unknown vocabulary refuses at load.
    const shape = (s: Json): boolean => {
      if (
        !s ||
        typeof s !== 'object' ||
        Array.isArray(s) ||
        Object.keys(s).some(
          (k) =>
            ![
              'type',
              'properties',
              'required',
              'additionalProperties',
              'items',
              'enum',
              'maxLength',
              'maxItems',
              'minimum',
              'maximum',
            ].includes(k),
        )
      )
        return false;
      for (const k of ['maxLength', 'maxItems'])
        if (s[k] !== undefined && (!Number.isSafeInteger(s[k]) || (s[k] as number) < 0)) return false;
      for (const k of ['minimum', 'maximum'])
        if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) return false;
      if (typeof s['minimum'] === 'number' && typeof s['maximum'] === 'number' && s['minimum'] > s['maximum'])
        return false;
      if (s['enum'] !== undefined && (!Array.isArray(s['enum']) || !s['enum'].length)) return false;
      if (s['type'] === 'object') {
        const p = s['properties'];
        return (
          !!p &&
          typeof p === 'object' &&
          !Array.isArray(p) &&
          s['additionalProperties'] === false &&
          Array.isArray(s['required']) &&
          s['required'].every((k) => typeof k === 'string' && Object.hasOwn(p, k)) &&
          Object.values(p).every(shape)
        );
      }
      if (s['type'] === 'array') return s['items'] !== undefined && shape(s['items']);
      return ['string', 'number', 'integer', 'boolean', 'null'].includes(String(s['type']));
    };
    if (!shape(schema))
      fail('IA-COMPOSITION-UNAVAILABLE', 'Validator uses an unsupported or malformed schema', node, path);
    return schema;
  }
  mapping(id: string, node: CompiledRecord): void {
    if (this.use('mappings', id, node, 'execution.mapping-profile').kind !== 'identity')
      fail('IA-COMPOSITION-UNAVAILABLE', 'Only the installed identity mapping is supported', node);
  }
  outcome(id: string, node: CompiledRecord) {
    const result = this.use('outcomes', id, node, 'execution.outcomes');
    if (
      !result.kinds.length ||
      result.kinds.some((v) => !outcomeKinds.includes(v)) ||
      !['response', 'proposal', 'artifact'].includes(result.completion)
    )
      fail('IA-COMPOSITION-CONFLICT', 'Invalid outcome contract', node);
    return result;
  }
  operation(node: CompiledRecord): string {
    if (this.operations[node.identity]) return node.identity;
    const candidates = this.operationBindings.get(node.identity) ?? [];
    if (candidates.length !== 1)
      fail('IA-COMPOSITION-UNAVAILABLE', 'Operation requires exactly one admitted implementation binding', node);
    const binding = candidates[0]!,
      implementation = field(binding, 'binding', 'implementation');
    closedFields(node);
    if (value(binding, 'binding', 'mapping')) this.mapping(field(binding, 'binding', 'mapping'), binding);
    this.pin(binding);
    const descriptor = this.use('operations', implementation, node, 'execution.handler');
    if (!/^[a-f0-9]{64}$/.test(descriptor.implementationDigest))
      fail(
        'IA-COMPOSITION-UNAVAILABLE',
        'Installed operation lacks a verified implementation digest',
        node,
        'execution.handler',
      );
    const physicalOwner = systemMember(node.source.path)?.name;
    if (
      descriptor.identity !== node.identity ||
      descriptor.owner !== physicalOwner ||
      node.system !== 'authoring-system' ||
      field(node, 'execution', 'handler') !== implementation
    )
      fail(
        'IA-COMPOSITION-CONFLICT',
        'Operation identity, physical owner or native handler differs from its installed binding',
        node,
      );
    if (field(node, 'execution', 'profile', '') !== 'governed-v1')
      fail('IA-COMPOSITION-UNAVAILABLE', 'Legacy operation has no general-executor profile', node, 'execution.profile');
    const declaredEffect = field(node, 'execution', 'effects');
    const nativeEffects = this.effectList(
      [['read-only', 'draft-only'].includes(declaredEffect) ? 'read' : declaredEffect],
      node,
      'execution.effects',
    );
    const contractEffects = this.effectList(descriptor.effects, node, 'execution.effects');
    if (
      descriptor.purpose !== undefined &&
      (descriptor.purpose !== 'candidate-validation' || contractEffects.some((effect) => effect !== 'read'))
    )
      fail('IA-COMPOSITION-CONFLICT', 'Candidate validation must use a read-only installed contract', node);
    if (
      canonical(nativeEffects) !== canonical(contractEffects) ||
      field(node, 'execution', 'input') !== descriptor.input ||
      field(node, 'execution', 'output') !== descriptor.output ||
      field(node, 'execution', 'recovery') !== descriptor.recovery
    )
      fail('IA-COMPOSITION-CONFLICT', 'Native operation contract differs from its installed descriptor', node);
    if (
      !['repeatable', 'idempotent', 'reconcile', 'manual'].includes(descriptor.recovery) ||
      (descriptor.recovery === 'repeatable' && contractEffects.some((e) => e !== 'read')) ||
      !['captured-workspace', 'managed-draft'].includes(descriptor.preflight) ||
      (descriptor.preflight === 'managed-draft' &&
        (canonical(contractEffects) !== canonical(['local-write']) || descriptor.recovery !== 'reconcile')) ||
      !descriptor.handler ||
      !Number.isSafeInteger(descriptor.timeoutMs) ||
      descriptor.timeoutMs <= 0 ||
      !Number.isSafeInteger(descriptor.maxOutputBytes) ||
      descriptor.maxOutputBytes <= 0 ||
      descriptor.maxOutputBytes > 65_536
    )
      fail('IA-COMPOSITION-CONFLICT', 'Invalid effect, recovery or resource contract', node);
    const input = this.input(descriptor.input, node, 'execution.input'),
      output = this.input(descriptor.output, node, 'execution.output');
    const operation = {
      id: node.identity,
      native: node.identity,
      owner: node.system,
      physicalOwner: physicalOwner!,
      handler: descriptor.handler,
      digest: digest({
        descriptor,
        native: this.components.get(node.identity),
        binding: this.components.get(binding.identity),
        input,
        output,
      }),
      effects: contractEffects,
      recovery: descriptor.recovery,
      timeoutMs: descriptor.timeoutMs,
      input,
      output,
      maxOutputBytes: descriptor.maxOutputBytes,
      preflight: descriptor.preflight,
      ...(descriptor.purpose ? { purpose: descriptor.purpose } : {}),
    };
    for (const prior of Object.values(this.operations))
      if (
        prior.handler === operation.handler &&
        canonical({
          input: prior.input,
          output: prior.output,
          effects: prior.effects,
          recovery: prior.recovery,
          timeoutMs: prior.timeoutMs,
          maxOutputBytes: prior.maxOutputBytes,
          preflight: prior.preflight,
          purpose: prior.purpose ?? null,
        }) !==
          canonical({
            input,
            output,
            effects: contractEffects,
            recovery: descriptor.recovery,
            timeoutMs: descriptor.timeoutMs,
            maxOutputBytes: descriptor.maxOutputBytes,
            preflight: descriptor.preflight,
            purpose: descriptor.purpose ?? null,
          })
      )
        fail('IA-COMPOSITION-CONFLICT', 'Shared handler contracts are incompatible', node);
    this.operations[node.identity] = operation;
    this.bindings.push({
      identity: binding.identity,
      kind: 'operation',
      implementation,
      target: node.identity,
      digest: this.components.get(binding.identity)!.digest,
    });
    return node.identity;
  }
  capability(node: CompiledRecord): CompiledCapability {
    const prior = this.capabilities[node.identity];
    if (prior) return prior;
    if (this.compilingCapabilities.has(node.identity))
      fail('IA-COMPOSITION-CYCLE', 'Capability inclusion cycle', node, 'composition.includes');
    if (this.compilingCapabilities.size >= 64)
      fail('IA-COMPOSITION-UNAVAILABLE', 'Capability inclusion exceeds 64 levels', node);
    this.compilingCapabilities.add(node.identity);
    closedFields(node);
    const children = this.refs(node, 'composition', 'includes', 'capability').map((n) => this.capability(n));
    const operations = unique([
      ...children.flatMap((c) => c.operations),
      ...this.refs(node, 'composition', 'operations', 'operation').map((n) => this.operation(n)),
    ]);
    const ownEffects = this.effectList(strings(node, 'execution', 'effects'), node, 'execution.effects');
    const requiredEffects = unique([
      ...children.flatMap((c) => c.effects),
      ...operations.flatMap((id) => this.operations[id]!.effects),
    ]);
    if (requiredEffects.some((e) => !ownEffects.includes(e)))
      fail(
        'IA-COMPOSITION-CONFLICT',
        'Included work exceeds the capability effect declaration',
        node,
        'execution.effects',
      );
    const input = field(node, 'execution', 'input', this.host.defaults.input),
      outcomes = field(node, 'execution', 'outcomes', this.host.defaults.outcomes),
      context = field(node, 'execution', 'context-profile', this.host.defaults.context),
      mapping = field(node, 'execution', 'mapping-profile', this.host.defaults.mapping);
    this.input(input, node, 'execution.input');
    this.outcome(outcomes, node);
    this.use('contexts', context, node, 'execution.context-profile');
    this.mapping(mapping, node);
    if (value(node, 'execution', 'procedure-profile'))
      fail(
        'IA-COMPOSITION-UNAVAILABLE',
        'Structured procedures require an installed scheduler consumer',
        node,
        'execution.procedure-profile',
      );
    const checks = this.refs(node, 'composition', 'checks', 'check').map((check) => {
      // The evaluator a check names: check.implementation when present, else check.runs (compliance checkRunner).
      const key = value(check, 'check', 'implementation') === undefined ? 'runs' : 'implementation';
      const id = field(check, 'check', key);
      this.use('evaluators', id, check, `check.${key}`);
      return id;
    });
    const result: CompiledCapability = {
      identity: node.identity,
      includes: children.map((c) => c.identity),
      operations,
      effects: ownEffects,
      input,
      outcomes,
      context,
      mapping,
      limits: minimum(limits(node), ...children.map((c) => c.limits)),
      checks: unique([...children.flatMap((c) => c.checks), ...checks]),
      playbooks: unique([
        ...children.flatMap((c) => c.playbooks),
        ...this.refs(node, 'composition', 'playbooks', 'playbook').map((n) => n.identity),
      ]),
      templates: unique([
        ...children.flatMap((c) => c.templates),
        ...this.refs(node, 'composition', 'templates', 'template').map((n) => n.identity),
      ]),
    };
    this.capabilities[node.identity] = result;
    this.compilingCapabilities.delete(node.identity);
    return result;
  }
  profile(node: CompiledRecord): CompiledProfile {
    const prior = this.profiles[node.identity];
    if (prior) return prior;
    if (this.compilingProfiles.has(node.identity))
      fail('IA-COMPOSITION-CYCLE', 'Delegate profile cycle', node, 'composition.delegates');
    if (this.compilingProfiles.size >= 32)
      fail('IA-COMPOSITION-UNAVAILABLE', 'Profile dependency exceeds 32 levels', node);
    this.compilingProfiles.add(node.identity);
    this.pin(node);
    closedFields(node);
    const agent = this.reference(value(node, 'composition', 'agent', true), node, 'composition.agent', 'agent');
    const voiceRef = value(node, 'composition', 'voice'),
      voice = voiceRef ? this.reference(voiceRef, node, 'composition.voice', 'voice') : undefined;
    const mandateRef = value(node, 'composition', 'mandate'),
      mandate = mandateRef ? this.reference(mandateRef, node, 'composition.mandate', 'mandate') : undefined;
    if (voice) closedFields(voice);
    if (mandate) closedFields(mandate);
    const roots = this.refs(node, 'composition', 'capabilities', 'capability').map((n) => this.capability(n));
    const closure = new Map<string, CompiledCapability>();
    const expand = (c: CompiledCapability): void => {
      if (closure.has(c.identity)) return;
      closure.set(c.identity, c);
      for (const id of c.includes) expand(this.capabilities[id]!);
    };
    roots.forEach(expand);
    const capabilities = [...closure.values()];
    const contractIds = unique([
      field(node, 'execution', 'mandate-contract'),
      ...(mandate && value(mandate, 'execution', 'contract') ? [field(mandate, 'execution', 'contract')] : []),
    ]);
    const contracts = contractIds.map((id) => this.use('mandates', id, node, 'execution.mandate-contract'));
    const reviews = contracts.flatMap((c) => (c.review ? [c.review] : []));
    if (
      reviews.some(
        (r) =>
          r.rule !== 'independent-exact-candidate-v1' ||
          Object.keys(r).sort().join(',') !== 'mandate,policyRevision,reviewer,rule' ||
          ![r.reviewer, r.mandate, r.policyRevision].every(
            (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 512,
          ) ||
          digest(r) !== digest(reviews[0]),
      )
    )
      fail(
        'IA-COMPOSITION-CONFLICT',
        'Conflicting or invalid installed independent reviewer contracts',
        node,
        'execution.mandate-contract',
      );
    const outcomeIds = unique([
      field(node, 'execution', 'outcomes'),
      ...contracts.map((c) => c.outcomes),
      ...capabilities.map((c) => c.outcomes),
    ]);
    const outcomeContracts = outcomeIds.map((id) => this.outcome(id, node));
    const allowedOutcomes = outcomeContracts.reduce<OutcomeKind[]>(
      (allowed, c) => allowed.filter((kind) => c.kinds.includes(kind)),
      outcomeKinds,
    );
    const obligations = unique(outcomeContracts.map((o) => o.completion).filter((v) => v !== 'response'));
    if (!allowedOutcomes.length || obligations.length > 1)
      fail('IA-COMPOSITION-CONFLICT', 'Incompatible outcome or completion obligations', node, 'execution.outcomes');
    const effectiveEffects = contracts.reduce<EffectClass[]>(
      (allowed, c) => allowed.filter((e) => this.effectList(c.effects, node, 'execution.mandate-contract').includes(e)),
      this.host.effects,
    );
    if (capabilities.some((c) => c.effects.some((e) => !effectiveEffects.includes(e))))
      fail(
        'IA-COMPOSITION-CONFLICT',
        'Capability effects exceed the host or mandate restriction',
        node,
        'composition.capabilities',
      );
    const modelId = field(node, 'execution', 'model-profile', this.host.defaults.model),
      model = this.use('models', modelId, node, 'execution.model-profile');
    if (
      !model.model ||
      !this.host.models.includes(modelId) ||
      contracts.some((c) => c.models && !c.models.includes(modelId))
    )
      fail(
        'IA-COMPOSITION-CONFLICT',
        'Model profile exceeds the host or mandate restriction',
        node,
        'execution.model-profile',
      );
    const contexts = unique([...contracts.map((c) => c.context), ...capabilities.map((c) => c.context)]);
    const checks = unique([...contracts.flatMap((c) => c.checks), ...capabilities.flatMap((c) => c.checks)]);
    for (const id of checks) this.use('evaluators', id, node, 'execution.checks');
    const instructions: string[] = [this.recordText(agent)];
    if (mandate) instructions.push(this.recordText(mandate));
    for (const contextId of contexts) {
      const contract = this.use('contexts', contextId, node, 'execution.context-profile');
      if (
        contract.scope !== 'captured-workspace' ||
        !Number.isSafeInteger(contract.tokens) ||
        contract.tokens <= 0 ||
        contract.tokens > 131_072 ||
        !Number.isSafeInteger(contract.records) ||
        contract.records <= 0 ||
        contract.records > 2000
      )
        fail('IA-COMPOSITION-UNAVAILABLE', 'Unsupported context contract', node);
      // Native runtime chooses cells and applicable governance. Never flatten conditional playbook text.
      const packet = context(
        this.reader,
        { within: this.scope, text: '', coordinate: contract.coordinate },
        { tokens: contract.tokens, records: contract.records },
      );
      if (!packet.ok) fail('IA-COMPOSITION-UNAVAILABLE', packet.message, node, 'execution.context-profile');
      for (const entry of packet.packet.included.filter((e) => e.kind === 'governance')) {
        this.pin(this.reader.get(entry.identity, { within: this.scope })!);
        instructions.push(entry.text);
      }
      for (const id of unique(capabilities.flatMap((c) => c.playbooks))) {
        const scoped = this.reader.resolveScope({ within: this.scope, identities: [id] });
        const method = context(
          this.reader,
          { within: scoped.token, text: '', subject: id, coordinate: contract.coordinate },
          { tokens: contract.tokens, records: contract.records },
          { purpose: true },
        );
        const selected = method.ok ? method.packet.included.find((e) => e.identity === id) : undefined;
        if (
          !selected ||
          !selected.address.startsWith(`${id}#${contract.coordinate.phase}/`) ||
          !method.ok ||
          method.packet.omitted.some((e) => e.reason === 'budget')
        )
          fail(
            'IA-COMPOSITION-UNAVAILABLE',
            'Required method is unavailable at the installed coordinate/budget',
            node,
            'composition.playbooks',
          );
        // The method's says/answers lead its cell, so the agent reads what the step is for before the step.
        instructions.push(selected.purpose === undefined ? selected.text : `${selected.purpose}\n${selected.text}`);
      }
    }
    const inputContracts = unique([...contracts.map((c) => c.input), ...capabilities.map((c) => c.input)]).map(
      (id) => ({ id, schema: this.input(id, node, 'execution.input') }),
    );
    if (!compatibleInputs(inputContracts.map((c) => c.schema)))
      fail('IA-COMPOSITION-CONFLICT', 'Required input contracts have no common value', node, 'execution.input');
    // Every declared input contract is retained for conjunction at runtime; none is silently preferred.
    const result: CompiledProfile = {
      id: node.identity,
      native: node.identity,
      agent: agent.identity,
      role: field(node, 'execution', 'role'),
      voice: voice
        ? ['tone', 'terminology', 'explanation', 'uncertainty', 'audience', 'citations']
            .flatMap((key) =>
              value(voice, 'communication', key) ? [`${key}: ${field(voice, 'communication', key)}`] : [],
            )
            .join('\n')
        : '',
      instructions: unique(instructions),
      operations: unique(capabilities.flatMap((c) => c.operations)),
      capabilities: capabilities.map((c) => c.identity),
      delegates: [],
      outcomes: allowedOutcomes,
      completion: obligations[0] ?? 'response',
      checks,
      model: model.model,
      ...(this.host.requestBytes === undefined ? {} : { requestBytes: this.host.requestBytes }),
      ...(reviews[0] ? { review: copy(reviews[0]) } : {}),
      mandate: mandate?.identity ?? null,
      mandateContracts: contractIds,
      inputContracts,
      effects: effectiveEffects,
      limits: minimum(
        this.bounds(this.host.limits, node),
        limits(this.harness),
        ...contracts.map((c) => this.bounds(c.limits, node)),
        ...(mandate ? [limits(mandate)] : []),
        limits(node),
        ...capabilities.map((c) => c.limits),
      ),
      contexts,
      templates: unique(capabilities.flatMap((c) => c.templates)),
      delegation: [],
    };
    for (const childNode of this.refs(node, 'composition', 'delegates', 'agent-profile')) {
      if (!this.profileNodes.has(childNode.identity))
        fail('IA-COMPOSITION-REFERENCE', 'Delegate is outside the harness', node, 'composition.delegates');
      const child = this.profile(childNode);
      if (
        child.agent === result.agent ||
        child.operations.some((id) => !result.operations.includes(id)) ||
        child.effects.some((e) => !result.effects.includes(e))
      )
        fail(
          'IA-COMPOSITION-CONFLICT',
          'Delegate repeats the agent or widens parent work/effects',
          node,
          'composition.delegates',
        );
      if (result.review && digest(child.review ?? null) !== digest(result.review))
        fail(
          'IA-COMPOSITION-CONFLICT',
          'Delegate cannot drop or change independent reviewer authority',
          node,
          'composition.delegates',
        );
      result.delegates.push(child.id);
      result.delegation.push({ profile: child.id, limits: minimum(result.limits, child.limits) });
    }
    const contributors: Record<string, string[]> = {
      ...(this.host.requestBytes === undefined
        ? {}
        : { requestBytes: [`hosts:${field(this.harness, 'execution', 'host-profile')}`] }),
      ...(reviews.length ? { review: contractIds.map((id) => `mandates:${id}`) } : {}),
      agent: [agent.identity],
      role: [node.identity],
      voice: [voice?.identity ?? node.identity],
      instructions: unique([
        agent.identity,
        ...(mandate ? [mandate.identity] : []),
        ...capabilities.flatMap((c) => c.playbooks),
        ...[...this.components.values()].filter((p) => p.identity.includes('/governance/')).map((p) => p.identity),
      ]),
      capabilities: capabilities.map((c) => c.identity),
      operations: result.operations,
      delegates: [node.identity, ...result.delegates],
      limits: [
        this.harness.identity,
        node.identity,
        ...(mandate ? [mandate.identity] : []),
        ...capabilities.map((c) => c.identity),
        ...contractIds.map((id) => `mandates:${id}`),
        `hosts:${field(this.harness, 'execution', 'host-profile')}`,
      ],
      effects: [
        node.identity,
        ...capabilities.map((c) => c.identity),
        ...contractIds.map((id) => `mandates:${id}`),
        `hosts:${field(this.harness, 'execution', 'host-profile')}`,
      ],
      model: [`models:${modelId}`],
      checks: checks.map((id) => `evaluators:${id}`),
      inputContracts: inputContracts.map((c) => `validators:${c.id}`),
      outcomes: outcomeIds.map((id) => `outcomes:${id}`),
      completion: outcomeIds.map((id) => `outcomes:${id}`),
      contexts: contexts.map((id) => `contexts:${id}`),
      templates: result.templates,
      mandateContracts: contractIds.map((id) => `mandates:${id}`),
    };
    for (const [key, sources] of Object.entries(contributors))
      this.provenance[`normalized:${node.identity}:${key}`] = sources;
    this.profiles[node.identity] = result;
    this.compilingProfiles.delete(node.identity);
    return result;
  }
  recordText(node: CompiledRecord): string {
    const source = this.definitions.sources.find((s) => s.path === node.source.path)!;
    return source.text
      .split('\n')
      .slice(node.source.line - 1, node.source.endLine)
      .join('\n');
  }
  compile(): CompiledHarness {
    this.harness = this.select(this.options.harness, 'harness');
    closedFields(this.harness);
    const workspace = this.reference(
      value(this.harness, 'composition', 'workspace', true),
      this.harness,
      'composition.workspace',
      'workspace',
    );
    for (const system of this.refs(workspace, 'composition', 'systems', 'system')) this.pinSystem(system.name);
    const hostId = field(this.harness, 'execution', 'host-profile');
    this.host = this.use('hosts', hostId, this.harness, 'execution.host-profile');
    if (
      this.host.requestBytes !== undefined &&
      (!Number.isSafeInteger(this.host.requestBytes) ||
        this.host.requestBytes <= 0 ||
        this.host.requestBytes > MAX_MODEL_REQUEST_BYTES)
    )
      fail(
        'IA-COMPOSITION-CONFLICT',
        'Invalid installed model request ceiling',
        this.harness,
        'execution.host-profile',
      );
    this.effectList(this.host.effects, this.harness, 'execution.host-profile');
    this.bounds(this.host.limits, this.harness);
    const roles = new Set<string>();
    for (const node of this.refs(this.harness, 'composition', 'profiles', 'agent-profile')) {
      const role = field(node, 'execution', 'role');
      if (roles.has(role))
        fail('IA-COMPOSITION-ROLE', 'Profile roles must be unique in a harness', node, 'execution.role');
      roles.add(role);
      this.profileNodes.set(node.identity, node);
    }
    const bindings = this.refs(this.harness, 'composition', 'bindings', 'execution-binding');
    for (const binding of bindings) {
      closedFields(binding);
      const kind = field(binding, 'binding', 'kind');
      if (!['entry', 'operation'].includes(kind))
        fail(
          'IA-COMPOSITION-UNAVAILABLE',
          `Binding profile ${kind} has no installed consumer in this compiler version`,
          binding,
          'binding.kind',
        );
      for (const key of ['event', 'guard', 'tools', 'filters'])
        if (value(binding, 'binding', key))
          fail('IA-COMPOSITION-CONFLICT', `Field ${key} is not valid for ${kind}`, binding, `binding.${key}`);
      if (kind === 'operation') {
        const target = this.reference(
          value(binding, 'binding', 'target', true),
          binding,
          'binding.target',
          'operation',
        );
        this.operationBindings.set(target.identity, [...(this.operationBindings.get(target.identity) ?? []), binding]);
      }
    }
    const entries = bindings.filter(
      (b) =>
        field(b, 'binding', 'kind') === 'entry' && (b.identity === this.options.entry || b.name === this.options.entry),
    );
    if (entries.length !== 1)
      fail(
        'IA-COMPOSITION-REFERENCE',
        'Select one admitted entry binding in the harness',
        this.harness,
        'composition.bindings',
      );
    const entry = entries[0]!,
      implementation = field(entry, 'binding', 'implementation'),
      entryContract = this.use('entries', implementation, entry, 'binding.implementation');
    if (entryContract.target !== 'agent-profile')
      fail('IA-COMPOSITION-UNAVAILABLE', 'Entry target contract is unsupported', entry);
    const mapping = field(entry, 'binding', 'mapping', entryContract.mapping);
    this.mapping(mapping, entry);
    if (mapping !== entryContract.mapping)
      fail('IA-COMPOSITION-CONFLICT', 'Entry mapping differs from the installed transport', entry);
    const target = this.reference(value(entry, 'binding', 'target', true), entry, 'binding.target', 'agent-profile');
    if (!this.profileNodes.has(target.identity))
      fail('IA-COMPOSITION-REFERENCE', 'Entry profile is outside the harness', entry);
    this.profile(target);
    const ancestry = (id: string, agents: string[], checked = new Set<string>()): void => {
      const profile = this.profiles[id]!;
      if (agents.includes(profile.agent))
        fail(
          'IA-COMPOSITION-CYCLE',
          'Agent repeats in its active ancestor chain',
          this.profileNodes.get(id),
          'composition.delegates',
        );
      const state = canonical([id, [...agents].sort()]);
      if (checked.has(state)) return;
      if (checked.size >= 2000)
        fail('IA-COMPOSITION-UNAVAILABLE', 'Delegate ancestry exceeds 2,000 states', this.profileNodes.get(id));
      checked.add(state);
      for (const child of profile.delegates) ancestry(child, [...agents, profile.agent], checked);
    };
    ancestry(target.identity, []);
    this.bindings.push({
      identity: entry.identity,
      kind: 'entry',
      implementation,
      target: target.identity,
      digest: this.components.get(entry.identity)!.digest,
    });
    const components = sort([...this.components.values()], (c) => c.identity),
      sources = sort(
        [...this.sources].map(([path, hash]) => ({ path, digest: hash })),
        (s) => s.path,
      ),
      installed = sort([...this.implementations.values()], (c) => `${c.group}:${c.id}`);
    const provenance = {
      executableDigest: digest({ components, sources, installed }),
      components,
      sources,
      installed,
      fields: this.provenance,
    };
    const body = {
      format: 'ia.compiled-harness.v1' as const,
      id: this.harness.identity,
      workspace: workspace.identity,
      sourceDigest: this.task.revision,
      entry: { binding: entry.identity, profile: target.identity, mapping },
      profiles: this.profiles,
      capabilities: this.capabilities,
      operations: this.operations,
      bindings: sort(this.bindings, (b) => b.identity),
      provenance,
    };
    if (Buffer.byteLength(canonical(body)) > 2 * 1024 * 1024)
      fail('IA-COMPOSITION-UNAVAILABLE', 'Compiled manifest exceeds 2 MiB', this.harness);
    return { ...body, digest: digest(body) };
  }
}

/** Pure admission/compilation. No provider, implementation callback, installation or filesystem write. */
export function compileHarness(capture: Capture, options: CompileOptions): Compilation {
  let compiler: Compiler | undefined;
  try {
    const task = verifyCapture(capture),
      definitions = verifyCapture(options.definitions ?? capture);
    compiler = new Compiler(task, definitions, options);
    return { ok: true, manifest: compiler.compile() };
  } catch (error) {
    if (!(error instanceof CompositionError)) throw error;
    return { ok: false, diagnostics: [error.diagnostic] };
  } finally {
    compiler?.reader.close();
  }
}
