export const WORKSPACE: 'synthetic';
export function syntheticFiles(options: { records: number; seed: number }): Record<string, string>;
export function selection(options: { records: number }): {
  format: 'ia.kb.selection.v1';
  sourceId: string;
  records: string[];
  resources: string[];
};
export function generate(options: { cli: string; out: string; records: number; seed: number; git?: boolean }): {
  out: string;
  files: number;
  commit: string | null;
};
