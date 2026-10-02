import type { Diagnostic } from '../diagnostics.js';
import { logicalLines } from './lines.js';
import type { Trivia } from './lines.js';
import { tokenizeLine } from './tokenize.js';
import type { StreamToken } from './tokens.js';

export type { LogicalLine, Trivia } from './lines.js';
export type { StreamToken, Token } from './tokens.js';
export { tokenizeLine } from './tokenize.js';
export { logicalLines, trailingCommentIndex } from './lines.js';

export interface ScanResult {
  readonly version?: string;
  readonly tokens: readonly StreamToken[];
  readonly trivia: readonly Trivia[];
  readonly diagnostics: readonly Diagnostic[];
}

/** One token stream per file. The parser consumes this and nothing else. */
export function scan(source: string, path: string): ScanResult {
  const lines = logicalLines(source, path);
  const diagnostics: Diagnostic[] = [...lines.diagnostics];
  const tokens: StreamToken[] = [];
  if (lines.version !== undefined) tokens.push({ kind: 'pragma', version: lines.version, line: 1 });

  const comments = lines.trivia.filter((t): t is Extract<Trivia, { kind: 'comment' }> => t.kind === 'comment');
  let commentIndex = 0;
  let depth = 0;
  // The block beneath a line the tokenizer refused produces nothing and is not judged; the comments
  // on its lines are trivia, collected here because no accepted line carries them.
  let dropDeeperThan: number | undefined;
  const dropped: Trivia[] = [];

  const flushCommentsBefore = (line: number): void => {
    while (commentIndex < comments.length && (comments[commentIndex]?.line ?? Infinity) < line) {
      const c = comments[commentIndex]!;
      tokens.push({ kind: 'comment', line: c.line, text: c.text, trailing: false });
      commentIndex++;
    }
  };

  for (const logical of lines.lines) {
    flushCommentsBefore(logical.line);
    if (dropDeeperThan !== undefined) {
      if (logical.depth > dropDeeperThan) {
        // A comment inside a dropped block is trivia at its own line, as it is for a block the line scanner drops.
        if (logical.trailingComment !== undefined) {
          tokens.push({ kind: 'comment', line: logical.endLine, text: logical.trailingComment, trailing: false });
          dropped.push({ kind: 'comment', line: logical.endLine, text: logical.trailingComment });
        }
        continue;
      }
      dropDeeperThan = undefined;
    }
    while (depth < logical.depth) {
      tokens.push({ kind: 'indent', line: logical.line });
      depth++;
    }
    while (depth > logical.depth) {
      tokens.push({ kind: 'dedent', line: logical.line });
      depth--;
    }
    const result = tokenizeLine(logical.text, path, logical.line);
    if (result.diagnostics.length > 0) {
      // A refused line produces nothing: no tokens and no newline, so the parser never sees
      // a partial line and one mistake yields one diagnostic. Its comment is still trivia,
      // and the block beneath it is dropped unjudged.
      diagnostics.push(...result.diagnostics);
      if (logical.trailingComment !== undefined)
        tokens.push({ kind: 'comment', line: logical.endLine, text: logical.trailingComment, trailing: true });
      dropDeeperThan = logical.depth;
      continue;
    }
    tokens.push(...result.tokens);
    if (logical.trailingComment !== undefined)
      tokens.push({ kind: 'comment', line: logical.endLine, text: logical.trailingComment, trailing: true });
    tokens.push({ kind: 'newline', line: logical.line, endLine: logical.endLine, depth: logical.depth });
  }
  flushCommentsBefore(Infinity);
  const last = lines.lines[lines.lines.length - 1];
  while (depth > 0) {
    tokens.push({ kind: 'dedent', line: last?.endLine ?? 1 });
    depth--;
  }

  // Line and tokenizer diagnostics interleave by source line, as parse() promises for the whole set; so does trivia.
  const trivia = dropped.length === 0 ? lines.trivia : [...lines.trivia, ...dropped].sort((a, b) => a.line - b.line);
  return {
    ...(lines.version === undefined ? {} : { version: lines.version }),
    tokens,
    trivia,
    diagnostics: diagnostics.sort((a, b) => a.line - b.line),
  };
}
