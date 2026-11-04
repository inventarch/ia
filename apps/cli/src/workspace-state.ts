/**
 * What a folder is, as `ia host` and `ia project` ask it. Two questions, kept apart so each caller says which it means:
 * whether the folder has workspace sources (`hasWorkspaceSource`, what the host and projection guard tests), and whether
 * it ships a package (`shipsPackage`, what a release descriptor means). A workspace that admits and ships no package is
 * set up fully: it has sources and no descriptor.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Refusal } from './consumer.js';
import type { Session } from './session.js';
import { openSession } from './session.js';

/** The descriptor a workspace that ships a package carries. */
export const DESCRIPTOR_FILE = '.ia/release.json';

/** True when the folder holds workspace sources. */
export const hasWorkspaceSource = (root: string): boolean => existsSync(resolve(root, '.ia/src'));
/** True when the folder carries a release descriptor, that is, it ships a package. */
export const shipsPackage = (root: string): boolean => existsSync(resolve(root, DESCRIPTOR_FILE));

/**
 * The target must admit, with zero error findings, before anything is rendered or registered. The refusal is the CLI's
 * own classification of the target, so it is IA-CLI-CONFLICT and names the command that shows the findings.
 */
export function requireAdmitted(session: Session, root: string): void {
  if (session.admission().status !== 'admitted')
    throw new Refusal(
      'IA-CLI-CONFLICT',
      'The workspace does not admit; host registration needs a workspace with zero error findings',
      3,
      { path: root },
      'Run "ia validate" and fix the reported errors.',
    );
}
/** Opens the workspace as every renderer does and refuses it unless it admits; nothing is read from it beyond that. */
export function requireAdmittedWorkspace(root: string): void {
  const session = openSession(root);
  try {
    requireAdmitted(session, root);
  } finally {
    session.close();
  }
}
