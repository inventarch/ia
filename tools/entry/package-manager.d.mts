/** Select Node for a JavaScript entry or execute a recognized native binary directly; never invoke a shell. */
export declare function packageManagerCommand(
  launcher: string,
  args: readonly string[],
  nodePath?: string,
): { command: string; args: string[] };
