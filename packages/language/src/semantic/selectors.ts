import type { RecordNode, Span } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { readTerms } from './conditions.js';
import type { Selector } from './types.js';

export interface SelectorsResult {
  readonly selectors: readonly Selector[];
  readonly spans: readonly Span[];
  readonly diagnostics: readonly Diagnostic[];
}

export function readSelectors(record: RecordNode, path: string): SelectorsResult {
  const selectors: Selector[] = [];
  const spans: Span[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const section of record.sections) {
    if (section.name !== 'activation') continue;
    for (const child of section.children) {
      if (child.kind === 'record') continue;
      if (
        child.kind !== 'field' ||
        child.words.length !== 1 ||
        child.words[0] !== 'activate' ||
        child.value.kind !== 'none' ||
        child.when === undefined ||
        child.children.length > 0
      ) {
        diagnostics.push(
          diag(
            'IA-LANG-SELECTOR-MALFORMED',
            path,
            child.span.line,
            'Expected activate when <axis> is <value>, with no child block.',
            { endLine: child.span.endLine },
          ),
        );
        continue;
      }
      const result = readTerms(child.when, 'selector', path, child.span);
      if (!result.ok) diagnostics.push(result.diagnostic);
      else {
        selectors.push(result.terms);
        spans.push(child.span);
      }
    }
  }
  return { selectors, spans, diagnostics };
}
