export interface Positioned {
  /** 1-based source line of the token's first character; correct on list continuation lines the scanner joined with `\n`. */
  readonly line: number;
  /** 1-based UTF-16 code-unit offset within that line's content as the scanner presents it (first-line indentation removed, list continuation lines trimmed). */
  readonly column: number;
}

export type Token =
  | (Positioned & { readonly kind: 'word'; readonly value: string })
  | (Positioned & { readonly kind: 'sigil'; readonly value: string })
  /** `raw` is the slice of the logical line's text including both delimiters, with CRLF already normalized to LF. */
  | (Positioned & { readonly kind: 'string'; readonly value: string; readonly raw: string })
  | (Positioned & { readonly kind: 'prose'; readonly value: string; readonly raw: string })
  | (Positioned & { readonly kind: 'list-open' })
  | (Positioned & { readonly kind: 'list-sep' })
  | (Positioned & { readonly kind: 'list-close' });

/** Stream-level tokens the scanner adds around each logical line. */
export type StreamToken =
  | Token
  | { readonly kind: 'pragma'; readonly version: string; readonly line: number }
  | { readonly kind: 'indent'; readonly line: number }
  | { readonly kind: 'dedent'; readonly line: number }
  | { readonly kind: 'newline'; readonly line: number; readonly endLine: number; readonly depth: number }
  | { readonly kind: 'comment'; readonly line: number; readonly text: string; readonly trailing: boolean };
