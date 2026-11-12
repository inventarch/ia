export type Row = {
  tree: string;
  command: string;
  outputs: 'equal' | 'differ' | 'missing' | 'tree differs';
  wallMsBefore?: number | null;
  wallMsAfter?: number | null;
  maxRssMBBefore?: number | null;
  maxRssMBAfter?: number | null;
  slower?: boolean;
  larger?: boolean;
};
export function compare(
  before: Map<string, unknown>,
  after: Map<string, unknown>,
  options?: { outputsOnly?: boolean; slower?: number; larger?: number },
): { rows: Row[]; failed: number };
export function markdown(result: { rows: Row[] }, options?: { outputsOnly?: boolean }): string;
