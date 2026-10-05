import { manifestDigest, validateShape } from '@inventarch/agent-system';
import type { Manifest, OperationAdapter, OperationContext } from '@inventarch/agent-system';
import { canonical, copy, digest, SessionError } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import { installed } from './catalog.js';
import type { CompositionCatalog } from './catalog.js';
import type { CompiledHarness } from './compiled.js';
import { compileHarness } from './compile.js';
import { Corpus, verifyCapture } from './corpus.js';
import type { Capture } from './corpus.js';
import { executionManifest } from './execution.js';
import { installedImplementationDigest } from './installed-catalog.js';

/** Fixed first-party identities. Native/model inputs never select a module or handler. */
export const INSTALLED_READ = Object.freeze({
  operation: 'authoring-system/binding/operation/read-captured-source',
  implementation: 'captured-source-read-v1',
  handler: 'ia.captured-source.read.v1',
  input: 'captured-source-read-input-v1',
  output: 'captured-source-read-output-v1',
});
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

/** Installed descriptions only. No capture, grant, callback or read dispatch occurs here. */
export function installedReadCatalog(): InstalledReadCatalog {
  return {
    validators: {
      [INSTALLED_READ.input]: installed({ schema: inputSchema }),
      [INSTALLED_READ.output]: installed({ schema: outputSchema }),
    },
    operations: {
      [INSTALLED_READ.implementation]: installed({
        identity: INSTALLED_READ.operation,
        owner: 'agent-composition-system',
        handler: INSTALLED_READ.handler,
        implementationDigest: installedImplementationDigest(),
        input: INSTALLED_READ.input,
        output: INSTALLED_READ.output,
        effects: ['read'],
        recovery: 'repeatable',
        timeoutMs: 10000,
        maxOutputBytes: 65536,
        preflight: 'captured-workspace',
      }),
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
  const rebuilt = compileHarness(capture, { harness: compiled.id, entry: compiled.entry.binding, catalog });
  if (!rebuilt.ok || rebuilt.manifest.digest !== compiled.digest)
    denied('Compiled closure differs from the retained native capture');
  if (
    Object.values(manifest.operations).some(
      (operation) => operation.handler === INSTALLED_READ.handler && operation.id !== INSTALLED_READ.operation,
    )
  )
    denied('The fixed read handler cannot alias another operation');
  const checkInstalled = (): void => {
    const current = installedReadCatalog();
    for (const id of [INSTALLED_READ.input, INSTALLED_READ.output])
      if (canonical(catalog.validators[id] ?? null) !== canonical(current.validators[id]))
        denied('Installed read validator changed');
    if (
      canonical(catalog.operations[INSTALLED_READ.implementation] ?? null) !==
      canonical(current.operations[INSTALLED_READ.implementation])
    )
      denied('Installed read contract or implementation bytes changed');
    if (
      !compiled.provenance.installed.some(
        (pin) =>
          pin.group === 'operations' &&
          pin.id === INSTALLED_READ.implementation &&
          pin.digest === current.operations[INSTALLED_READ.implementation]!.digest,
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
    if (verifyCapture(await currentCapture()).revision !== capture.revision)
      denied('Captured native source selection changed');
    check();
    checkInstalled();
  };
  const adapter: OperationAdapter = {
    id: INSTALLED_READ.handler,
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
  };
  return {
    operations: Object.freeze({ [adapter.id]: adapter }),
    close: () => {
      closed = true;
      corpus.close();
    },
  };
}
