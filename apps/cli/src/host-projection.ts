/**
 * Host registration spec §6: a workspace's projection for one host, rendered from its own admitted records.
 *
 * docs/specs/host-registration/README.md §6.1 makes the renderer a pure function in `@ia/compliance`;
 * this module is the composition root that feeds it — the admitted records, their revision-bound membership, the
 * launcher modes from `@ia/distribution/host-modes`, the installed lock's packages and the nine legacy operations.
 * One function feeds `ia host` and, in later tasks, `ia doctor`'s drift rows and the install/update/remove refresh,
 * so no two of them can disagree about what the projection should contain.
 */
import { systemMember } from '@ia/db';
import type { ProjectionMembership } from '@ia/compliance';
import { renderWorkspaceProjection } from '@ia/compliance';
import { HOST_MODES, launcherInvocation } from '@ia/distribution/host-modes';
import { readInstalledState } from '@ia/distribution/services';
import type { WorkspaceHost } from '@ia/distribution/hosts';
import { LEGACY_OPERATIONS } from './commands.js';
import { Refusal } from './consumer.js';
import type { Session } from './session.js';
import { openSession } from './session.js';

export type HostName = WorkspaceHost;
export interface Artifact {
  readonly path: string;
  readonly text: string;
}

/**
 * §4: the target must admit — zero error findings — before anything is rendered or registered. The refusal is the
 * CLI's own classification of the target, so it is IA-CLI-CONFLICT and names the command that shows the findings.
 */
function requireAdmitted(session: Session, root: string): void {
  if (session.admission().status !== 'admitted')
    throw new Refusal(
      'IA-CLI-CONFLICT',
      'The workspace does not admit; host registration needs a workspace with zero error findings',
      3,
      { path: root },
      'Run "ia validate" and fix the reported errors.',
    );
}
/** §4's admission gate alone, for a removal, which renders nothing. */
export function checkAdmitted(root: string): void {
  const session = openSession(root);
  try {
    requireAdmitted(session, root);
  } finally {
    session.close();
  }
}

/**
 * The same membership `tools/projections/generate.ts` builds for this repository: every admitted source path, with
 * the system folder `@ia/db` recognizes it under, authored or installed. The renderer refuses a membership that does
 * not cover every record, so nothing here filters.
 */
function membershipOf(session: Session): ProjectionMembership {
  const records = session.reader.records(),
    revision = session.reader.revision;
  return {
    revision,
    members: [...new Set(records.map((record) => record.source.path))].sort().map((path) => {
      const member = systemMember(path);
      return { path, system: member?.name ?? null, root: member?.root ?? null };
    }),
  };
}

/** §6.1. Artifacts carry the `ia host` marker line; `@ia/distribution/projection` refuses any that does not. */
export function renderProjectionFor(root: string, host: HostName): readonly Artifact[] {
  const session = openSession(root);
  try {
    requireAdmitted(session, root);
    const records = session.reader.records(),
      revision = session.reader.revision;
    const lock = readInstalledState({ root }).lock;
    const rendered = renderWorkspaceProjection(records, revision, membershipOf(session), {
      host,
      modes: HOST_MODES.map((row) => ({ invocation: launcherInvocation(row), meaning: row.meaning })),
      distributions: (lock?.packages ?? []).map((pkg) => ({ id: pkg.id, version: pkg.version })),
      operations: [...LEGACY_OPERATIONS],
    });
    // Contract §4.1 lists IA-COMP-* as finding codes. This is a CLI refusal carrying the renderer's finding code
    // unchanged, because the renderer's assessment is the only thing that knows why the projection cannot exist.
    if (rendered.assessment.outcome !== 'pass')
      throw new Refusal(
        'IA-COMP-PROJECTION-INVALID',
        rendered.assessment.findings.map((finding) => finding.message).join('; '),
        3,
        { path: root },
        'Run "ia validate" and "ia inspect" to check each system\'s steward declaration.',
      );
    return rendered.artifacts;
  } finally {
    session.close();
  }
}
