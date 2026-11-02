import { createHash } from 'node:crypto';

/**
 * The method packet and its canonical digest. The digest covers what the agent acts on (closure, scope, instructions,
 * references, role, requested operations, evidence and effective operations), serialized with sorted keys; the
 * envelope (host, CLI, kit root, latency) and the binding are excluded, so one resolution digests the same everywhere.
 */
export const PACKET_CONTRACT = 1;
export const EVIDENCE_STATES = ['proposed', 'attempted', 'executed', 'verified', 'accepted'] as const;
export const DIGESTED = [
  'closure',
  'scope',
  'instructions',
  'references',
  'role',
  'requestedOperations',
  'evidence',
  'effectiveOperations',
] as const;

/** JSON with every object's keys sorted, recursively; undefined members dropped. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map((v) => canonical(v === undefined ? null : v)).join(',') + ']';
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(record[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function packetDigest(packet: Readonly<Record<string, unknown>>): string {
  const subject: Record<string, unknown> = {};
  for (const key of DIGESTED) subject[key] = packet[key] ?? null;
  return createHash('sha256').update(canonical(subject)).digest('hex');
}

export interface MethodPacket {
  contract: number;
  resolver: string;
  binding: unknown;
  closure: unknown;
  scope: unknown;
  instructions: readonly unknown[];
  references: readonly unknown[];
  role: unknown;
  requestedOperations: readonly unknown[];
  effectiveOperations: { readonly status: 'host-determined'; readonly runner: readonly string[] };
  missing: readonly unknown[];
  evidence: { readonly required: readonly string[]; readonly states: readonly string[] };
  kitUpdateAvailable: unknown;
  envelope: Record<string, unknown>;
  digest?: string;
}

/** Assembles a packet and stamps its digest; `required` is the capability's checks, the runner's by default. */
export function assemblePacket(parts: {
  readonly resolver: string;
  readonly binding: unknown;
  readonly closure: unknown;
  readonly scope: unknown;
  readonly instructions: readonly unknown[];
  readonly references: readonly unknown[];
  readonly role: unknown;
  readonly requestedOperations: readonly unknown[];
  readonly runner: readonly string[];
  readonly required?: readonly string[];
  readonly missing: readonly unknown[];
  readonly envelope: Record<string, unknown>;
  readonly kitUpdateAvailable?: unknown;
}): MethodPacket {
  const packet: MethodPacket = {
    contract: PACKET_CONTRACT,
    resolver: parts.resolver,
    binding: parts.binding,
    closure: parts.closure,
    scope: parts.scope,
    instructions: parts.instructions,
    references: parts.references,
    role: parts.role,
    requestedOperations: parts.requestedOperations,
    effectiveOperations: { status: 'host-determined', runner: parts.runner },
    missing: parts.missing,
    evidence: { required: parts.required ?? parts.runner, states: EVIDENCE_STATES },
    kitUpdateAvailable: parts.kitUpdateAvailable ?? null,
    envelope: parts.envelope,
  };
  packet.digest = packetDigest(packet as unknown as Record<string, unknown>);
  return packet;
}
