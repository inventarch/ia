/**
 * Body reading behind a locator (SPEC "Body reader"): the address forms a reader names a record or one of its parts
 * by, and the one function that returns the text behind it.
 *
 * The body is the record's own text, never its structure: a record's `says` (a @system's `describes`), a cell's text
 * or a requirement's text. Structure stays with the database read and the CLI's inspect. Every read goes through the
 * handle and the caller's scope token, so a door can serve it under the same boundary as its other reads.
 */
import { isRequirementId, PHASES, PRIMITIVES } from '@inventarch/language';
import type { Phase, Primitive } from '@inventarch/language';
import type { Node } from '@inventarch/graph';
import { DbError } from '@inventarch/db';
import type { ReadHandle } from '@inventarch/db';
import { RuntimeError } from './errors.js';
import { valueText } from './render.js';
import { freeze } from './types.js';

export type Locator =
  | { readonly kind: 'identity'; readonly identity: string }
  | { readonly kind: 'cell'; readonly identity: string; readonly phase: Phase; readonly primitive: Primitive }
  | { readonly kind: 'requirement'; readonly identity: string; readonly id: string }
  | { readonly kind: 'line'; readonly path: string; readonly line: number };

export interface ReadBodyOptions {
  readonly within?: string;
}
export interface Body {
  readonly identity: string;
  /** `phase/Primitive` or the requirement id the locator named; null for the record itself. */
  readonly fragment: string | null;
  readonly body: string;
  /** The per-record source digest (graph G13) of the record the body was read from. */
  readonly digest: string;
  /** Where the body came from: the record's own text. A document behind a record's source locator is not read here. */
  readonly source: 'record';
}

/** The canonical four-segment identity, `system/kind/facet/name`, in lowercase. */
const IDENTITY = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const LINE = /^([^#]+):([1-9][0-9]*)$/;
const FORMS =
  'system/kind/facet/name, system/kind/facet/name#phase/Primitive, system/kind/facet/name#REQ-ID or path:line';
/** Sources are recorded root-relative with forward slashes; a locator path is compared in that spelling. */
const portable = (path: string): string => path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');

function invalid(text: string, why: string): never {
  throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', `Locator ${JSON.stringify(text)} ${why}; a locator is ${FORMS}`);
}

export function parseLocator(text: string): Locator {
  const line = LINE.exec(text);
  if (line !== null) return freeze({ kind: 'line', path: portable(line[1]!), line: Number(line[2]) });
  const hash = text.indexOf('#'),
    identity = hash === -1 ? text : text.slice(0, hash);
  if (!IDENTITY.test(identity)) return invalid(text, 'names no canonical identity or source line');
  if (hash === -1) return freeze({ kind: 'identity', identity });
  const fragment = text.slice(hash + 1);
  if (isRequirementId(fragment)) return freeze({ kind: 'requirement', identity, id: fragment });
  const [phase, primitive, ...rest] = fragment.split('/');
  if (
    rest.length === 0 &&
    (PHASES as readonly string[]).includes(phase!) &&
    (PRIMITIVES as readonly string[]).includes(primitive ?? '')
  )
    return freeze({ kind: 'cell', identity, phase: phase as Phase, primitive: primitive as Primitive });
  return invalid(text, 'has a fragment that is neither a phase/Primitive cell nor a requirement id');
}

function unavailable(message: string): never {
  throw new DbError('IA-DB-SOURCE-UNAVAILABLE', message);
}
/** The record's own text: its `says`, or for a record that says nothing (a @system) the head's `describes`. */
function recordText(node: Node): string | undefined {
  const says = node.sections
    .filter((section) => section.name === 'meaning')
    .flatMap((section) => section.fields)
    .find((field) => 'key' in field && field.key === 'says');
  const field = says ?? node.head.find((head) => head.key === 'describes');
  return field === undefined || !('value' in field) ? undefined : valueText(field.value);
}
/** The innermost admitted record whose source lines hold the line: the smallest span, then the latest start. */
function recordAt(handle: ReadHandle, path: string, line: number, options: ReadBodyOptions): Node {
  const holding = handle
    .records(options)
    .filter((node) => portable(node.source.path) === path && node.source.line <= line && line <= node.source.endLine)
    .sort(
      (a, b) => a.source.endLine - a.source.line - (b.source.endLine - b.source.line) || b.source.line - a.source.line,
    );
  return holding[0] ?? unavailable(`No admitted record holds ${path}:${line}`);
}

export function readBody(handle: ReadHandle, locator: Locator, options: ReadBodyOptions = {}): Body {
  const read = options.within === undefined ? {} : { within: options.within };
  const node =
    locator.kind === 'line'
      ? recordAt(handle, locator.path, locator.line, read)
      : (handle.get(locator.identity, read) ?? unavailable(`${locator.identity} is not admitted`));
  let fragment: string | null = null,
    body: string | undefined;
  switch (locator.kind) {
    case 'cell':
      fragment = `${locator.phase}/${locator.primitive}`;
      body = node.cells.find((cell) => cell.phase === locator.phase && cell.primitive === locator.primitive)?.text;
      break;
    case 'requirement':
      fragment = locator.id;
      body = node.requirements.find((requirement) => requirement.id === locator.id)?.text;
      break;
    default:
      body = recordText(node);
  }
  if (body === undefined)
    unavailable(
      fragment === null
        ? `${node.identity} has no body text to read; its structure is inspected, not read`
        : `${node.identity} has no cell or requirement ${fragment}`,
    );
  return freeze({ identity: node.identity, fragment, body, digest: node.digest, source: 'record' });
}
