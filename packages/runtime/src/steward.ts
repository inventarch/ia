import type { CompiledRecord } from '@inventarch/language';
import { systemMember } from '@inventarch/db';

export const HOOK_CODES = [
  'IA-HOOK-INPUT-INVALID',
  'IA-HOOK-PATH-UNSAFE',
  'IA-HOOK-STEWARD-UNAVAILABLE',
  'IA-HOOK-IDENTITY-UNAVAILABLE',
  'IA-HOOK-NOT-STEWARD',
  'IA-HOOK-PROJECTION-MANAGED',
  'IA-HOOK-SHELL-WRITE',
  'IA-HOOK-SHELL-UNRESOLVED',
] as const;
export type HookCode = (typeof HOOK_CODES)[number];
export type StewardActor = { readonly kind: 'operator' } | { readonly kind: 'agent'; readonly identity: string };
export interface StewardDecision {
  readonly allowed: boolean;
  readonly code?: HookCode;
  readonly message: string;
  readonly steward?: { readonly identity: string; readonly name: string; readonly path: string };
}
/** R13: admitted typed records only; the caller owns actor authentication. */
export function evaluateSteward(
  records: readonly CompiledRecord[],
  system: string,
  actor?: StewardActor,
): StewardDecision {
  const declarations = records.filter(
    (r) =>
      r.discriminator === 'system' &&
      r.name === system &&
      systemMember(r.source.path)?.name === system &&
      r.source.path.endsWith('/system.ia'),
  );
  const folder = declarations.length === 1 ? systemMember(declarations[0]!.source.path)!.root + '/' : '';
  const refs =
    declarations.length === 1 ? declarations[0]!.head.filter((f) => f.key === 'steward').map((f) => f.value) : [];
  const ref = refs.length === 1 ? refs[0] : undefined;
  const agents =
    ref?.kind === 'ref' && ref.discriminator === 'agent' && ref.fragment === undefined
      ? records.filter((r) => r.discriminator === 'agent' && r.name === ref.name && r.source.path.startsWith(folder))
      : [];
  if (agents.length !== 1)
    return Object.freeze({
      allowed: false,
      code: 'IA-HOOK-STEWARD-UNAVAILABLE',
      message: `No unique admitted steward for ${system}`,
    });
  const agent = agents[0]!,
    steward = Object.freeze({ identity: agent.identity, name: agent.name, path: agent.source.path });
  if (actor === undefined)
    return Object.freeze({
      allowed: false,
      code: 'IA-HOOK-IDENTITY-UNAVAILABLE',
      message: `Host identity required; expected ${agent.name}`,
      steward,
    });
  if (actor.kind === 'operator' || actor.identity === agent.identity)
    return Object.freeze({ allowed: true, message: `Authorized steward of ${system}`, steward });
  return Object.freeze({
    allowed: false,
    code: 'IA-HOOK-NOT-STEWARD',
    message: `Only ${agent.name} may author ${system}`,
    steward,
  });
}
