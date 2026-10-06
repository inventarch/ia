export declare function releaseInputs(
  root: string,
  version: string,
  runnerTemp: string,
): { notesFile: string; assets: string[] };

export declare function githubRelease(
  options: {
    repository: string;
    version: string;
    sha: string;
    token: string;
    notesFile: string;
    assets: string[];
  },
  dependencies?: {
    request?: typeof fetch;
    run?: (file: string, args: string[], options: { stdio: 'inherit'; windowsHide: true }) => unknown;
  },
): Promise<{ tag: string; tagCreated: boolean; releaseCreated: boolean }>;
