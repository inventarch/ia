import type { execFileSync } from 'node:child_process';

export declare function githubRelease(
  options: {
    repository: string;
    version: string;
    sha: string;
    token: string;
    notesFile: string;
    assets: string[];
  },
  dependencies?: { request?: typeof fetch; run?: typeof execFileSync },
): Promise<{ tag: string; tagCreated: boolean; releaseCreated: boolean }>;
