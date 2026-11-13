import { readFileSync } from 'node:fs';
import { KERNEL_DIGEST, KERNEL_SOURCES, LANGUAGE_VERSION } from '@inventarch/language';
import { kernelDigest } from '../kernel.js';
import type { KernelSource } from '../kernel.js';
import type { Assessment } from '../types.js';
import { INVENTORY, INVENTORY_DIGEST } from './inventory.generated.js';
import { writtenConformanceProfile } from './inventory.js';
import type { ConformanceProfile, OutOfProfileSuite } from './inventory.js';
import { kernelAssessment } from './verify-kernel.js';
import { runProfile } from './verify.js';

/** The conformance profile a sandboxed consumer can run itself (C31). */
export { CONFORMANCE_PROFILE, RELEASED_CONFORMANCE_PROFILE, isConformanceProfile } from './inventory.js';
export type { ConformanceProfile } from './inventory.js';
/** The running toolchain an evidence object was produced by. */
export interface ConformanceToolchain {
  readonly languageVersion: string;
  readonly kernelDigest: string;
  readonly compliance: string;
  readonly node: string;
}
export interface KernelEvidence {
  readonly subject: 'COMP-KERNEL';
  readonly profile: ConformanceProfile;
  readonly toolchain: ConformanceToolchain;
  /** `kernelDigest` of the floor this evidence verified. */
  readonly floorDigest: string;
  readonly assessment: Assessment;
}
export interface FixtureEvidence {
  readonly subject: 'COMP-FIXTURES';
  readonly profile: ConformanceProfile;
  readonly toolchain: ConformanceToolchain;
  /** `INVENTORY_DIGEST` of the inventory this evidence ran. */
  readonly inventoryDigest: string;
  /** The codes passing failing cases observed. */
  readonly observedCodes: readonly string[];
  /** The suites the profile does not run, so a pass says nothing about them. */
  readonly outOfProfile: readonly OutOfProfileSuite[];
  readonly assessment: Assessment;
}
export type ConformanceEvidence = KernelEvidence | FixtureEvidence;

/** Evidence this module instance produced, by kind. Copies, clones and hand-built objects are never members. */
const kernels = new WeakSet<object>(),
  fixtureRuns = new WeakSet<object>();
/** True only for evidence verifyKernel or verifyFixtures returned in this module instance, of `subject`'s kind if given. */
export function isConformanceEvidence(value: unknown, subject: 'COMP-KERNEL'): value is KernelEvidence;
export function isConformanceEvidence(value: unknown, subject: 'COMP-FIXTURES'): value is FixtureEvidence;
export function isConformanceEvidence(value: unknown): value is ConformanceEvidence;
export function isConformanceEvidence(value: unknown, subject?: ConformanceEvidence['subject']): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return subject === 'COMP-KERNEL'
    ? kernels.has(value)
    : subject === 'COMP-FIXTURES'
      ? fixtureRuns.has(value)
      : kernels.has(value) || fixtureRuns.has(value);
}

let compliance: string | undefined;
function complianceVersion(): string {
  if (compliance === undefined)
    try {
      const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      compliance =
        manifest.name === '@inventarch/compliance' && typeof manifest.version === 'string'
          ? manifest.version
          : 'unknown';
    } catch {
      compliance = 'unknown';
    }
  return compliance;
}
/** The toolchain this process runs. */
export function runningToolchain(): ConformanceToolchain {
  return Object.freeze({
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    compliance: complianceVersion(),
    node: process.version,
  });
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
function floorOf(floor: unknown): readonly KernelSource[] {
  if (
    !Array.isArray(floor) ||
    floor.some(
      (source) =>
        typeof source !== 'object' ||
        source === null ||
        typeof (source as KernelSource).path !== 'string' ||
        typeof (source as KernelSource).text !== 'string',
    )
  )
    throw new TypeError('A floor is an array of {path, text} sources');
  return (floor as readonly KernelSource[]).map(({ path, text }) => ({ path, text }));
}

/**
 * Verifies COMP-KERNEL in this process: regenerates the kernel from `floor` (the embedded floor by default) and
 * compares it with the running language. The evidence records the digest of the floor it verified.
 */
export function verifyKernel(floor: readonly KernelSource[] = KERNEL_SOURCES): KernelEvidence {
  const sources = floorOf(floor);
  const evidence = freeze<KernelEvidence>({
    subject: 'COMP-KERNEL',
    profile: writtenConformanceProfile(),
    toolchain: runningToolchain(),
    floorDigest: kernelDigest(sources),
    assessment: kernelAssessment(sources),
  });
  kernels.add(evidence);
  return evidence;
}

/**
 * Verifies COMP-FIXTURES in this process for the package profile: runs the language fixtures this package ships
 * against its generated inventory, and the refusal and evidence suites over the conformance corpus it embeds. It reads
 * the package's own fixture files and writes nothing.
 */
export function verifyFixtures(): FixtureEvidence {
  const result = runProfile(INVENTORY, INVENTORY_DIGEST, new URL('../../fixtures/language/', import.meta.url));
  const evidence = freeze<FixtureEvidence>({
    subject: 'COMP-FIXTURES',
    profile: writtenConformanceProfile(),
    toolchain: runningToolchain(),
    inventoryDigest: INVENTORY_DIGEST,
    observedCodes: [...result.observedCodes],
    outOfProfile: INVENTORY.outOfProfile.map((suite) => ({ ...suite, codes: [...suite.codes] })),
    assessment: result.assessment,
  });
  fixtureRuns.add(evidence);
  return evidence;
}
