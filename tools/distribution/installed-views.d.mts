export declare function qualifyInit(envelope: unknown, workspace: string): string[];
export declare function qualifyInstalledViews(
  cli: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  workspace: string,
): string[];
