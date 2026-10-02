export interface DocumentEntry {
  id: string;
  path: string;
  profile: string;
  genre: string;
  title: string;
  status: string | null;
  sourceDigest: string;
  metadata: Record<string, unknown>;
}
export function discoverDocuments(root: string): { documents: DocumentEntry[]; findings: string[] };
export function checkStructure(
  root: string,
  options?: { generated?: boolean },
): { documents: number; findings: string[] };
export function generateCatalog(root: string): { documents: number };
export function checkDocumentationLinks(
  root: string,
  files: string[],
): { files: number; links: number; findings: string[] };
export function markdownFiles(root: string, directory?: string): string[];
export function headingIds(text: string): Set<string>;
export function readRedirects(root: string): Map<string, string>;
export function redirectText(from: string, to: string): string;
