import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathKey, unaliased } from '@inventarch/db';
import { canonicalDistributionJson, decodeDistributionJson, platformDebris } from '@inventarch/db/distribution';

import { installedImplementationDigest } from '@inventarch/agent-composition-system';
import { openLocalAuthoringView } from '@inventarch/agent-composition-system/authoring-manifest';
import {
  AuthoringError,
  prepareAuthoringTarget,
  resolveAuthoring,
} from '@inventarch/agent-composition-system/authoring';
import { ResourceError, resourceOccurrences } from '@inventarch/agent-composition-system/resources';
import {
  LifecycleError,
  verifyLifecycleProfile,
  lifecycleProfile,
  SELECTED_CLAUDE_CODE_VERSION,
} from '@inventarch/agent-composition-system/lifecycle-profile';
import { decodeLifecycleEvent } from '@inventarch/agent-composition-system/lifecycle-profile';
import type { LifecycleEvent, LifecycleProfile } from '@inventarch/agent-composition-system/lifecycle-profile';
import {
  prepareLifecycleContext,
  prepareLifecycleContextSegments,
} from '@inventarch/agent-composition-system/lifecycle';
import type {
  LifecycleBudgets,
  LifecycleInputIdentity,
  LifecycleOutput,
  LifecycleView,
  PreparedContext,
  PreparedContextSegments,
} from '@inventarch/agent-composition-system/lifecycle';
import type { AuthoringTarget, LifecycleCoordinate } from '@inventarch/agent-composition-system/authoring';
import { COORDINATE_DOMAINS, isEntry, prepareCoordinate } from '@inventarch/runtime';

export interface ContextHookBindingInput {
  readonly format: 'ia.context-hook-binding.v1';
  readonly root: string;
  readonly owner: string;
  readonly actor: string;
  readonly workspace: string;
  readonly profile: LifecycleProfile;
  readonly scope: { readonly root: string; readonly identities: readonly string[] | null };
  readonly view: {
    readonly id: string;
    readonly adopted: readonly { readonly id: string; readonly root: string }[];
    readonly manifests: readonly { readonly source: string; readonly root: string }[];
  };
  readonly selection: {
    readonly target: string;
    readonly document: string | null;
    readonly lifecycle: Omit<LifecycleCoordinate, 'role' | 'maturity'> | null;
  };
  readonly coordinate: Readonly<Record<string, unknown>>;
  readonly bootstrap: string;
  readonly budgets: LifecycleBudgets;
  readonly policy: string;
  readonly implementation: string;
}
/** Bounded headroom for twelve independently fresh external hooks; byte-estimate tokens, not model billing tokens. */
export const DEFAULT_CONTEXT_HOOK_BUDGETS: LifecycleBudgets = Object.freeze({
  tokens: 20_000,
  records: 32,
  bytes: 80_000,
  timeoutMs: 30_000,
});
export interface ContextHookBinding extends ContextHookBindingInput {
  readonly digest: string;
}
export interface ContextHookHost {
  implementation(): string;
  openCurrentView(binding: ContextHookBinding, event: LifecycleEvent, signal: AbortSignal): Promise<LifecycleView>;
  assertCurrent(view: LifecycleView, binding: ContextHookBinding, signal: AbortSignal): void | Promise<void>;
  acceptInput?(
    identity: LifecycleInputIdentity,
    binding: ContextHookBinding,
    signal: AbortSignal,
  ): void | Promise<void>;
}
export type ContextHookResult =
  | {
      readonly status: 'generated';
      readonly delivery: 'unconfirmed';
      readonly prepared: PreparedContext | PreparedContextSegments;
      readonly output: LifecycleOutput;
    }
  | {
      readonly status: 'unavailable';
      readonly delivery: 'not-generated';
      readonly code: string;
      readonly output: { readonly systemMessage: string };
    };
const fields = [
  'format',
  'root',
  'owner',
  'actor',
  'workspace',
  'profile',
  'scope',
  'view',
  'selection',
  'coordinate',
  'bootstrap',
  'budgets',
  'policy',
  'implementation',
];
/** Paths compare as the volume compares names: case on win32; normalization and full case folding on darwin (#315, #323). */
const fold = pathKey;
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
function fail(message: string): never {
  throw new LifecycleError('IA-LIFECYCLE-BINDING', message);
}
function plain(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('Invalid context hook binding');
  const keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !fields.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('Context binding has unknown, missing or non-data fields');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 4096): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    Buffer.byteLength(value) > maximum ||
    Buffer.from(value).toString('utf8') !== value
  )
    fail('Invalid bounded context binding text');
  return value;
}
function pin(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) fail('Invalid context binding digest');
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function physicalDirectory(value: string): string {
  if (!isAbsolute(value)) fail('Context binding requires a fixed absolute root');
  const root = resolve(value);
  let current = root;
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !unaliased(current, realpathSync.native(current)))
      fail('Context root is not an unaliased physical directory');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return root;
}
function within(root: string, target: string): boolean {
  const path = relative(fold(root), fold(target));
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}
function scopePath(value: unknown): string {
  if (value === '') return '';
  const result = text(value, 1024);
  if (
    result.includes('\\') ||
    isAbsolute(result) ||
    result.split('/').some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p))
  )
    fail('Invalid native scope root');
  return result;
}
/** Explicit trusted registration factory. The returned digest covers all root/identity/scope selections. */
export function createContextHookBinding(input: ContextHookBindingInput): ContextHookBinding {
  plain(input, fields);
  if (input.format !== 'ia.context-hook-binding.v1') fail('Unknown context binding format');
  const root = physicalDirectory(text(input.root)),
    profile = verifyLifecycleProfile(input.profile);
  if (profile.host !== 'claude-code') fail('This context hook requires the supported Claude profile');
  const scope = plain(input.scope, ['root', 'identities']),
    selection = plain(input.selection, ['target', 'document', 'lifecycle']);
  const identities = scope['identities'];
  if (
    identities !== null &&
    (!Array.isArray(identities) || identities.length > 256 || new Set(identities).size !== identities.length)
  )
    fail('Invalid context scope identity selection');
  const selectedIdentities = identities === null ? null : (identities as unknown[]).map((item) => text(item, 1024));
  const rawView = plain(input.view, ['id', 'adopted', 'manifests']);
  if (
    !Array.isArray(rawView['adopted']) ||
    rawView['adopted'].length > 64 ||
    !Array.isArray(rawView['manifests']) ||
    !rawView['manifests'].length ||
    rawView['manifests'].length > 64
  )
    fail('Invalid explicit authoring package selection');
  const adopted = rawView['adopted'].map((input: unknown) => {
    const row = plain(input, ['id', 'root']);
    return { id: text(row['id'], 64), root: physicalDirectory(text(row['root'])) };
  });
  const manifests = rawView['manifests'].map((input: unknown) => {
    const row = plain(input, ['source', 'root']);
    return { source: text(row['source'], 64), root: physicalDirectory(text(row['root'])) };
  });
  if (
    new Set(adopted.map((row) => row.id)).size !== adopted.length ||
    new Set(manifests.map((row) => row.source)).size !== manifests.length
  )
    fail('Duplicate authoring source selection');
  const target = text(selection['target'], 1024),
    document = selection['document'] === null ? null : text(selection['document'], 128);
  const lifecycle = selection['lifecycle'];
  if (lifecycle !== null) {
    const row = plain(lifecycle, ['model', 'version', 'workflow', 'iteration', 'stage', 'phase', 'primitive']);
    for (const key of ['model', 'version', 'workflow', 'stage']) text(row[key], 128);
    if (
      !Number.isSafeInteger(row['iteration']) ||
      (row['iteration'] as number) < 0 ||
      (row['iteration'] as number) > 1_000_000
    )
      fail('Invalid lifecycle iteration');
    for (const axis of ['phase', 'primitive'] as const)
      if (row[axis] !== null && !COORDINATE_DOMAINS[axis].includes(text(row[axis], 64)))
        fail('Unknown lifecycle method coordinate');
  }
  const coordinate = prepareCoordinate('', input.coordinate);
  if (!coordinate.values.phase || !coordinate.values.primitive)
    fail('Context binding requires explicit phase and primitive');
  plain(input.budgets, ['tokens', 'records', 'bytes', 'timeoutMs']);
  for (const [key, min, max] of [
    ['tokens', 1, 256 * 1024],
    ['records', 1, 256],
    ['bytes', 128, 1024 * 1024],
    ['timeoutMs', 1, 60_000],
  ] as const)
    if (!Number.isSafeInteger(input.budgets[key]) || input.budgets[key] < min || input.budgets[key] > max)
      fail('Context hook budget is outside its finite bound');
  const body: ContextHookBindingInput = {
    format: input.format,
    root,
    owner: text(input.owner, 256),
    actor: text(input.actor, 256),
    workspace: text(input.workspace, 256),
    profile,
    scope: { root: scopePath(scope['root']), identities: selectedIdentities },
    view: { id: text(rawView['id'], 64), adopted, manifests },
    selection: {
      target,
      document,
      lifecycle:
        lifecycle === null
          ? null
          : { ...(lifecycle as NonNullable<ContextHookBindingInput['selection']['lifecycle']>) },
    },
    coordinate: { ...input.coordinate },
    bootstrap: text(input.bootstrap, profile.maxPromptBytes),
    budgets: { ...input.budgets },
    policy: pin(input.policy),
    implementation: pin(input.implementation),
  };
  return freeze({ ...body, digest: hash(canonicalDistributionJson(body)) });
}
function verifyBinding(input: ContextHookBinding): ContextHookBinding {
  plain(input, [...fields, 'digest']);
  const { digest, ...body } = input,
    expected = createContextHookBinding(body);
  if (expected.digest !== pin(digest) || canonicalDistributionJson(expected) !== canonicalDistributionJson(input))
    fail('Context binding digest or canonical root differs');
  return expected;
}
/** Read only the fixed project's managed binding; no event field selects this path. */
export function readContextHookBinding(rootInput: string, pathInput: string): ContextHookBinding {
  const root = physicalDirectory(rootInput),
    path = resolve(pathInput),
    rel = relative(root, path).replaceAll('\\', '/');
  if (
    !isAbsolute(pathInput) ||
    !/^\.ia\/distributions\/hosts\/claude-context-[a-z][a-z0-9-]{0,63}\.binding\.json$/.test(rel) ||
    !unaliased(path, realpathSync.native(path))
  )
    fail('Context binding path is outside its fixed managed location');
  physicalDirectory(dirname(path));
  const maximum = 64 * 1024,
    stat = lstatSync(path);
  const regular = (value: Stats): boolean =>
    value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && value.size <= maximum;
  const same = (value: Stats): boolean =>
    regular(value) &&
    value.dev === stat.dev &&
    value.ino === stat.ino &&
    value.size === stat.size &&
    value.mtimeMs === stat.mtimeMs &&
    value.ctimeMs === stat.ctimeMs;
  if (!regular(stat)) fail('Context binding is not a bounded regular file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    if (!same(fstatSync(fd))) fail('Context binding identity changed before read');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (
      length !== stat.size ||
      length > maximum ||
      !same(fstatSync(fd)) ||
      !same(lstatSync(path)) ||
      !unaliased(path, realpathSync.native(path))
    )
      fail('Context binding changed during read');
    physicalDirectory(dirname(path));
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
  const parsed = decodeDistributionJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as ContextHookBinding,
    result = verifyBinding(parsed);
  if (fold(result.root) !== fold(root)) fail('Context binding names another root');
  return result;
}
/** Fixed module inventory; no import-time I/O. Root override is for isolated host tests only. */
export function contextHookImplementationDigest(directory = import.meta.dirname): string {
  const root = physicalDirectory(directory),
    files: { path: string; digest: string }[] = [],
    names = new Set<string>();
  let count = 0,
    total = 0;
  const visit = (directory: string, prefix = '', depth = 0): void => {
    if (depth > 16) fail('Hook implementation inventory exceeds its bound');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = entry.name,
        path = prefix + name;
      if (
        ++count > 2000 ||
        name !== name.normalize('NFC') ||
        /[\\/:\u0000-\u001f]/.test(name) ||
        /[. ]$/.test(name) ||
        names.has(path.toLowerCase())
      )
        fail('Hook implementation has aliased paths');
      names.add(path.toLowerCase());
      const absolute = resolve(directory, name),
        stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('Hook implementation aliases are unsupported');
      if (stat.isDirectory()) visit(absolute, path + '/', depth + 1);
      else if (!stat.isFile()) fail('Hook implementation has a nonregular file');
      // A Finder or AppleDouble file is never code: the launcher skips it, so the identity must too (#323).
      else if (/\.(?:[cm]?[jt]s|json|node|wasm)$/.test(name) && !/\.d\.[cm]?ts$/.test(name) && !platformDebris(name)) {
        if (stat.size > 8 * 1024 * 1024 || (total += stat.size) > 32 * 1024 * 1024)
          fail('Hook implementation bytes exceed their bound');
        files.push({ path, digest: hash(readFileSync(absolute)) });
      }
    }
  };
  visit(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = new Set(files.map((f) => f.path)),
    source = ['main.ts', 'context.ts'].every((p) => paths.has(p)),
    emitted = ['main.js', 'context.js'].every((p) => paths.has(p));
  if (source === emitted) fail('Hook implementation is partial or mixed');
  return hash(
    canonicalDistributionJson({
      format: 'ia.context-hook-implementation.v1',
      native: installedImplementationDigest(),
      kind: source ? 'source' : 'emitted',
      files,
    }),
  );
}
/** Deterministic consumer. A successful stdout packet remains delivery-unconfirmed. */
export async function evaluateContextHook(
  input: ContextHookBinding,
  text: string,
  host: ContextHookHost,
  signal?: AbortSignal,
): Promise<ContextHookResult> {
  return evaluate(input, text, host, undefined, signal);
}
export async function evaluateContextHookPart(
  input: ContextHookBinding,
  text: string,
  part: number,
  host: ContextHookHost,
  signal?: AbortSignal,
): Promise<ContextHookResult> {
  return evaluate(input, text, host, part, signal);
}
async function evaluate(
  input: ContextHookBinding,
  text: string,
  host: ContextHookHost,
  part: number | undefined,
  signal?: AbortSignal,
): Promise<ContextHookResult> {
  try {
    if (part !== undefined && (!Number.isSafeInteger(part) || part < 0 || part >= 12))
      fail('Invalid bounded context slot');
    const binding = verifyBinding(input),
      event = decodeLifecycleEvent(binding.profile, text),
      current = host.implementation.bind(host);
    const open = host.openCurrentView.bind(host),
      check = host.assertCurrent.bind(host),
      accept = host.acceptInput?.bind(host);
    const cwd = physicalDirectory(event.cwd);
    if (!within(binding.root, cwd)) fail('Hook cwd is outside the fixed project root');
    if (current() !== binding.implementation) fail('Installed hook implementation changed');
    const prepare = part === undefined ? prepareLifecycleContext : prepareLifecycleContextSegments;
    const prepared = await prepare(
      {
        profile: binding.profile,
        coordinate: binding.coordinate,
        bootstrap: binding.bootstrap,
        budgets: binding.budgets,
        binding: binding.digest,
        policy: binding.policy,
        implementation: binding.implementation,
      },
      event,
      {
        openCurrentView: (_config, event, signal) => open(binding, event, signal),
        assertCurrent: async (view, _config, signal) => {
          if (current() !== binding.implementation || physicalDirectory(binding.root) !== binding.root)
            fail('Installed hook binding changed');
          const snapshot = view.reader.snapshot({ within: view.within });
          if (
            snapshot.root !== binding.scope.root ||
            (binding.scope.identities !== null &&
              snapshot.records.some((node) => !binding.scope.identities!.includes(node.identity)))
          )
            fail('Opened native context scope differs from binding');
          await check(view, binding, signal);
        },
        ...(accept
          ? {
              acceptInput: (identity: LifecycleInputIdentity, signal: AbortSignal) => accept(identity, binding, signal),
            }
          : {}),
      },
      signal,
    );
    return {
      status: 'generated',
      delivery: 'unconfirmed',
      prepared,
      output: 'outputs' in prepared ? prepared.outputs[part!]! : prepared.output,
    };
  } catch (error) {
    const codes = new Set(
      [
        'INPUT',
        'UNAVAILABLE',
        'STALE',
        'REQUIRED',
        'BUDGET',
        'COORDINATE',
        'CONTEXT',
        'CANCELLED',
        'DEADLINE',
        'BINDING',
      ].map((code) => `IA-LIFECYCLE-${code}`),
    );
    const code = error instanceof LifecycleError && codes.has(error.code) ? error.code : 'IA-LIFECYCLE-UNAVAILABLE';
    return {
      status: 'unavailable',
      delivery: 'not-generated',
      code,
      output: { systemMessage: `IA lifecycle context unavailable (${code}). No context was generated.` },
    };
  }
}

/** A target outside the binding's own native scope is unavailable required material, never a generic failure. */
function scopedTarget<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof AuthoringError && error.code === 'IA-AUTHORING-SCOPE')
      throw new LifecycleError('IA-LIFECYCLE-REQUIRED', 'Required authoring context is unavailable');
    throw error;
  }
}
/** The owners' refusals when current bytes differ from those the open view captured or pinned: a fresh capture that differs
 * (`authoring-manifest.ts:94`), the manifest, a selected resource or the native source changing under the re-capture
 * (`authoring-manifest.ts:121`, `resource-files.ts:34,36,50`), and @inventarch/db's closed IA-DB-SOURCE-CHANGED code. */
const VIEW_CHANGES: ReadonlySet<string> = new Set([
  'Local authoring source or selected resource view changed',
  'Authoring manifest changed while loading',
  'Resource changed while capturing',
  'Resource differs from its pinned size/hash',
  'Physical native source differs from its captured revision',
]);
const viewChanged = (error: unknown): boolean =>
  error instanceof ResourceError
    ? VIEW_CHANGES.has(error.message)
    : error instanceof Error && (error as { code?: unknown }).code === 'IA-DB-SOURCE-CHANGED';
/** Only a changed source or resource selection is stale; a closed view or any other failed re-capture keeps its own error for the generic handling. */
function freshView(check: () => void): void {
  try {
    check();
  } catch (error) {
    if (viewChanged(error))
      throw new LifecycleError('IA-LIFECYCLE-STALE', 'Local authoring source or resource selection changed');
    throw error;
  }
}
/** Static local adapter: explicitly selected source packages and manifests are the only resource inputs. */
export function localContextHookHost(): ContextHookHost {
  const checks = new WeakMap<LifecycleView, () => void>();
  return {
    implementation: () => contextHookImplementationDigest(),
    openCurrentView: async (binding) => {
      const local = openLocalAuthoringView({ root: binding.root, ...binding.view, scope: binding.scope });
      try {
        const occurrences = resourceOccurrences(local.capture).occurrences.filter(
          (item) => item.identity === binding.selection.target,
        );
        if (occurrences.length !== 1) fail('Configured authoring target is unavailable or ambiguous');
        const target: AuthoringTarget = occurrences[0]!;
        const authoring = resolveAuthoring(local.capture, local.resources, local.index, {
          reader: local.reader,
          within: local.within,
          allowedResources: local.resources.files.map((file) => file.key),
          allowedSystems: local.systems,
          allowedRegistrations: local.registrations,
          allowedArtifacts: local.index.artifacts.map((artifact) => artifact.id),
          allowedDocuments: local.index.documents.map((document) => document.id),
        });
        const pins = {
          binding: binding.digest,
          source: local.capture.revision,
          view: local.reader.snapshot({ within: local.within }).revision,
          resources: local.resources.digest,
          installation: local.capture.activation?.generation ?? null,
          profile: binding.profile.digest,
          policy: binding.policy,
          implementation: binding.implementation,
        };
        const view: LifecycleView = {
          reader: local.reader,
          within: local.within,
          pins,
          requiredParts: (input) => {
            const result = scopedTarget(() => prepareAuthoringTarget(authoring, { ...binding.selection, target }));
            return { pins: input.pins, parts: result.parts, missing: result.missing, proof: result.proof };
          },
          close: () => local.close(),
        };
        checks.set(view, () => local.assertCurrent());
        return view;
      } catch (error) {
        local.close();
        throw error;
      }
    },
    assertCurrent: (view) => {
      const check = checks.get(view);
      if (!check) fail('Unrecognized local authoring view');
      freshView(check);
    },
  };
}

/** Installed executable entry; identity probes perform no context or source discovery. */
export async function runContextHook(argv: readonly string[], input: string): Promise<unknown> {
  if (argv.length === 1 && argv[0] === 'identity') {
    const profile = lifecycleProfile('claude-code', SELECTED_CLAUDE_CODE_VERSION);
    return {
      format: 'ia.context-hook-identity.v2',
      implementation: contextHookImplementationDigest(),
      profile: profile.digest,
      slots: profile.maxContextParts,
      characters: profile.maxContextCharacters,
    };
  }
  if (
    ![4, 6].includes(argv.length) ||
    argv[0] !== '--root' ||
    argv[2] !== '--binding' ||
    (argv.length === 6 && (argv[4] !== '--part' || !/^(?:[0-9]|1[01])$/.test(argv[5]!)))
  )
    fail('Expected explicit --root, --binding and optional bounded --part');
  const binding = readContextHookBinding(argv[1]!, argv[3]!);
  return (
    await (argv.length === 6
      ? evaluateContextHookPart(binding, input, Number(argv[5]), localContextHookHost())
      : evaluateContextHook(binding, input, localContextHookHost()))
  ).output;
}
if (isEntry(process.argv[1], import.meta.url)) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (process.argv[2] !== 'identity')
      for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if ((size += bytes.length) > 1024 * 1024) fail('Hook stdin exceeds 1 MiB');
        chunks.push(bytes);
      }
    const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    process.stdout.write(JSON.stringify(await runContextHook(process.argv.slice(2), input)));
  } catch {
    process.stdout.write(
      JSON.stringify({
        systemMessage: 'IA lifecycle context unavailable (IA-LIFECYCLE-UNAVAILABLE). No context was generated.',
      }),
    );
    if (process.argv[2] === 'identity') process.exitCode = 1;
  }
}
