export declare const BOOTSTRAP_VERSION: string;
export declare const BOOTSTRAP_TAG: string;
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
  state: Record<string, { exists: boolean; trust: string }>,
): { name: string; exists: boolean; trust: string; actions: ('bootstrap' | 'trust')[] }[];
export declare function githubSetupPlan(
  state: {
    environment: { reviewers: string[]; branches: string[] } | null;
    workflow: { can_approve_pull_request_reviews?: boolean; default_workflow_permissions?: string } | null;
    rulesets: string[];
  },
  rulesets: readonly string[],
  options?: { everyWorkflowDeclaresPermissions?: boolean },
): { setting: string; fix: string }[];
export declare function bootstrapStageId(listing: string): string | null;
