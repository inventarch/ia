export function unexpectedExits(
  expect: Record<string, number> | undefined,
  result: { outputs: Record<string, { exit: number }>; skipped: string[] },
): string[];
export function build(
  tree: { name: string; kind: string; [key: string]: unknown },
  options: { initCli: string; work: string; repository?: string },
): string;
