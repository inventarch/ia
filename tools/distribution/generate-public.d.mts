// Types for generate-public.mjs, so tsconfig.tools.json can check its test.
export declare function publicOutputs(
  root?: string,
  read?: (path: string) => string | null,
): { generated: Map<string, string>; stale: [string, string][] };
