export interface PublicContentPolicy {
  format: 'ia.public-content-policy.v1';
  packageNames: { root: string; name: string }[];
  embeddedCarriers: { owner: string; memberPrefix: string }[];
  exceptions: { path: string; rule: string; valueSha256: string; normalizedSha256: string }[];
}
export type ContentOutputs = ReadonlyMap<string, { bytes: string | Uint8Array }>;
export interface SourceContentPolicy {
  packageNames: { root: string; name: string }[];
  leakExceptions: { path: string; rule: string; value: string }[];
  embeddedCarriers?: { owner: string; memberPrefix: string }[];
  namespace?: { source: string; public: string };
}
export declare function projectContentPolicy(
  policy: SourceContentPolicy,
  outputs?: ContentOutputs,
): PublicContentPolicy;
export declare function validateContentPolicy(policy: unknown): void;
export declare function contentFindings(
  outputs: ContentOutputs,
  policy: PublicContentPolicy,
): { path: string; rule: string; value: string; line: number }[];
export declare function scanContent(outputs: ContentOutputs, policy: PublicContentPolicy): void;
