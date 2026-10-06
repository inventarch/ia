import type { PublicPackage } from './npm-release.mjs';
import type { Bump } from './release-notes.mjs';
export interface VersionResult {
  action: 'none' | 'version' | 'amend' | 'refresh';
  state: 'published' | 'prepared';
  version: string;
  previous?: string;
  bump?: Bump;
  baseline?: { commit: string; version: string };
  notes?: string[];
  changeset?: string;
  sha256?: string;
  files?: number;
  pending?: number;
  reason?: string;
}
export declare const EDITOR_MANIFEST: string;
export declare const EDITOR_NOTICES: string;
export declare function versionRelease(
  root: string,
  projects: PublicPackage[],
  options?: {
    write?: boolean;
    registry?: ((name: string, version: string) => Promise<boolean>) | null;
    sealInputs?: boolean;
    refresh?: boolean;
    publishedOnly?: boolean;
  },
): Promise<VersionResult>;
export declare function pullRequestBody(root: string, result: VersionResult): string;
