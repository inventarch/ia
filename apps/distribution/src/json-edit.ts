import { applyEdits, findNodeAtLocation, format, modify, parseTree } from 'jsonc-parser';
import type { FormattingOptions, Node, ParseError } from 'jsonc-parser';
import { fail } from './files.js';

/** Object keys and array indexes from the document root; `-1` as the last segment appends to an array. */
export type JsonPath = readonly (string | number)[];
/** Layout of an existing document: first indented line's unit and CRLF/LF. A single-line document stays single-line (no layout); a new one is two spaces and LF. */
export function jsonLayout(text: string | null): FormattingOptions | undefined {
  if (text === null) return { insertSpaces: true, tabSize: 2, eol: '\n' };
  const body = text.trimEnd();
  if (!body.includes('\n')) return undefined;
  const eol = text.includes('\r\n') ? '\r\n' : '\n',
    indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? '  ';
  return indent.startsWith('\t')
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
}
function tree(text: string): Node {
  const errors: ParseError[] = [],
    root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length) fail('INPUT-INVALID', 'Malformed JSON settings');
  if (root?.type !== 'object') fail('INPUT-INVALID', 'Expected a JSON settings object');
  return root;
}
const at = (root: Node, path: JsonPath): Node | undefined => (path.length ? findNodeAtLocation(root, [...path]) : root);
const same = (a: JsonPath, b: JsonPath): boolean =>
  a.length === b.length && a.every((part, index) => part === b[index]);
/** The paths among `paths` that name a node in the document; `null` has none. */
export function presentJson(text: string | null, paths: readonly JsonPath[]): JsonPath[] {
  if (text === null) return [];
  const root = tree(text);
  return paths.filter((path) => at(root, path) !== undefined);
}
/** True when the document is an object with no members. */
export function emptyJson(text: string): boolean {
  return !tree(text).children?.length;
}
/**
 * Set (`value`) or remove (`undefined`) one member in place; every byte outside the edited member is kept.
 * A set is laid out with the document's own indentation and line ending; missing parents are created.
 * A removal also removes each parent the member would leave empty, climbing while that parent is not in
 * `keep`; an emptied parent in `keep` (or the root) is rewritten as an empty literal instead.
 */
export function editJson(text: string | null, path: JsonPath, value: unknown, keep: readonly JsonPath[] = []): string {
  const layout = jsonLayout(text),
    base = text ?? '{}\n',
    root = tree(base);
  if (value === undefined) {
    if (at(root, path) === undefined) fail('INPUT-INVALID', 'Owned JSON member is absent');
    let target = path;
    while (
      target.length > 1 &&
      !keep.some((kept) => same(kept, target.slice(0, -1))) &&
      at(root, target.slice(0, -1))!.children!.length === 1
    )
      target = target.slice(0, -1);
    const parent = target.slice(0, -1),
      node = at(root, parent)!,
      members = node.children!;
    if (members.length === 1) return applyEdits(base, modify(base, [...parent], node.type === 'array' ? [] : {}, {}));
    // Own range, not jsonc-parser's removal: a later member takes the separator after it, the last one the separator before it, so an append is exactly undone.
    const member = node.type === 'array' ? members[target.at(-1) as number]! : at(root, target)!.parent!,
      index = members.indexOf(member),
      before = members[index - 1],
      after = members[index + 1];
    const from = before ? before.offset + before.length : member.offset,
      to = before ? member.offset + member.length : after!.offset;
    return base.slice(0, from) + base.slice(to);
  }
  const edits = modify(base, [...path], value, {});
  if (edits.length !== 1) fail('INPUT-INVALID', 'Unexpected JSON edit shape');
  const edit = edits[0]!,
    next = applyEdits(base, edits);
  if (!layout) return next;
  // Lay out only the inserted text; existing whitespace is never touched. An insertion into an empty container also
  // lays out that container's opener and closer, so its breaks are placed too (removal later restores the empty literal).
  const open = edit.offset > 0 && '{['.includes(next[edit.offset - 1]!),
    stop = edit.offset + edit.content.length,
    closer = open ? next.slice(stop).search(/\S/) : -1;
  const start = open ? edit.offset - 1 : edit.offset,
    end = closer >= 0 && '}]'.includes(next[stop + closer]!) ? stop + closer + 1 : stop;
  return applyEdits(next, format(next, { offset: start, length: end - start }, layout));
}
/** A retained `keep` list from ownership state: absent is empty; present is a non-empty, duplicate-free subset of `allowed`. */
export function keptPaths(value: unknown, allowed: readonly JsonPath[]): JsonPath[] {
  if (value === undefined) return [];
  const result = allowed.filter(
    (path) => Array.isArray(value) && value.some((item) => Array.isArray(item) && same(item, path)),
  );
  if (!Array.isArray(value) || !value.length || result.length !== value.length)
    fail('INPUT-INVALID', 'Invalid retained settings containers');
  return result;
}
