import { canonicalPath } from '../../packages/language/src/index.js';
import type { CompiledRecord } from '../../packages/language/src/index.js';

export interface ArchitectureFinding {
  readonly code: 'IA-NATIVE-EXAMPLE-PLACEMENT' | 'IA-NATIVE-WORK-PLACEMENT';
  readonly severity: 'error';
  readonly identity: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

const WORK_INSTANCES = new Set(['plan', 'milestone', 'task', 'decision', 'spec']);

/** This repository's library boundary; it is deliberately separate from generic IA admission. */
export function checkRepositoryArchitecture(records: readonly CompiledRecord[]): readonly ArchitectureFinding[] {
  const findings: ArchitectureFinding[] = [];
  for (const record of records) {
    const path = canonicalPath(record.source.path).toLowerCase();
    const location = {
      identity: record.identity,
      path: record.source.path,
      line: record.source.line,
      severity: 'error' as const,
    };
    if (path.startsWith('.ia/src/') && /^(?:example|minimal)-/.test(record.name))
      findings.push({
        ...location,
        code: 'IA-NATIVE-EXAMPLE-PLACEMENT',
        message:
          'Neutral examples belong in examples/public-language and its explicit test corpus, outside the live repository records.',
      });
    if (path.startsWith('.ia/src/systems/') && WORK_INSTANCES.has(record.discriminator))
      findings.push({
        ...location,
        code: 'IA-NATIVE-WORK-PLACEMENT',
        message:
          'Repository plans, milestones, tasks, decisions and specifications belong in workspace-authored records, outside reusable vocabulary system payloads.',
      });
  }
  return findings;
}
