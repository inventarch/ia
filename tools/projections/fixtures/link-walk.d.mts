export type LinkKind = 'local' | 'external' | 'fragment' | 'unsupported';
export interface ProjectedFile {
  readonly path: string;
  readonly content: string;
}
export type ProjectedLink =
  | { readonly raw: string; readonly kind: 'local'; readonly target: string }
  | { readonly raw: string; readonly kind: Exclude<LinkKind, 'local'> };
export function classifyLink(
  raw: string,
): { readonly kind: 'local'; readonly path: string } | { readonly kind: Exclude<LinkKind, 'local'> };
export function fileLinks(file: ProjectedFile): ProjectedLink[];
export function linkProblems(root: string, files: readonly ProjectedFile[]): string[];
export function linkCounts(files: readonly ProjectedFile[]): Record<LinkKind, number>;
