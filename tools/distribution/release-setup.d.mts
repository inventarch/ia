export declare const BOOTSTRAP_VERSION: string;
export declare const BOOTSTRAP_TAG: string;
export declare function pinnedNpm(
  override: string | undefined,
  node: string,
  options?: { install?: (prefix: string) => unknown },
): { cli: string; dispose: () => void };
export declare function npmEngineSupported(version: string): boolean;
export declare function compatibleNodeVersions(names: readonly string[]): string[];
export declare function declaresPermissions(workflowText: string): boolean;
export declare function trustArgs(name: string): string[];
export type TrustState = 'configured' | 'missing' | 'different' | 'unknown';
export declare function trustState(listing: string): { state: TrustState; config?: unknown };
export declare function bootstrapManifest(name: string): {
  name: string;
  version: string;
  description: string;
  license: string;
  repository: { type: string; url: string };
};
export declare function npmSetupPlan(
  names: readonly string[],
  state: Record<string, NpmState>,
  bootstrapNames?: readonly string[],
): SetupPlan[];
export type Stage = { id: string; packageName: string; version: string; status: string };
export type Stages = { state: 'known' | 'unknown'; items: Stage[] };
export type NpmState = {
  access: 'public' | 'non-public' | 'not-found' | 'unknown';
  metadata: 'present' | 'not-found' | 'unknown';
  public: 'present' | 'not-found' | 'unknown';
  stages: Stages;
  trust: { state: TrustState | 'not-found'; config?: unknown };
  errors: string[];
};
export type SetupPlan = NpmState & {
  name: string;
  existence: 'existing' | 'unconfirmed';
  actions: ('bootstrap' | 'trust')[];
  blocked: string[];
  ready: boolean;
};
export type NpmCommand = (args: string[], options?: object) => string;
export type PublicLookup = (name: string) => Promise<unknown>;
export type MetadataLookup = (name: string) => string | Promise<string>;
export declare function interactiveTrustResult(result: {
  status: number | null;
  signal?: string | null;
  error?: unknown;
  output?: readonly (string | Buffer | null)[];
}): string;
export declare function npmWithInteractiveAuth(
  npm: NpmCommand,
  recoverTrust: (name: string) => string,
  options?: { enabled?: boolean; stdinIsTTY?: boolean; stdoutIsTTY?: boolean; log?: (message: string) => void },
): NpmCommand;
export declare function accessState(listing: string, name: string): NpmState['access'];
export declare function stageState(listing: string, name: string): Stages;
export declare function inspectNpm(
  npm: NpmCommand,
  names: readonly string[],
  readPublic?: PublicLookup,
  readMetadata?: MetadataLookup,
): Promise<Record<string, NpmState>>;
export declare function applyNpm(
  npm: NpmCommand,
  names: readonly string[],
  options?: {
    bootstrapNames?: readonly string[];
    readPublic?: PublicLookup;
    readMetadata?: MetadataLookup;
    log?: (message: string) => void;
  },
): Promise<SetupPlan[]>;
export declare function githubSetupPlan(
  state: {
    environment: { reviewers: string[]; branches: string[] } | null;
    workflow: { can_approve_pull_request_reviews?: boolean; default_workflow_permissions?: string } | null;
    rulesets: string[];
  },
  rulesets: readonly string[],
  options?: { everyWorkflowDeclaresPermissions?: boolean },
): { setting: string; fix: string }[];
export declare function bootstrapStageId(listing: string, name: string): string | null;
