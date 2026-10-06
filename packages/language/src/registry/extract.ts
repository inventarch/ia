import type { ChildNode, FieldNode, FileNode, RecordNode, Span } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import {
  ARTIFACT_SETS,
  CATEGORIES,
  KINDS,
  MOVES,
  PREDICATES,
  PRIMITIVES,
  isArtifactSet,
  isCategory,
  isKind,
  isMove,
  isPredicate,
  isPrimitive,
} from '../taxonomy.js';
import type { Band, Category } from '../taxonomy.js';
import { fieldOf, restAfter, spelledAs, stringOf } from './fields.js';
import { RESERVED_KEYWORDS } from './floor.js';
import { conditionsIn, recordsIn } from './records.js';
import type { ConsentRow, Entry, RequiredSystem, Steward, SystemDeclaration } from './types.js';

/** Class checks, like the header class checks in parser.ts: a keyword spells like a discriminator; a version is semver with no leading zeros. */
const KEYWORD = /^[a-z][a-z0-9-]*$/;
const NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const RETIRED_KEYWORDS: readonly string[] = ['interface', 'protocol', 'shape'];
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isSemver(version: string): boolean {
  const match = SEMVER.exec(version);
  return match !== null && (match[1]?.split('.').every((part) => !/^0\d+$/.test(part)) ?? true);
}

export interface ExtractedSystems {
  readonly systems: readonly SystemDeclaration[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Every `@system`, including nested records (spec 4.4). Parser diagnostics remain owned by the caller. */
export function extractSystems(ast: FileNode, band: Band, parserDiagnostics: readonly Diagnostic[]): ExtractedSystems {
  const systems: SystemDeclaration[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const { record, endLine, errors } of recordsIn(ast, parserDiagnostics)) {
    if (record.discriminator !== 'system') continue;
    const refused: Refused = (span) => errors.some((d) => d.line >= span.line && d.line <= span.endLine);
    const system = systemOf(record, endLine, ast.path, band, diagnostics, refused);
    if (system !== undefined) systems.push(system);
  }
  return { systems, diagnostics };
}

type Incomplete = (element: string, line: number, why: string) => void;
type Refused = (span: Span) => boolean;

/** Ignore parser-refused units; items have no block, while field blocks extend to the next sibling. */
function sectionChildren(record: RecordNode, name: string, endLine: number, refused: Refused): readonly ChildNode[] {
  return record.sections.flatMap((section, index) => {
    if (section.name !== name) return [];
    const sectionEnd = (record.sections[index + 1]?.span.line ?? endLine + 1) - 1;
    return section.children.filter((child, position) => {
      const end =
        child.kind === 'field' ? (section.children[position + 1]?.span.line ?? sectionEnd + 1) - 1 : child.span.endLine;
      return !refused({ line: child.span.line, endLine: end });
    });
  });
}

/** Spec 7.4: report each forbidden condition once, at its authored field. */
function conditioned(children: readonly ChildNode[], where: string, path: string, diagnostics: Diagnostic[]): boolean {
  const found = conditionsIn(children);
  for (const child of found) {
    diagnostics.push(
      diag(
        'IA-LANG-CONDITION-MISPLACED',
        path,
        child.span.line,
        `${path}:${child.span.line}: a when clause cannot sit on ${where} ('${child.key}')`,
      ),
    );
  }
  return found.length > 0;
}

/** The one head field spelled `spelling`; a second one is a fault on the second. */
function single(record: RecordNode, spelling: readonly string[], refuse: Incomplete): FieldNode | undefined {
  const matches = record.head.filter((field) => spelledAs(field, spelling));
  const second = matches[1];
  if (second !== undefined) refuse(spelling.join(' '), second.span.line, 'appears twice; a head field is written once');
  return matches[0];
}

function systemOf(
  record: RecordNode,
  endLine: number,
  path: string,
  band: Band,
  diagnostics: Diagnostic[],
  refused: Refused,
): SystemDeclaration | undefined {
  const headEnd = (record.sections[0]?.span.line ?? endLine + 1) - 1;
  if (refused({ line: record.span.line, endLine: headEnd })) return undefined;
  let ok = !conditioned(record.head, `a head field of @system ${record.name}`, path, diagnostics);
  const incomplete: Incomplete = (element, line, why) => {
    diagnostics.push(
      diag('IA-LANG-REGISTRATION-INCOMPLETE', path, line, `${path}:${line}: @system ${record.name}: ${element} ${why}`),
    );
  };
  const refuse: Incomplete = (element, line, why) => {
    incomplete(element, line, why);
    ok = false;
  };

  const providerField = single(record, ['provider'], refuse);
  const provider = stringOf(providerField);
  if (providerField === undefined) refuse('provider', record.span.line, 'is required: a quoted string');
  else if (provider === undefined) refuse('provider', providerField.span.line, 'is a quoted string');
  const versionField = single(record, ['version'], refuse);
  const version = stringOf(versionField);
  if (versionField === undefined) refuse('version', record.span.line, 'is required: a quoted semver string');
  else if (version === undefined) refuse('version', versionField.span.line, 'is a quoted semver string');
  else if (!isSemver(version))
    refuse(
      'version',
      versionField.span.line,
      `"${version}" is not a semver string (nonempty identifiers; no leading zeros in core numbers or numeric prerelease identifiers)`,
    );
  const describes = stringOf(fieldOf(record.head, ['describes']));
  let steward: Steward | undefined;
  for (const stewardField of record.head.filter((field) => spelledAs(field, ['steward']))) {
    if (stewardField.value.kind === 'ref' && stewardField.value.fragment === undefined)
      steward ??= { discriminator: stewardField.value.discriminator, name: stewardField.value.name.toLowerCase() };
    else refuse('steward', stewardField.span.line, 'names the steward by reference: `steward @<discriminator> <name>`');
  }

  const requires: RequiredSystem[] = [];
  const requiresHead = fieldOf(record.head, ['requires']);
  if (requiresHead !== undefined)
    refuse('requires', requiresHead.span.line, 'is a section holding one bare system name per item, not a head field');
  for (const child of sectionChildren(record, 'requires', endLine, refused)) {
    if (child.kind === 'item' && child.value.kind === 'none') continue;
    if (conditioned([child], `requires of @system ${record.name}`, path, diagnostics)) continue;
    // A system name is an identity slot, lowercased like the header name it must match.
    if (child.kind === 'item' && child.value.kind === 'scalar' && NAME.test(child.value.text))
      requires.push({ name: child.value.text.toLowerCase(), span: child.span });
    else incomplete('requires', child.span.line, 'holds one bare system name per item');
  }

  const entries: Entry[] = [];
  const registered = new Set<string>();
  for (const child of sectionChildren(record, 'discriminators', endLine, refused)) {
    if (child.kind !== 'field') {
      incomplete('discriminators', child.span.line, 'holds entries of the form `<keyword> lowers to <kind>`');
      continue;
    }
    const entry = entryOf(child, record.name, path, diagnostics, incomplete);
    if (entry === undefined) continue;
    if (registered.has(entry.keyword)) {
      incomplete(`discriminator '${entry.keyword}'`, child.span.line, 'is registered twice in this system');
      continue;
    }
    registered.add(entry.keyword);
    entries.push(entry);
  }

  const consent: ConsentRow[] = [];
  for (const child of sectionChildren(record, 'edges', endLine, refused)) {
    if (child.kind !== 'field') {
      incomplete('edges', child.span.line, 'holds rows of the form `<predicate> <targets> using <sources>`');
      continue;
    }
    const row = consentRowOf(child, path, diagnostics, incomplete);
    if (row !== undefined) consent.push(row);
  }

  if (!ok || provider === undefined || version === undefined) return undefined;
  return {
    name: record.name.toLowerCase(),
    displayName: record.name,
    provider,
    version,
    ...(describes === undefined ? {} : { describes }),
    ...(steward === undefined ? {} : { steward }),
    requires,
    entries,
    consent,
    path,
    span: record.span,
    band,
  };
}

/** `<keyword> lowers to <kind>` with `category`, `facets` and `schema` beneath it; every fault is reported, the entry is dropped on any. */
function entryOf(
  field: FieldNode,
  systemName: string,
  path: string,
  diagnostics: Diagnostic[],
  incomplete: Incomplete,
): Entry | undefined {
  const words = field.words;
  const line = field.span.line;
  const keyword = words[0];
  const kind = words[3];
  const entryShape =
    keyword !== undefined &&
    kind !== undefined &&
    words.length === 4 &&
    words[1] === 'lowers' &&
    words[2] === 'to' &&
    field.value.kind === 'scalar';
  // `when` is a legal discriminator keyword in this entry grammar, not a standalone condition.
  const conditionNodes = entryShape && field.when === undefined ? field.children : [field];
  if (conditioned(conditionNodes, `a discriminators entry of @system ${systemName}`, path, diagnostics))
    return undefined;
  if (!entryShape) {
    incomplete('discriminators', line, 'entry must read `<keyword> lowers to <kind>`');
    return undefined;
  }
  let ok = true;
  if (!KEYWORD.test(keyword)) {
    incomplete('discriminators', line, `keyword '${keyword}' must spell like a discriminator: [a-z][a-z0-9-]*`);
    ok = false;
  }
  if (RESERVED_KEYWORDS.includes(keyword) || RETIRED_KEYWORDS.includes(keyword)) {
    const reason = RETIRED_KEYWORDS.includes(keyword) ? 'retired by language section 8.4' : 'reserved by the floor';
    diagnostics.push(
      diag(
        'IA-LANG-KEYWORD-RESERVED',
        path,
        line,
        `${path}:${line}: '${keyword}' is ${reason}; @system ${systemName} cannot register it`,
      ),
    );
    ok = false;
  }
  const lowered = isKind(kind) ? kind : undefined;
  if (lowered === undefined) {
    diagnostics.push(
      diag(
        'IA-LANG-KIND-UNKNOWN',
        path,
        line,
        `${path}:${line}: '${kind}' is not a closed kind; admitted: ${KINDS.join(', ')}`,
      ),
    );
    ok = false;
  }
  const element = `discriminator '${keyword}'`;
  let category: Category | undefined;
  const categoryField = fieldOf(field.children, ['category']);
  if (categoryField === undefined) {
    incomplete(element, line, 'needs `category <category>`');
    ok = false;
  } else if (categoryField.value.kind !== 'scalar') {
    incomplete(element, categoryField.span.line, 'names its category as a bare word');
    ok = false;
  } else {
    const named =
      categoryField.assertive === true ? categoryField.value.text : restAfter(categoryField, ['category']).join(' ');
    if (isCategory(named)) category = named;
    else {
      diagnostics.push(
        diag(
          'IA-LANG-CATEGORY-UNKNOWN',
          path,
          categoryField.span.line,
          `${path}:${categoryField.span.line}: '${named}' is not a category; admitted: ${CATEGORIES.join(', ')}`,
        ),
      );
      ok = false;
    }
  }
  const facets: string[] = [];
  const facetsField = fieldOf(field.children, ['facets']);
  if (facetsField === undefined || facetsField.value.kind !== 'list' || facetsField.value.items.length === 0) {
    incomplete(element, line, 'needs `facets [<facet>, ...]` with at least one facet');
    ok = false;
  } else {
    for (const item of facetsField.value.items) {
      if (item.kind === 'scalar') facets.push(item.text);
      else {
        incomplete(element, facetsField.span.line, 'names facets as bare words');
        ok = false;
      }
    }
  }
  const schemaField = fieldOf(field.children, ['schema']);
  const schema =
    schemaField !== undefined &&
    schemaField.value.kind === 'ref' &&
    schemaField.value.discriminator === 'schema' &&
    schemaField.value.fragment === undefined
      ? schemaField.value.name.toLowerCase()
      : undefined;
  if (schema === undefined) {
    incomplete(element, line, 'needs `schema @schema <name>`');
    ok = false;
  }
  const lowering = loweringOf(field, element, incomplete);
  if (!ok || lowered === undefined || category === undefined || schema === undefined || lowering === undefined)
    return undefined;
  return { keyword, kind: lowered, category, facets, schema, ...lowering, span: field.span };
}

/**
 * The optional lowering extras of an entry: `artifact-set <set>`, `primitive <primitive>` and `move <move>`, each a
 * bare closed kernel value (spec 4.2). Absent rows leave the registration without them; a present row whose value is
 * outside the kernel refuses the entry like any other incomplete row.
 */
function loweringOf(
  field: FieldNode,
  element: string,
  incomplete: Incomplete,
): Pick<Entry, 'artifactSet' | 'primitive' | 'move'> | undefined {
  let ok = true;
  const value = <T extends string>(
    key: string,
    admits: (x: string) => x is T,
    admitted: readonly string[],
  ): T | undefined => {
    const row = fieldOf(field.children, [key]);
    if (row === undefined) return undefined;
    if (row.value.kind !== 'scalar') {
      incomplete(element, row.span.line, `names its ${key} as a bare word`);
      ok = false;
      return undefined;
    }
    const named = row.assertive === true ? row.value.text : restAfter(row, [key]).join(' ');
    if (admits(named)) return named;
    incomplete(element, row.span.line, `names a ${key} outside the kernel; admitted: ${admitted.join(', ')}`);
    ok = false;
    return undefined;
  };
  const artifactSet = value('artifact-set', isArtifactSet, ARTIFACT_SETS);
  const primitive = value('primitive', isPrimitive, PRIMITIVES);
  const move = value('move', isMove, MOVES);
  if (!ok) return undefined;
  return {
    ...(artifactSet === undefined ? {} : { artifactSet }),
    ...(primitive === undefined ? {} : { primitive }),
    ...(move === undefined ? {} : { move }),
  };
}

/** `<predicate> <targets> using <sources>`: each side is `*` or comma-separated keywords; one `using`; no when clause. */
function consentRowOf(
  field: FieldNode,
  path: string,
  diagnostics: Diagnostic[],
  incomplete: Incomplete,
): ConsentRow | undefined {
  const words = field.words;
  const line = field.span.line;
  const using = words.indexOf('using');
  const predicate = words[0];
  if (
    predicate === undefined ||
    field.value.kind !== 'scalar' ||
    words.length < 4 ||
    using < 2 ||
    using === words.length - 1 ||
    words.lastIndexOf('using') !== using
  ) {
    incomplete('edges', line, 'row must read `<predicate> <targets> using <sources>`, with one `using`');
    return undefined;
  }
  if (conditionsIn([field]).length > 0) {
    incomplete('edges', line, 'a consent row carries no when clause');
    return undefined;
  }
  if (!isPredicate(predicate)) {
    diagnostics.push(
      diag(
        'IA-LANG-PREDICATE-UNKNOWN',
        path,
        line,
        `${path}:${line}: '${predicate}' is not a predicate; admitted: ${PREDICATES.join(', ')}`,
      ),
    );
    return undefined;
  }
  const targets = sideOf(words.slice(1, using));
  const sources = sideOf(words.slice(using + 1));
  if (targets === undefined || sources === undefined) {
    incomplete(
      'edges',
      line,
      'each side of `using` is `*` alone or comma-separated discriminators, with no dangling comma',
    );
    return undefined;
  }
  return { predicate, targets, sources, span: field.span };
}

/** A wildcard alone, or comma-separated keywords with optional whitespace around each comma. */
function sideOf(words: readonly string[]): readonly string[] | '*' | undefined {
  const side = words.join(' ');
  if (side === '*') return '*';
  const names = side.split(',').map((name) => name.trim());
  return names.every((name) => KEYWORD.test(name)) ? names : undefined;
}
