import { createHash } from 'node:crypto';
import { stableSerialize } from '@inventarch/graph';

/** The companions a fixture of this clause and mode may have, besides its `.ia` source. */
export function companionSuffixes(clause: string, mode: 'pass' | 'fail'): readonly string[] {
  const allowed = mode === 'pass' ? ['.ast.json', '.records.json', '.pool.json'] : ['.diagnostics.json', '.pool.json'];
  if (clause === 'format') allowed.push(mode === 'pass' ? '.formatted.txt' : '.candidate.txt');
  return allowed;
}
export interface InventoryFixture {
  /** `<clause>/<mode>/<stem>.ia` under the package's `fixtures/language`. */
  readonly path: string;
  readonly clause: string;
  readonly mode: 'pass' | 'fail';
  /** The sha256 of each of the fixture's files by suffix, `.ia` included. */
  readonly files: Readonly<Record<string, string>>;
}
/** A suite the profile does not run, the reason, and the codes only it observes. */
export interface OutOfProfileSuite {
  readonly suite: 'HOOK' | 'RUNTIME' | 'escalation' | 'EXEC' | 'PUBLICATION';
  readonly reason: string;
  readonly codes: readonly string[];
}
/** The conformance profile id carries no version. `package-v1` is the original spelling, accepted for compatibility. */
export const CONFORMANCE_PROFILE = 'package' as const;
export type ConformanceProfile = typeof CONFORMANCE_PROFILE | 'package-v1';
export function isConformanceProfile(value: unknown): value is ConformanceProfile {
  return value === CONFORMANCE_PROFILE || value === 'package-v1';
}
export interface ConformanceInventory {
  readonly profile: ConformanceProfile;
  readonly fixtures: readonly InventoryFixture[];
  /** The conformance corpus the boundary suites run over, as `KERNEL_SOURCES` carries the floor. */
  readonly corpus: readonly { readonly path: string; readonly text: string }[];
  /** The system folders of the corpus. */
  readonly folders: readonly string[];
  /** The scope of every boundary case of the refusal and evidence suites. */
  readonly boundaries: readonly string[];
  /** The codes a passing failing case must observe: every LANG, GRAPH, COMP and EVIDENCE code. */
  readonly requiredCodes: readonly string[];
  readonly outOfProfile: readonly OutOfProfileSuite[];
}
export const fileDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** The digest an inventory is pinned by: sha256 over its stable serialization. */
export function inventoryDigest(inventory: ConformanceInventory): string {
  return createHash('sha256').update(stableSerialize(inventory)).digest('hex');
}
