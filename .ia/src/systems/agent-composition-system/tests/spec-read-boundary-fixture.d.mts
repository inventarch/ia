export interface SpecReadBoundaryResult {
  passed: boolean;
  capture: string;
  compiled: string;
  installedCode: string;
  resources: string;
  body: {
    key: { source: string; revision: string; path: string };
    bytes: number;
    sha256: string;
    mediaType: string;
    encoding: string;
  };
  modelCalls: number;
  dispatches: number;
  paidProviderCalls: number;
  nativeAnchorRead: boolean;
  nativeBodyPathRefused: boolean;
  nativeBodyPathError: string;
  nativeBodyPathAdapterError: { code: string; message: string };
  undisclosedRequiredBodyRefused: boolean;
  disclosedBodyExact: boolean;
  modelSawBodyProse: boolean;
  semanticCoherence: string;
}
export function qualifySpecReadBoundary(
  SDK: typeof import('../src/index.js'),
  nativeRoot: string,
  output: string,
): Promise<SpecReadBoundaryResult>;
