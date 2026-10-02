export interface MarkdownLink {
  href: string;
  kind: 'link' | 'image' | 'definition' | 'html';
  position?: { line: number; column: number; offset?: number };
  attribute?: 'href' | 'src';
  offset?: number;
}
export function parseMarkdown(text: string): { links: MarkdownLink[]; ids: Set<string> };
export function htmlIds(text: string): Set<string>;
export function localTarget(href: string): { pathname: string; fragment: string } | null;
