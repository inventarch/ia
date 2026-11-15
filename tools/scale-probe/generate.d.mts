export const WORKSPACE: 'synthetic';
export function syntheticFiles(options: { records: number; seed: number }): Record<string, string>;
export function selection(options: { records: number }): {
  format: 'ia.kb.selection.v1';
  sourceId: string;
  records: string[];
  resources: string[];
};
export function contents(options: { records: number; seed: number; git?: boolean }): {
  init: string[];
  files: Record<string, string>;
  selection: string | null;
  commit: { message: string; env: Record<string, string> } | null;
};
export function gitEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv;
export function generate(options: { cli: string; out: string; records: number; seed: number; git?: boolean }): {
  out: string;
  files: number;
  commit: string | null;
};
