import { manifestDigest } from '@inventarch/agent-system';
import type { Manifest, Profile } from '@inventarch/agent-system';
import { copy, digest } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import type { CompositionCatalog } from './catalog.js';
import { CompositionError } from './compiled.js';
import type { CompiledHarness } from './compiled.js';

/** Explicit P2 bridge. Hosts still verify current executable pins and issue current grants. */
export function executionManifest(compiled: CompiledHarness, catalog: CompositionCatalog): Manifest {
  const { digest: expected, ...body } = compiled;
  const refuse = (message: string): never => {
    throw new CompositionError({ code: 'IA-COMPOSITION-UNAVAILABLE', message });
  };
  if (compiled.format !== 'ia.compiled-harness.v1' || digest(body) !== expected)
    refuse('Compiled harness digest mismatch');
  for (const pin of compiled.provenance.installed) {
    const entry = (
      catalog[pin.group as keyof CompositionCatalog] as
        | Record<string, { version: 1; digest: string; value: unknown }>
        | undefined
    )?.[pin.id];
    if (!entry || entry.digest !== pin.digest || digest({ version: entry.version, value: entry.value }) !== pin.digest)
      refuse(`Installed contract changed: ${pin.group}:${pin.id}`);
  }
  const profiles: Record<string, Profile> = {};
  for (const [id, profile] of Object.entries(compiled.profiles)) {
    profiles[id] = {
      ...copy(profile),
      contract: {
        id: digest(profile),
        ...(profile.review ? { review: copy(profile.review) } : {}),
        ...(profile.requestBytes === undefined ? {} : { requestBytes: profile.requestBytes }),
        mandateContracts: [...profile.mandateContracts],
        inputContracts: copy(profile.inputContracts),
        effects: [...profile.effects],
        limits: copy(profile.limits),
        delegation: copy(profile.delegation),
        checks: profile.checks.map((check) => {
          const evaluator = catalog.evaluators[check];
          if (!evaluator || !evaluator.value.phases.length) return refuse(`Required evaluator unavailable: ${check}`);
          return { id: check, phases: [...evaluator.value.phases] };
        }),
        completionEvaluator: 'ia.completion.v1',
        repairAttempts: 1,
        maxAttempts: 2,
      },
    };
  }
  const executable: Omit<Manifest, 'digest'> = {
    version: 1,
    id: compiled.id,
    workspace: compiled.workspace,
    sourceDigest: compiled.sourceDigest,
    profiles,
    operations: copy(compiled.operations),
    reactions: [],
    provenance: { compiled: copy(compiled) as unknown as Json },
  };
  return { ...executable, digest: manifestDigest(executable) };
}
