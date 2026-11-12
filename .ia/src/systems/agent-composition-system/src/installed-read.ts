import { manifestDigest, validateShape } from '@inventarch/agent-system';
import type { Manifest, OperationAdapter, OperationContext } from '@inventarch/agent-system';
import { canonical, copy, digest, SessionError } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import { installed } from './catalog.js';
import type { CatalogAliases, CompositionCatalog } from './catalog.js';
import type { CompiledHarness } from './compiled.js';
import { compileHarness } from './compile.js';
import { Corpus, verifyCapture } from '@inventarch/workspace-runtime/corpus';
import type { Capture } from '@inventarch/workspace-runtime/corpus';
import { compiledAliases, executionManifest } from './execution.js';
import { installedImplementationDigest } from './installed-catalog.js';

/** Fixed first-party identities. Native/model inputs never select a module or handler. */
export const INSTALLED_READ = Object.freeze({
  operation: 'authoring-system/binding/operation/read-captured-source',
  implementation: 'captured-source-read',
  handler: 'captured-source-read',
  input: 'captured-source-read-input',
  output: 'captured-source-read-output',
});
/**
 * The ids this read shipped under before names stopped carrying their version. The catalog still installs these
 * entries, byte for byte, so a harness pinned to them still passes `executionManifest` and still dispatches by the old
 * handler. New compilations go to the plain entries through `installedReadAliases()`.
 */
export const INSTALLED_READ_LEGACY = Object.freeze({
  operation: INSTALLED_READ.operation,
  implementation: 'captured-source-read-v1',
  handler: 'ia.captured-source.read.v1',
  input: 'captured-source-read-input-v1',
  output: 'captured-source-read-output-v1',
});
type ReadIds = typeof INSTALLED_READ | typeof INSTALLED_READ_LEGACY;
export type InstalledReadCatalog = Pick<CompositionCatalog, 'validators' | 'operations'>;
const inputSchema: Json = {
  type: 'object',
  properties: {
    path: { type: 'string', maxLength: 2048 },
    start: { type: 'integer', minimum: 0, maximum: 100000 },
    limit: { type: 'integer', minimum: 1, maximum: 400 },
  },
  required: ['path'],
  additionalProperties: false,
};
const outputSchema: Json = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 49152 },
    revision: { type: 'string', maxLength: 64 },
    citations: { type: 'array', items: { type: 'string', maxLength: 2200 }, maxItems: 1 },
  },
  required: ['text', 'revision', 'citations'],
  additionalProperties: false,
};

/** Each old read name mapped to the plain name that replaces it, for the host to pass to `compileHarness`. */
export function installedReadAliases(): CatalogAliases {
  return {
    operations: { [INSTALLED_READ_LEGACY.implementation]: INSTALLED_READ.implementation },
    validators: {
      [INSTALLED_READ_LEGACY.input]: INSTALLED_READ.input,
      [INSTALLED_READ_LEGACY.output]: INSTALLED_READ.output,
    },
  };
}

/** Installed descriptions only. No capture, grant, callback or read dispatch occurs here. */
export function installedReadCatalog(): InstalledReadCatalog {
  const implementationDigest = installedImplementationDigest();
  const operation = (ids: ReadIds) =>
    installed({
      identity: ids.operation,
      owner: 'agent-composition-system',
      handler: ids.handler,
      implementationDigest,
      input: ids.input,
      output: ids.output,
      effects: ['read' as const],
      recovery: 'repeatable' as const,
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      preflight: 'captured-workspace' as const,
    });
  return {
    validators: {
      [INSTALLED_READ.input]: installed({ schema: inputSchema }),
      [INSTALLED_READ.output]: installed({ schema: outputSchema }),
      [INSTALLED_READ_LEGACY.input]: installed({ schema: inputSchema }),
      [INSTALLED_READ_LEGACY.output]: installed({ schema: outputSchema }),
    },
    operations: {
      [INSTALLED_READ.implementation]: operation(INSTALLED_READ),
      [INSTALLED_READ_LEGACY.implementation]: operation(INSTALLED_READ_LEGACY),
    },
  };
}
export interface InstalledReadOptions {
  readonly manifest: Manifest;
  readonly compiled: CompiledHarness;
  readonly catalog: CompositionCatalog;
  readonly principal: string;
  /** Host supplies fresh captured native bytes. This never supplies executable code or authority. */
  readonly currentCapture: () => Capture | Promise<Capture>;
}
function denied(message: string): never {
  throw new SessionError('IA-INSTALLED-READ-DENIED', message);
}

/** Bind one statically imported captured read to an exact compiled/installed executable closure. */
export function installedReadAdapters(
  input: Capture,
  options: InstalledReadOptions,
): { operations: Readonly<Record<string, OperationAdapter>>; close(): void } {
  const capture = verifyCapture(input),
    manifest = copy(options.manifest),
    compiled = copy(options.compiled),
    catalog = copy(options.catalog);
  const principal = options.principal,
    currentCapture = options.currentCapture;
  if (
    !principal ||
    typeof currentCapture !== 'function' ||
    manifestDigest(manifest) !== manifest.digest ||
    manifest.sourceDigest !== capture.revision
  )
    denied('Host manifest, principal or capture binding is unavailable');
  const expected = executionManifest(compiled, catalog);
  if (digest(expected) !== digest(manifest) || !manifest.operations[INSTALLED_READ.operation])
    denied('Manifest differs from the retained compiled closure');
  const rebuilt = compileHarness(capture, {
    harness: compiled.id,
    entry: compiled.entry.binding,
    catalog,
    aliases: compiledAliases(compiled),
  });
  if (!rebuilt.ok || rebuilt.manifest.digest !== compiled.digest)
    denied('Compiled closure differs from the retained native capture');
  const handlers: string[] = [INSTALLED_READ.handler, INSTALLED_READ_LEGACY.handler];
  if (
    Object.values(manifest.operations).some(
      (operation) => handlers.includes(operation.handler) && operation.id !== INSTALLED_READ.operation,
    )
  )
    denied('The fixed read handler cannot alias another operation');
  // The harness pinned the plain entry or, when compiled before names stopped carrying a version, the original one.
  const selected = [INSTALLED_READ, INSTALLED_READ_LEGACY].filter((candidate) =>
    compiled.provenance.installed.some((pin) => pin.group === 'operations' && pin.id === candidate.implementation),
  );
  if (selected.length !== 1 || manifest.operations[INSTALLED_READ.operation]?.handler !== selected[0]!.handler)
    denied('Compiled installed read pin is unavailable');
  const ids = selected[0]!;
  const checkInstalled = (): void => {
    const current = installedReadCatalog();
    for (const id of [ids.input, ids.output])
      if (canonical(catalog.validators[id] ?? null) !== canonical(current.validators[id]))
        denied('Installed read validator changed');
    if (canonical(catalog.operations[ids.implementation] ?? null) !== canonical(current.operations[ids.implementation]))
      denied('Installed read contract or implementation bytes changed');
    if (
      !compiled.provenance.installed.some(
        (pin) =>
          pin.group === 'operations' &&
          pin.id === ids.implementation &&
          pin.digest === current.operations[ids.implementation]!.digest,
      )
    )
      denied('Compiled installed read pin is unavailable');
  };
  checkInstalled();
  const readers = Object.values(manifest.profiles).filter((profile) =>
    profile.operations.includes(INSTALLED_READ.operation),
  );
  const corpus = new Corpus(capture);
  let closed = false;
  const authorize = async (context: OperationContext): Promise<void> => {
    const check = (): void => {
      context.signal.throwIfAborted();
      if (
        closed ||
        typeof context.assertCurrent !== 'function' ||
        context.principal !== principal ||
        context.grant == null ||
        context.grant.principal !== principal ||
        digest(context.manifest) !== digest(manifest) ||
        manifestDigest(context.manifest) !== manifest.digest ||
        context.grant.workspace !== manifest.workspace ||
        context.grant.expiresAt <= Date.now() ||
        context.grant.limits.deadline <= Date.now() ||
        !readers.some(
          (profile) =>
            context.grant.profiles.includes(profile.id) &&
            (context.agent === undefined || context.agent === profile.agent),
        ) ||
        !context.grant.operations.includes(INSTALLED_READ.operation) ||
        !context.grant.effects.includes('read') ||
        !context.grant.sources.includes(capture.revision)
      )
        denied('Read exceeds current host authority');
    };
    check();
    await context.assertCurrent!();
    check();
    // Host callback failures retain their identity; only capture verification is normalized.
    const selectedCapture = await currentCapture();
    context.signal.throwIfAborted();
    let revision: string;
    try {
      revision = verifyCapture(selectedCapture).revision;
    } catch {
      context.signal.throwIfAborted();
      denied('Captured native source verification failed');
    }
    if (revision !== capture.revision) denied('Captured native source selection changed');
    check();
    checkInstalled();
  };
  const adapter = (id: string): OperationAdapter => ({
    id,
    execute: async (args, context) => {
      // Snapshot once before awaits; caller mutation cannot redirect an authorized read.
      const selected = copy(args);
      if (!validateShape(inputSchema, selected) || Buffer.byteLength(canonical(selected)) > 4096)
        denied('Read arguments differ from the fixed schema');
      await authorize(context);
      const value = selected as { path: string; start?: number; limit?: number };
      const result = await corpus.adapter.execute({ ...value, operation: 'read' }, context);
      if (
        result.effect !== 'none' ||
        !validateShape(outputSchema, result.output) ||
        Buffer.byteLength(canonical(result.output)) > 65536
      )
        denied('Captured read exceeds the fixed output contract');
      await authorize(context);
      return result;
    },
  });
  return {
    // Both keys dispatch the same read: a manifest pinned before the rename names the old handler.
    operations: Object.freeze({
      [INSTALLED_READ.handler]: adapter(INSTALLED_READ.handler),
      [INSTALLED_READ_LEGACY.handler]: adapter(INSTALLED_READ_LEGACY.handler),
    }),
    close: () => {
      closed = true;
      corpus.close();
    },
  };
}
