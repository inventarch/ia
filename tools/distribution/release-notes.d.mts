import type { PublicPackage } from './npm-release.mjs';
export type Bump = 'patch' | 'minor' | 'major';
export type NoteBump = 'none' | Bump;
export interface ReleaseNote {
  format: string;
  bump: NoteBump;
  title: string;
  summary: string;
  packages: string[];
  paths: string[];
}
export declare const PENDING: string;
export declare const NOTE_FORMAT: string;
export declare const BUMPS: readonly Bump[];
export declare const NOTE_BUMPS: readonly NoteBump[];
export declare const GENERATED_CHANGES: readonly string[];
export declare const RELEASE_MANAGED: readonly string[];
export declare function bumpVersion(version: string, bump: Bump): string;
export declare function maxBump(bumps: readonly Bump[]): Bump;
export declare function releaseBump(from: string, to: string): Bump;
export declare function inferBump(messages: readonly string[]): Bump | null;
export declare function packageOwner(projects: readonly PublicPackage[], path: string): string | null;
export declare function releaseManaged(path: string): boolean;
export declare function validateNote(id: string, note: unknown, names: readonly string[]): ReleaseNote;
export declare function pendingNotes(
  root: string,
  names: readonly string[],
): { id: string; path: string; note: ReleaseNote }[];
export declare function notePaths(
  projects: readonly PublicPackage[],
  packages: readonly string[],
  files: readonly string[],
): string[];
export declare function draftNote(
  root: string,
  projects: readonly PublicPackage[],
  options?: { base?: string; bump?: NoteBump; title?: string; summary?: string; packages?: string[]; paths?: string[] },
): {
  note: ReleaseNote;
  inferred: { bump: boolean; title: boolean; summary: boolean };
  evidence: { mergeBase: string; files: string[]; messages: string[] };
};
export declare function writeNote(root: string, names: readonly string[], note: ReleaseNote, id?: string): string;
