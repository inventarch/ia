import { createHash } from 'node:crypto';
import { verifyFixtures, verifyKernel } from '@inventarch/compliance';
import type { ConformanceOptions, FixtureEvidence, KernelEvidence } from '@inventarch/compliance';
import type { RevisionInputs } from '@inventarch/graph';
import { canonicalPath } from '@inventarch/language';

/** How many floors' kernel evidence a process keeps: an editor that edits its local floor verifies each new one. */
const KERNEL_FLOORS = 16;
/** The package-v1 fixture evidence: the profile runs only the package's own files, so one run serves the process. */
let fixtures: FixtureEvidence | undefined;
/** Kernel evidence by the exact floor it verified, least recently used first. */
const kernels = new Map<string, KernelEvidence>();
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * D10: the conformance evidence compliance binds to the graph `inputs` load (C31). The fixture profile runs once per
 * process and the kernel once per floor, the sources at a `.ia/src/floor/` path and at floor placement, as the binding
 * reads the floor; evidence the producer could not evaluate is not kept, so a later read runs it again.
 */
export function conformanceOf(inputs: RevisionInputs): ConformanceOptions {
  const floor = inputs.sources
    .filter(
      (source) => source.location.placement.kind === 'floor' && canonicalPath(source.path).startsWith('.ia/src/floor/'),
    )
    .map((source) => ({ path: canonicalPath(source.path), text: source.text }))
    .sort((a, b) => compare(a.path, b.path));
  const key = createHash('sha256').update(JSON.stringify(floor)).digest('hex');
  let kernel = kernels.get(key);
  if (kernel === undefined) {
    kernel = verifyKernel(floor);
    if (kernel.assessment.outcome !== 'not-evaluated') kernels.set(key, kernel);
    if (kernels.size > KERNEL_FLOORS) kernels.delete(kernels.keys().next().value!);
  } else {
    kernels.delete(key);
    kernels.set(key, kernel);
  }
  let run = fixtures;
  if (run === undefined) {
    run = verifyFixtures();
    if (run.assessment.outcome !== 'not-evaluated') fixtures = run;
  }
  return { inputs, kernel, fixtures: run };
}
