import { digest } from './codec.js';

/** The tag inside every per-record digest; a new definition takes a new tag, never a new meaning for this one. */
export const RECORD_DIGEST_FORMAT = 'ia-record-1';

/**
 * The per-record digest (G13): SHA-256 of `{format: 'ia-record-1', text}` in the canonical codec, where `text` is the
 * record's own source lines `line..endLine` with a leading byte-order mark dropped, CRLF folded to LF and the lines
 * joined by LF. It moves when that record's text changes and with nothing else: lines added above it, other files,
 * placement and resolved targets leave it alone. A nested record sits inside its parent's lines, so editing the child
 * also moves the parent. Lines past the end of the text contribute nothing.
 */
export function recordDigest(text: string, span: { readonly line: number; readonly endLine: number }): string {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  return digest({ format: RECORD_DIGEST_FORMAT, text: lines.slice(span.line - 1, span.endLine).join('\n') });
}
