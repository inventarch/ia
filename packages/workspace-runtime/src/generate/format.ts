import type { Node } from '@inventarch/graph';
import type { CompiledValue } from '@inventarch/language';
import type {
  DefinitionWord,
  GeneratedFileWord,
  GeneratedRecordWord,
  PacketHost,
  UnsupportedRow,
} from '@inventarch/runtime';
import {
  code as packetCode,
  inline as packetInline,
  prose as packetProse,
} from '@inventarch/runtime/internal/packet-host';
import { inputFailure, ProjectionError } from '../projection-format.js';
import { inert } from '../projection-host.js';
import { frozen } from '../resource-format.js';

/**
 * What the host generators share: the generated file and the unsupported row they return, the per-record rendering
 * that reports a record instead of failing the others, the host and name checks, the authored records they render, the
 * capability closure, and the field readers and text helpers their bodies are written with.
 */

/** The words a generator renders records of: runtime's unions, stated once there. */
export type GeneratedWord = GeneratedRecordWord | DefinitionWord;
/** One generated host file and the record it renders. */
export interface GeneratedFile {
  /** Workspace-relative and `/`-separated. */
  readonly path: string;
  readonly text: string;
  /** The identity of the rendered record. */
  readonly identity: string;
  readonly word: GeneratedFileWord;
}
/** An authored record a host does not render or register, and why: the projection receipt's `unsupported` row. */
export type UnsupportedRecord = UnsupportedRow;
/** What a file generator returns: the files it renders, and one row for each authored record it does not. */
export interface GeneratedSet {
  readonly files: readonly GeneratedFile[];
  readonly unsupported: readonly UnsupportedRecord[];
}

/** Records the workspace itself authors; an installed or adopted base sits at a lower band. */
const AUTHORED = 100;

/** An unknown host is IA-PROJECTION-INPUT-INVALID. */
export function knownHost(host: PacketHost): void {
  if (host !== 'claude' && host !== 'codex' && host !== 'gemini' && host !== 'antigravity')
    inputFailure(`Unknown host: ${String(host)}`);
}
/**
 * A name that becomes a host path segment: lower-case letters, digits and single hyphens, a letter first and no hyphen
 * last, at most 64 characters (the agent and skill name rule), and no Windows device name (`con`, `prn`, `aux`, `nul`,
 * `com0`-`com9`, `lpt0`-`lpt9`, the rule db's input paths apply). IA-PROJECTION-INPUT-INVALID otherwise.
 */
export function safeName(name: string): string {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
    name.endsWith('-') ||
    name.includes('--') ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)
  )
    inputFailure(`Unsafe generated host name: ${name}`);
  return name;
}
/** The records of `word` among `records` that the workspace authors (band 100), by identity. */
export const authoredOf = (records: readonly Node[], word: GeneratedWord): readonly Node[] =>
  records
    .filter((node) => node.discriminator === word && node.band === AUTHORED)
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
/**
 * Render each record with `render`, in order. A record `render` or its text refuses with an IA-PROJECTION-* error is
 * not rendered and becomes an unsupported row naming the record and the reason, and the others still render. Every
 * rendered text must be inert prose (projection-host's `inert`: no executable dynamic context, no active HTML), as the
 * prose projector requires of the same records. Any other error still fails.
 */
export function perRecord(
  word: UnsupportedRecord['word'],
  nodes: readonly Node[],
  render: (node: Node) => GeneratedFile,
): GeneratedSet {
  const files: GeneratedFile[] = [],
    unsupported: UnsupportedRecord[] = [];
  for (const node of nodes)
    try {
      const file = render(node);
      inert(file.text);
      files.push(file);
    } catch (error) {
      if (!(error instanceof ProjectionError)) throw error;
      unsupported.push({ identity: node.identity, word, reason: error.message });
    }
  return frozen({ files, unsupported });
}
/**
 * A profile's capabilities and every capability they include, through `composition.includes`, each once, in first-reached
 * order; a reference no admitted `@capability` answers is left out, and a cycle ends where it meets a capability already
 * reached (`closureRefusal` says whether the composition compiler would refuse it).
 */
export function capabilityClosure(
  roots: readonly CompiledValue[],
  target: (value: CompiledValue) => Node | undefined,
): readonly Node[] {
  const reached = new Map<string, Node>();
  const visit = (value: CompiledValue): void => {
    const node = target(value);
    if (node === undefined || node.discriminator !== 'capability' || reached.has(node.identity)) return;
    reached.set(node.identity, node);
    for (const included of valuesAt(node, 'composition.includes')) visit(included);
  };
  for (const root of roots) visit(root);
  return [...reached.values()];
}
/**
 * Why the composition compiler refuses a profile's capability closure, or undefined when it does not: an inclusion
 * cycle, or an included capability whose effects its includer does not declare (the compiler holds each capability to
 * its own `execution.effects` as a ceiling over what it includes).
 */
export function closureRefusal(
  roots: readonly CompiledValue[],
  target: (value: CompiledValue) => Node | undefined,
): string | undefined {
  const done = new Set<string>(),
    open = new Set<string>();
  const visit = (node: Node): string | undefined => {
    if (done.has(node.identity)) return undefined;
    if (open.has(node.identity)) return `its capabilities include one another in a cycle at ${node.identity}`;
    open.add(node.identity);
    const own = new Set(textsAt(node, 'execution.effects'));
    for (const value of valuesAt(node, 'composition.includes')) {
      const child = target(value);
      if (child === undefined || child.discriminator !== 'capability') continue;
      const refused = visit(child);
      if (refused !== undefined) return refused;
      const exceeding = textsAt(child, 'execution.effects').filter((effect) => !own.has(effect));
      if (exceeding.length > 0)
        return `${child.identity} has effects (${exceeding.join(', ')}) its includer ${node.identity} does not declare`;
    }
    open.delete(node.identity);
    done.add(node.identity);
    return undefined;
  };
  for (const root of roots) {
    const node = target(root);
    if (node === undefined || node.discriminator !== 'capability') continue;
    const refused = visit(node);
    if (refused !== undefined) return refused;
  }
  return undefined;
}

// The field readers are the package's one copy (../record-fields.ts, which re-exports runtime's packet readers).
import { fieldsOf, stated, textsAt, valuesAt } from '../record-fields.js';
export { fieldsOf, stated, textsAt, valuesAt };

// Built from strings: the class names the control characters themselves.
const CONTROLS = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
  'g',
);
/**
 * Authored text as a generated file may hold it: every C0 or C1 control but tab and the line breaks `inline` folds, the
 * Unicode line and paragraph separators, and the bidirectional controls become a space, so no value can start a YAML or
 * Markdown line, drive a terminal or reorder what a reader sees.
 */
const plain = (text: string): string => text.replace(CONTROLS, ' ');
/** `text` on one line, as the packet writes an entry (runtime's `inline`), its controls made spaces. */
export const inline = (text: string): string => packetInline(plain(authored(text)));
/** `text` as one code span, as the packet writes one (runtime's `code`). */
export const code = (text: string): string => packetCode(plain(text));
/**
 * An authored value must itself be inert prose (projection-host's `inert`: no executable dynamic context such as
 * `!\`cmd\``, no active HTML, no unbalanced code span or fence), so a record is reported for what its own text holds
 * rather than for what rendering made of it. IA-PROJECTION-FEATURE-UNAVAILABLE otherwise.
 */
function authored(text: string): string {
  inert(text);
  return text;
}
/**
 * Authored free text for a Markdown body: on one line, each bare IA word token a code span as the packet writes it
 * (runtime's `prose`); a `!` that a code span the rendering opened would follow is written `&#33;`, so no rendered span
 * reads as dynamic context; every `<!--` is written `&lt;!--`, so no authored value opens an HTML comment that hides
 * what follows or reads as a marker line; and a leading `<` is written `&lt;`, so no value opens an HTML block.
 */
export const prose = (text: string): string =>
  packetProse(plain(authored(text)))
    .replace(/!(\s*)`/g, '&#33;$1`')
    .replaceAll('<!--', '&lt;!--')
    .replace(/^</, '&lt;');
/** A list's items, comma-separated, or `none`. */
export const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join(', '));
export const section = (heading: string, lines: readonly string[]): readonly string[] => [
  '',
  `## ${heading}`,
  '',
  ...lines,
];
