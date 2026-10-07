import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { INSTALL_PATHS } from '@inventarch/db/distribution';
import { EditorDatabase } from '@inventarch/db/editor';
import type { EditorSource, InputOptions, Overlay } from '@inventarch/db/editor';
import {
  AXES,
  CONDITION_AXES,
  PHASES,
  PRIMITIVES,
  VERB_PHRASES,
  consentFor,
  parse,
  valuesFor,
  verbOf,
} from '@inventarch/language';
import type { EdgeReference, Phase, RecordNode, Span } from '@inventarch/language';
import {
  contains,
  cursorContext,
  draftSource,
  format,
  lineRange,
  projectSource,
  recordsIn,
} from '@inventarch/language/editor';
import type { Position, Range, SourceProjection } from '@inventarch/language/editor';
import { cell, conditionHolds, reaches, stableSerialize, validateCoordinate } from '@inventarch/graph';
import type { Coordinate, Edge, Node } from '@inventarch/graph';
import { evaluateSteward } from '../steward.js';
import type {
  Completion,
  CompletionCitation,
  DraftShape,
  EditorComposition,
  EditorDependency,
  EditorDependencyUse,
  EditorFinding,
  EditorView,
  GraphView,
  Hover,
  Inspection,
  ProposalValidation,
  ProposedFile,
  RecordSummary,
  Relationship,
  SemanticToken,
  SourceLink,
  SourceResult,
  Symbol,
  ViewStamp,
} from './types.js';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const occurrence = (path: string, line: number, discriminator: string, name: string): string =>
  JSON.stringify([path, line, discriminator, name]);
const locationOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const escaped = (text: string): string => text.replace(/[\\`*_{}\[\]()<>#+.!|]/g, '\\$&');
const same = (a: unknown, b: unknown): boolean => stableSerialize(a) === stableSerialize(b);
export class EditorError extends Error {
  constructor(
    readonly code: 'stale' | 'unavailable' | 'invalid' | 'read-only',
    message: string,
  ) {
    super(message);
    this.name = 'EditorError';
  }
}

export class EditorWorkspace {
  readonly ownerSession = randomUUID();
  readonly root: string;
  #db: EditorDatabase;
  #projections = new Map<string, SourceProjection>();
  #lines = new Map<string, readonly string[]>();
  #sources: ReadonlyMap<string, EditorSource> | undefined;
  #actions = new Map<string, { readonly path: string; readonly range: Range }>();
  #actionKeys = new Map<string, string>();
  #nodeIndexes = new Map<string, ReadonlyMap<string, Node>>();
  #views = new Map<string, EditorView>();
  #closed = false;
  #writableSystems: ReadonlySet<string>;
  constructor(root: string, options: InputOptions = {}) {
    this.#db = new EditorDatabase(root, options);
    this.root = this.#db.root;
    this.#writableSystems = new Set(options.writableSystems ?? []);
  }
  #instanceTarget(system: string): boolean {
    const view = this.#db.current.inspect(),
      declaration = view.graph.registry.systems.get(system);
    if (!declaration || !view.admittedSystems.includes(system)) return false;
    const source = this.sources.find((s) => s.path === declaration.path);
    return (
      this.#writableSystems.has(system) || (source?.writable === true && source.location.placement.kind === 'authored')
    );
  }
  get sources(): readonly EditorSource[] {
    this.#assertOpen();
    return this.#db.current.sources;
  }
  #assertOpen(): void {
    if (this.#closed) throw new EditorError('unavailable', 'Workspace owner has been removed');
  }
  #location(path: string): string {
    const directory = locationOf(path);
    return this.sources.some((s) => s.location.placement.reach !== '' && reaches(s.location.placement.reach, directory))
      ? directory
      : '';
  }
  #sourceIndex(): ReadonlyMap<string, EditorSource> {
    this.#assertOpen();
    return (this.#sources ??= new Map(this.sources.map((s) => [s.path, s])));
  }
  sourceText(path: string): string | undefined {
    return this.#sourceIndex().get(path)?.text;
  }
  #source(path: string): EditorSource {
    const source = this.#sourceIndex().get(path);
    if (source === undefined) throw new EditorError('unavailable', 'Source is no longer in this workspace');
    return source;
  }
  #project(path: string): SourceProjection {
    let projected = this.#projections.get(path);
    if (projected === undefined) {
      projected = projectSource(this.#source(path).text, path);
      this.#projections.set(path, projected);
    }
    return projected;
  }
  #sourceLines(path: string): readonly string[] {
    let lines = this.#lines.get(path);
    if (!lines) {
      lines = this.#source(path).text.split(/\r?\n/);
      this.#lines.set(path, lines);
    }
    return lines;
  }
  update(overlays: readonly Overlay[], refresh = false): ViewStamp {
    this.#assertOpen();
    this.#db.update(overlays, refresh);
    this.#sources = undefined;
    this.#projections.clear();
    this.#lines.clear();
    this.#actions.clear();
    this.#actionKeys.clear();
    this.#nodeIndexes.clear();
    this.#views.clear();
    return this.stamp();
  }
  stamp(location = '', phase: Phase | null = null): ViewStamp {
    this.#assertOpen();
    return {
      protocol: 1,
      ownerSession: this.ownerSession,
      generation: this.#db.generation,
      savedRevision: this.#db.savedRevision,
      viewRevision: this.#db.current.snapshot({ root: location, phase }).revision,
      location,
      phase,
    };
  }
  assertStamp(stamp: ViewStamp): void {
    if (
      stamp === null ||
      typeof stamp !== 'object' ||
      stamp.protocol !== 1 ||
      stamp.ownerSession !== this.ownerSession ||
      !same(this.stamp(stamp.location, stamp.phase), stamp)
    )
      throw new EditorError('stale', 'The view changed. Refresh and review the current source before continuing.');
  }
  #link(path: string, span: Span | Range): SourceLink {
    const source = this.#source(path),
      range = 'start' in span ? span : lineRange(this.#sourceLines(path), span);
    const key = JSON.stringify([path, range]);
    let action = this.#actionKeys.get(key);
    if (action === undefined) {
      action = randomUUID();
      this.#actions.set(action, { path, range });
      this.#actionKeys.set(key, action);
    }
    return { action, path, range, readOnly: !source.writable };
  }
  source(action: string, stamp: ViewStamp): SourceResult {
    this.assertStamp(stamp);
    const found = this.#actions.get(action);
    if (found === undefined) throw new EditorError('stale', 'This source action is no longer available');
    const source = this.#source(found.path);
    return { ...this.#link(found.path, found.range), text: source.text, virtual: source.origin !== 'local' };
  }
  #node(
    path: string,
    record: RecordNode,
    location = this.#location(path),
    phase: Phase | null = null,
  ): Node | undefined {
    const graph = this.#db.current.inspect({ root: location, phase }).graph;
    let index = this.#nodeIndexes.get(graph.revision);
    if (index === undefined) {
      index = new Map([...graph.nodes.values()].map((n) => [JSON.stringify([n.source.path, n.source.line]), n]));
      this.#nodeIndexes.set(graph.revision, index);
    }
    return index.get(JSON.stringify([path, record.span.line]));
  }
  #summary(path: string, record: RecordNode, location: string, phase: Phase | null): RecordSummary {
    const view = this.#db.current.inspect({ root: location, phase });
    const node = this.#node(path, record, location, phase);
    const candidate =
      node === undefined
        ? view.graph.occurrences.find((o) => o.node.source.path === path && o.node.source.line === record.span.line)
        : undefined;
    const refused = view.refused.find((r) => r.path === path && r.line === record.span.line);
    const error = view.report.findings.some((f) => f.path === path && f.severity === 'error');
    const says = record.sections
      .find((s) => s.name === 'meaning')
      ?.children.find((c) => c.kind === 'field' && c.key === 'says');
    return {
      occurrence: occurrence(path, record.span.line, record.discriminator, record.name),
      identity: node?.identity ?? candidate?.node.identity ?? refused?.identity ?? null,
      name: record.name,
      discriminator: record.discriminator,
      system: node?.system ?? candidate?.node.system ?? null,
      kind: node?.kind ?? null,
      description: says !== undefined && says.kind !== 'record' && 'text' in says.value ? says.value.text : '',
      status:
        node !== undefined
          ? 'admitted'
          : refused !== undefined || error
            ? 'refused'
            : candidate?.status === 'winner'
              ? 'syntax-only'
              : (candidate?.status ?? 'syntax-only'),
      source: this.#link(path, { line: record.span.line, endLine: record.span.line }),
    };
  }
  #findOccurrence(key: string): { path: string; record: RecordNode } {
    for (const source of this.sources)
      for (const record of recordsIn(this.#project(source.path).ast))
        if (occurrence(source.path, record.span.line, record.discriminator, record.name) === key)
          return { path: source.path, record };
    throw new EditorError('unavailable', 'The selected record occurrence is no longer available');
  }
  diagnostics(location = '', phase: Phase | null = null): readonly EditorFinding[] {
    return this.#db.current
      .inspect({ root: location, phase })
      .report.findings.filter((f) => this.sourceText(f.path) !== undefined)
      .map((f) => ({
        code: f.code,
        message: f.message,
        severity: f.severity,
        path: f.path,
        range: lineRange(this.#sourceLines(f.path), { line: f.line, endLine: f.endLine ?? f.line }),
      }));
  }
  view(location = '', phase: Phase | null = null): EditorView {
    const key = JSON.stringify([location, phase]),
      cached = this.#views.get(key);
    if (cached !== undefined) return cached;
    const inspected = this.#db.current.inspect({ root: location, phase });
    const records = this.sources
      .filter((s) => reaches(s.location.placement.reach, location))
      .flatMap((s) => recordsIn(this.#project(s.path).ast).map((r) => this.#summary(s.path, r, location, phase)));
    const result = {
      stamp: this.stamp(location, phase),
      records,
      systems: inspected.admittedSystems,
      diagnostics: this.diagnostics(location, phase),
      outcome: inspected.report.outcome,
      health: inspected.report.verdicts
        .filter((v) => v.outcome !== 'pass')
        .map((v) => ({ check: v.check, outcome: v.outcome })),
    };
    this.#views.set(key, result);
    return result;
  }
  #target(reference: EdgeReference, location: string): SourceLink | undefined {
    const resolved = this.#db.current.resolve(reference, { root: location });
    if (!resolved.ok) return undefined;
    const node = this.#db.current.get(resolved.identity, { root: location });
    if (node === undefined) return undefined;
    const span =
      resolved.fragment === undefined
        ? { line: node.source.line, endLine: node.source.line }
        : (node.requirements.find((r) => r.id === resolved.fragment)?.span ??
          node.cells.find((c) => `${c.phase}/${c.primitive}` === resolved.fragment)?.span);
    return span === undefined ? undefined : this.#link(node.source.path, span);
  }
  composition(stamp: ViewStamp = this.stamp()): EditorComposition {
    this.assertStamp(stamp);
    const view = this.view(stamp.location, stamp.phase),
      groups = new Map<string, { id: string; revision: string; files: number }>();
    for (const source of this.sources) {
      if (source.origin !== 'adopted') continue;
      const match = /^(\.ia\/adopted\/([^/]+)\/([a-f0-9]{64})\/)/.exec(source.path);
      if (!match) continue;
      const group = groups.get(match[1]!) ?? { id: match[2]!, revision: match[3]!, files: 0 };
      group.files++;
      groups.set(match[1]!, group);
    }
    const contents = (
      prefix: string,
      files = this.sources.filter((s) => s.path.startsWith(prefix)).length,
    ): Pick<EditorDependency, 'prefix' | 'files' | 'records' | 'systems'> => {
      const records = view.records.filter((r) => r.source.path.startsWith(prefix));
      return {
        prefix,
        files,
        records: records.length,
        systems: [...new Set(records.flatMap((r) => (r.system === null ? [] : [r.system])))].sort(),
      };
    };
    const dependencies: EditorDependency[] = [
      ...[...groups].map(
        ([prefix, { id, revision, files }]): EditorDependency => ({
          kind: 'adopted',
          id,
          revision,
          access: 'captured-source',
          ...contents(prefix, files),
        }),
      ),
      ...this.#db.current.installed.map(
        ({ id, version, archive }): EditorDependency => ({
          kind: 'installed',
          id,
          version,
          archive,
          access: 'installed-package',
          ...contents(`${INSTALL_PATHS.store}/${archive}/`),
        }),
      ),
    ];
    const local = this.sources.filter(
      (s) => s.origin === 'local' && s.path.startsWith('.ia/src/') && !s.path.startsWith('.ia/src/floor/'),
    );
    const localRevision = hash(
      stableSerialize(
        local
          .map(({ path, text }) => ({ path, text }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
    );
    const uses: EditorDependencyUse[] = [],
      seen = new Set<string>();
    const add = (occurrence: string, reason: EditorDependencyUse['reason'], target: SourceLink | undefined): void => {
      if (!target) return;
      const dependency = dependencies.find((d) => target.path.startsWith(d.prefix));
      if (!dependency) return;
      const key = JSON.stringify([occurrence, reason, target.path, target.range]);
      if (seen.has(key)) return;
      seen.add(key);
      uses.push({ occurrence, dependency: dependency.id, reason, target });
    };
    if (dependencies.length)
      for (const summary of view.records.filter(
        (r) => r.status === 'admitted' && local.some((s) => s.path === r.source.path),
      )) {
        const { path, record } = this.#findOccurrence(summary.occurrence),
          at = summary.source.range.start;
        add(summary.occurrence, 'schema', this.definition(path, at, true)[0]);
        add(summary.occurrence, 'registration', this.definition(path, at)[0]);
        const projection = this.#project(path),
          records = recordsIn(projection.ast);
        for (const ref of projection.references) {
          // Attribute a typed use to its innermost record, not every enclosing record.
          const containing = records
            .filter((r) => r.span.line <= ref.range.start.line + 1 && r.span.endLine >= ref.range.end.line + 1)
            .at(-1);
          if (containing === record)
            add(summary.occurrence, 'reference', this.#target(ref.reference, this.#location(path)));
        }
      }
    return { stamp, localRevision, dependencies, uses };
  }
  definition(path: string, at: Position, type = false): readonly SourceLink[] {
    const projection = this.#project(path),
      registry = this.#db.current.inspect({ root: this.#location(path) }).graph.registry;
    const record = recordsIn(projection.ast)
      .filter((r) => r.span.line <= at.line + 1 && r.span.endLine >= at.line + 1)
      .at(-1);
    if (type && record !== undefined) {
      const registration = registry.registrations.get(record.discriminator),
        schema = registration === undefined ? undefined : registry.schemas.get(registration.schema);
      return schema === undefined ? [] : [this.#link(schema.path, schema.span)];
    }
    const reference = projection.references.find((r) => contains(r.range, at));
    if (reference !== undefined) {
      const target = this.#target(reference.reference, this.#location(path));
      return target === undefined ? [] : [target];
    }
    if (record?.span.line === at.line + 1) {
      const registration = registry.registrations.get(record.discriminator),
        system = registration === undefined ? undefined : registry.systems.get(registration.system);
      const entry = system?.entries.find((e) => e.keyword === record.discriminator);
      return system === undefined ? [] : [this.#link(system.path, entry?.span ?? system.span)];
    }
    return [];
  }
  references(path: string, at: Position, includeDeclaration = false): readonly SourceLink[] {
    const projection = this.#project(path),
      use = projection.references.find((r) => contains(r.range, at));
    const record = recordsIn(projection.ast)
      .filter((r) => r.span.line <= at.line + 1 && r.span.endLine >= at.line + 1)
      .at(-1);
    const node = record === undefined ? undefined : this.#node(path, record);
    const reference: EdgeReference | undefined =
      use?.reference ?? (node === undefined ? undefined : { kind: 'identity', identity: node.identity });
    if (reference === undefined) return [];
    const target = this.#target(reference, this.#location(path));
    if (target === undefined) return [];
    const found: SourceLink[] = includeDeclaration ? [target] : [];
    for (const source of this.sources)
      for (const candidate of this.#project(source.path).references) {
        const destination = this.#target(candidate.reference, this.#location(source.path));
        if (
          destination?.path === target.path &&
          (reference.fragment === undefined || same(destination.range, target.range))
        ) {
          const resolved = this.#db.current.resolve(candidate.reference, { root: this.#location(source.path) });
          const requested = this.#db.current.resolve(reference, { root: this.#location(path) });
          if (resolved.ok && requested.ok && resolved.identity === requested.identity)
            found.push(this.#link(source.path, candidate.range));
        }
      }
    return found;
  }
  hover(path: string, at: Position): Hover | undefined {
    const projected = this.#project(path),
      ref = projected.references.find((r) => contains(r.range, at));
    if (ref !== undefined) {
      const resolved = this.#db.current.resolve(ref.reference, { root: this.#location(path) });
      const node = resolved.ok ? this.#db.current.get(resolved.identity, { root: this.#location(path) }) : undefined;
      return {
        range: ref.range,
        markdown:
          node === undefined
            ? `**Unresolved reference**\n\n${escaped(resolved.ok ? 'Target unavailable' : resolved.code)}`
            : `**${escaped(node.displayName)}** · ${escaped(node.discriminator)}\n\n\`${node.identity}\`\n\n${escaped(node.source.path)}:${node.source.line}${resolved.ok && resolved.fragment !== undefined && this.#target(ref.reference, this.#location(path)) === undefined ? '\n\nFragment is missing.' : ''}\n\n${ref.use === 'value' ? 'Typed reference; this use does not create a graph relationship.' : 'Relationship target resolved in this source context.'}`,
      };
    }
    const record = recordsIn(projected.ast)
      .filter((r) => r.span.line <= at.line + 1 && r.span.endLine >= at.line + 1)
      .at(-1);
    if (record === undefined) return undefined;
    const summary = this.#summary(path, record, this.#location(path), null),
      findings = this.diagnostics(locationOf(path)).filter((f) => contains(f.range, at));
    const registry = this.#db.current.inspect({ root: this.#location(path) }).graph.registry,
      registration = registry.registrations.get(record.discriminator);
    return {
      range: lineRange(this.#source(path).text, { line: at.line + 1, endLine: at.line + 1 }),
      markdown: `**${escaped(record.name)}** · ${summary.status}\n\n${escaped(summary.description)}\n\n${registration === undefined ? 'Discriminator is not registered.' : `Schema: ${escaped(registration.schema)} · Kind: ${registration.kind}`}${findings.map((f) => `\n\n**${f.code}** ${escaped(f.message)}`).join('')}`,
    };
  }
  symbols(path?: string, query = ''): readonly Symbol[] {
    return (path === undefined ? this.sources : [this.#source(path)]).flatMap((s) =>
      recordsIn(this.#project(s.path).ast)
        .filter((r) => `${r.discriminator} ${r.name}`.toLowerCase().includes(query.toLowerCase()))
        .map((r) => ({
          name: r.name,
          detail: `@${r.discriminator}`,
          path: s.path,
          range: lineRange(s.text, r.span),
          selectionRange: lineRange(s.text, { line: r.span.line, endLine: r.span.line }),
        })),
    );
  }
  folding(path: string): readonly Range[] {
    const source = this.#source(path),
      ast = this.#project(path).ast;
    return recordsIn(ast)
      .flatMap((r) => [r.span, ...r.sections.map((s) => s.span)])
      .filter((s) => s.endLine > s.line)
      .map((s) => lineRange(source.text, s));
  }
  formatting(path: string): string | null {
    const source = this.#source(path);
    if (!source.writable) return null;
    const result = format(source.text, path).text;
    return result === null
      ? null
      : (source.text.startsWith('\uFEFF') && !result.startsWith('\uFEFF') ? '\uFEFF' : '') +
          (source.text.includes('\r\n') ? result.replace(/\r?\n/g, '\r\n') : result);
  }
  completions(path: string, at: Position, limit = 100): readonly Completion[] {
    const source = this.#source(path),
      cursor = cursorContext(source.text, path, at, this.#project(path)),
      location = this.#location(path);
    if (cursor.slot === 'none') return [];
    const { registry } = this.#db.current.inspect({ root: location }).graph;
    const registration =
      cursor.record === undefined ? undefined : registry.registrations.get(cursor.record.discriminator);
    const schema = registration === undefined ? undefined : registry.schemas.get(registration.schema);
    const result: Completion[] = [];
    const add = (
      label: string,
      detail: string,
      kind: Completion['kind'] = 'keyword',
      insertText = label,
      citation?: CompletionCitation,
    ): void => {
      result.push({
        label,
        detail,
        kind,
        insertText,
        range: cursor.range,
        ...(citation === undefined ? {} : { citation }),
      });
    };
    if (cursor.slot === 'header')
      for (const entry of registry.registrations.values())
        add(
          `@${entry.keyword}`,
          `${entry.system} · ${entry.kind} · schema ${entry.schema}`,
          'keyword',
          `@${entry.keyword}`,
          { kind: 'word', keyword: entry.keyword },
        );
    else if (cursor.slot === 'reference' || cursor.slot === 'fragment') {
      const relationVerb =
        cursor.section === 'relationships'
          ? VERB_PHRASES.map((phrase) => ({ phrase, verb: verbOf(phrase)! }))
              .filter(({ phrase }) => cursor.words.join(' ').startsWith(phrase + ' '))
              .sort((a, b) => b.phrase.length - a.phrase.length)[0]?.verb
          : undefined;
      // A schema may hold an outbound and an inbound rule for one predicate; only the rules written in the line's
      // direction constrain it. The candidate is the other endpoint (an inbound rule's source) and may match any of them.
      const rules =
        relationVerb === undefined
          ? []
          : (schema?.edges ?? []).filter(
              (e) => e.predicate === relationVerb.predicate && e.direction === relationVerb.direction,
            );
      for (const node of this.#db.current.records({ root: location })) {
        if (cursor.discriminator !== undefined && !node.discriminator.startsWith(cursor.discriminator)) continue;
        const targetRegistration = registry.registrations.get(node.discriminator);
        const short = targetRegistration?.facets[0] === node.facet;
        // Qualified identities are valid relationship targets; ordinary ref fields have short-reference grammar.
        if (!short && relationVerb === undefined) continue;
        const reference = short ? `@${node.discriminator} ${node.displayName}` : node.identity;
        if (relationVerb !== undefined && cursor.record !== undefined) {
          const from = relationVerb.direction === 'out' ? cursor.record.discriminator : node.discriminator;
          const to = relationVerb.direction === 'out' ? node.discriminator : cursor.record.discriminator;
          if (consentFor(registry, relationVerb.predicate, from, to) !== undefined) continue;
          if (rules.length > 0 && !rules.some((e) => e.target === node.kind || e.target === node.discriminator))
            continue;
        }
        if (cursor.slot === 'fragment') {
          if (node.name !== cursor.targetName?.toLowerCase()) continue;
          for (const fragment of [
            ...node.requirements.map((r) => r.id),
            ...node.cells.map((c) => `${c.phase}/${c.primitive}`),
          ]) {
            const text = `${reference}#${fragment}`;
            if (
              text
                .toLowerCase()
                .startsWith(
                  source.text.split(/\r?\n/)[at.line]!.slice(cursor.range.start.character, at.character).toLowerCase(),
                )
            )
              add(text, node.identity, 'reference', text, { kind: 'record', identity: node.identity });
          }
        } else {
          if (cursor.targetName !== undefined && !node.name.startsWith(cursor.targetName.toLowerCase())) continue;
          add(reference, node.identity, 'reference', reference, { kind: 'record', identity: node.identity });
        }
      }
      return result.sort((a, b) => a.label.localeCompare(b.label)).slice(0, Math.min(100, Math.max(1, limit)));
    } else if (cursor.slot === 'section' || cursor.slot === 'field') {
      if (cursor.slot === 'section') {
        for (const section of schema?.sections ?? [])
          add(section.name, section.must ? 'Required section' : 'Schema section', 'field');
        add('relationships', 'Typed relationships; consent checked at both endpoints', 'field');
      }
      for (const field of schema?.fields ?? [])
        if (field.section === (cursor.section ?? ''))
          add(field.key, `${field.must ? 'Required · ' : ''}${this.#fieldType(field.type)}`, 'field', field.key, {
            kind: 'field',
            schema: schema!.name,
            section: field.section,
            key: field.key,
          });
      if (cursor.section === 'relationships')
        for (const phrase of VERB_PHRASES) add(phrase, `${verbOf(phrase)!.direction} · ${verbOf(phrase)!.predicate}`);
      if (cursor.section === 'cognition')
        for (const value of [...PHASES, ...PRIMITIVES, 'primary']) add(value, 'Cognition address');
      if (cursor.section === 'activation') add('activate when', 'Coordinate selector');
    } else {
      const words = cursor.words,
        previous = words[words.length - (cursor.prefix === '' ? 1 : 2)] ?? '';
      const axis = previous === 'is' ? words[words.length - (cursor.prefix === '' ? 2 : 3)] : previous;
      for (const value of valuesFor(axis ?? '') ?? []) add(value, `Admitted ${axis} value`, 'value');
      if (previous === 'when' || previous === 'and') for (const value of CONDITION_AXES) add(value, 'Condition axis');
      if (previous === 'primary') for (const value of PRIMITIVES) add(value, 'Primary cognition primitive', 'value');
      if (AXES.some((a) => a === previous)) add('is', 'Axis comparison');
      const field = schema?.fields.find(
        (f) => f.section === (cursor.section ?? '') && words.join(' ').startsWith(f.key + ' '),
      );
      if (field?.type === 'ref' || field?.type === 'list of ref')
        for (const entry of registry.registrations.values())
          add(`@${entry.keyword} `, 'Typed reference', 'reference', `@${entry.keyword} `, {
            kind: 'word',
            keyword: entry.keyword,
          });
      if (field?.type === 'flag') for (const value of ['true', 'false']) add(value, 'Flag', 'value');
    }
    return [
      ...new Map(
        result.filter((r) => r.label.toLowerCase().startsWith(cursor.prefix.toLowerCase())).map((r) => [r.label, r]),
      ).values(),
    ]
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, Math.min(100, Math.max(1, limit)));
  }
  /** Design C04: the longer documentation of one selected item, loaded lazily under the stamp its list was computed with. A changed view refuses as stale. */
  completionDocumentation(path: string, citation: CompletionCitation, stamp: ViewStamp): string | undefined {
    this.assertStamp(stamp);
    const location = this.#location(path),
      { registry } = this.#db.current.inspect({ root: location }).graph;
    if (citation.kind === 'record') {
      const node = this.#db.current.get(citation.identity, { root: location });
      if (node === undefined) return undefined;
      const says = node.sections.find((s) => s.name === 'meaning')?.fields.find((f) => 'key' in f && f.key === 'says');
      const text = says !== undefined && 'key' in says && 'text' in says.value ? says.value.text : '';
      return `**${escaped(node.displayName)}** · @${escaped(node.discriminator)}\n\n\`${node.identity}\`\n\n${escaped(node.system)} · ${node.kind}${text === '' ? '' : `\n\n${escaped(text)}`}\n\n\`${node.source.path}:${node.source.line}\``;
    }
    if (citation.kind === 'word') {
      const registration = registry.registrations.get(citation.keyword);
      if (registration === undefined) return undefined;
      const schema = registry.schemas.get(registration.schema),
        required = schema?.sections.filter((s) => s.must).map((s) => s.name) ?? [];
      return `**@${escaped(registration.keyword)}** · ${escaped(registration.system)} · ${registration.kind}\n\nSchema \`${registration.schema}\`${schema === undefined ? ' is unavailable.' : `${schema.closed ? ' (closed)' : ''}${required.length === 0 ? '' : ` · required sections: ${required.map(escaped).join(', ')}`}\n\n\`${schema.path}:${schema.span.line}\``}`;
    }
    const schema = registry.schemas.get(citation.schema),
      field = schema?.fields.find((f) => f.section === citation.section && f.key === citation.key);
    if (schema === undefined || field === undefined) return undefined;
    return `**${escaped(field.key)}** · ${this.#fieldType(field.type)}${field.must ? ' · required' : ''}${field.description === undefined ? '' : `\n\n${escaped(field.description)}`}\n\nSchema \`${schema.name}\` · section ${escaped(field.section === '' ? '(head)' : field.section)}\n\n\`${schema.path}:${field.span.line}\``;
  }
  #fieldType(type: import('@inventarch/language').FieldType): string {
    return type;
  }
  semanticTokens(path: string): readonly SemanticToken[] {
    const projected = this.#project(path);
    if (!projected.supported) return [];
    const records = [...recordsIn(projected.ast)].sort((a, b) => a.span.line - b.span.line),
      registry = this.#db.current.inspect({ root: this.#location(path) }).graph.registry;
    const stack: RecordNode[] = [],
      refs = new Map<number, Range[]>();
    let nextRecord = 0;
    for (const reference of projected.references)
      for (let line = reference.range.start.line; line <= reference.range.end.line; line++) {
        const ranges = refs.get(line) ?? [];
        ranges.push(reference.range);
        refs.set(line, ranges);
      }
    return projected.tokens.flatMap(({ token, range }): SemanticToken[] => {
      if (range.start.line !== range.end.line) return [];
      while (nextRecord < records.length && records[nextRecord]!.span.line <= range.start.line + 1) {
        const upcoming = records[nextRecord++]!;
        while (stack.length && stack.at(-1)!.span.endLine < upcoming.span.line) stack.pop();
        stack.push(upcoming);
      }
      while (stack.length && stack.at(-1)!.span.endLine < range.start.line + 1) stack.pop();
      const record = stack.at(-1);
      const section = record?.sections.find(
        (s) => s.span.line <= range.start.line + 1 && s.span.endLine >= range.start.line + 1,
      );
      const registration = record === undefined ? undefined : registry.registrations.get(record.discriminator);
      const schema = registration === undefined ? undefined : registry.schemas.get(registration.schema);
      let type: string | undefined;
      const modifiers: string[] = [];
      if (token.kind === 'sigil') {
        type = 'type';
        if (record?.span.line === token.line) modifiers.push('declaration');
      } else if (token.kind === 'string' || token.kind === 'prose') type = 'string';
      else if (token.kind === 'word') {
        if (record?.span.line === token.line) {
          type = 'class';
          modifiers.push('declaration');
        } else if (section?.span.line === token.line) type = 'namespace';
        else if (refs.get(range.start.line)?.some((r) => contains(r, range.start))) type = 'variable';
        else if (
          schema?.fields.some((f) => {
            if (f.section !== (section?.name ?? '')) return false;
            const row = this.#sourceLines(path)[range.start.line] ?? '',
              start = row.length - row.trimStart().length;
            return (
              row.slice(start).startsWith(f.key + ' ') &&
              range.start.character >= start &&
              range.end.character <= start + f.key.length
            );
          })
        )
          type = 'property';
        else if (verbOf(token.value) !== undefined || ['when', 'is', 'and', 'primary', 'means'].includes(token.value))
          type = 'keyword';
        else if ([...PHASES, ...PRIMITIVES, ...CONDITION_AXES].some((v) => v === token.value)) type = 'enumMember';
      }
      return type === undefined
        ? []
        : [
            {
              line: range.start.line,
              character: range.start.character,
              length: range.end.character - range.start.character,
              type,
              modifiers,
            },
          ];
    });
  }
  #relationship(edge: Edge, coordinate: Coordinate | undefined, nodes: ReadonlyMap<string, Node>): Relationship {
    const node = nodes.get(edge.conditionSubject),
      from = edge.from === null ? undefined : nodes.get(edge.from),
      to = edge.to === null ? undefined : nodes.get(edge.to);
    const gated =
      coordinate !== undefined && node !== undefined && !conditionHolds(edge.condition, node.dimensions, coordinate);
    return {
      from: edge.from,
      to: edge.to,
      predicate: edge.predicate,
      state: gated
        ? 'gated'
        : edge.from === null || edge.to === null
          ? 'dangling'
          : edge.condition === undefined
            ? 'active'
            : 'conditional',
      source: this.#link(edge.source.path, edge.source),
      fromSource:
        from === undefined ? null : this.#link(from.source.path, { line: from.source.line, endLine: from.source.line }),
      toSource: to === undefined ? null : this.#link(to.source.path, { line: to.source.line, endLine: to.source.line }),
      condition: edge.condition?.map((t) => `${t.axis} is ${t.value}`).join(' and ') ?? '',
    };
  }
  inspect(key: string, stamp: ViewStamp, coordinate: Coordinate = {}): Inspection {
    this.assertStamp(stamp);
    const selected = this.#findOccurrence(key),
      options = { root: stamp.location, phase: stamp.phase };
    const view = this.#db.current.inspect(options),
      node = this.#node(selected.path, selected.record, stamp.location, stamp.phase);
    const record = this.#summary(selected.path, selected.record, stamp.location, stamp.phase),
      schema = node === undefined ? undefined : view.graph.registry.schemas.get(node.schema);
    const selectedCell = node === undefined ? undefined : cell(node, coordinate);
    const references = this.references(selected.path, { line: selected.record.span.line - 1, character: 1 });
    return {
      stamp,
      record,
      relationships:
        node === undefined
          ? []
          : view.graph.edges
              .filter((e) => e.from === node.identity || e.to === node.identity)
              .map((e) => this.#relationship(e, coordinate, view.graph.nodes)),
      schema:
        schema === undefined
          ? null
          : {
              name: schema.name,
              closed: schema.closed,
              fields: schema.fields.map((f) => ({ ...f, type: this.#fieldType(f.type) })),
              source: this.#link(schema.path, schema.span),
            },
      cells:
        node?.cells.map((c) => ({
          phase: c.phase,
          primitive: c.primitive,
          text: c.text,
          primary: c.primary,
          source: this.#link(node.source.path, c.span),
        })) ?? [],
      selectedCell: selectedCell === undefined ? null : { kind: selectedCell.kind, text: selectedCell.cell.text },
      checks: view.report.verdicts
        .filter((v) => v.scope === node?.identity || v.findings.some((f) => f.path === selected.path))
        .map((v) => ({ check: v.check, outcome: v.outcome, messages: v.findings.map((f) => f.message) })),
      typedReferences: references.length,
      incomingRelationships: node === undefined ? 0 : view.graph.edges.filter((e) => e.to === node.identity).length,
    };
  }
  graph(key?: string, stamp = this.stamp(), coordinate?: Coordinate, depth = 1): GraphView {
    this.assertStamp(stamp);
    if (coordinate !== undefined) validateCoordinate(coordinate);
    const view = this.view(stamp.location, stamp.phase),
      graph = this.#db.current.inspect({ root: stamp.location, phase: stamp.phase }).graph;
    const selected = key === undefined ? undefined : view.records.find((r) => r.occurrence === key);
    if (key !== undefined && selected === undefined) throw new EditorError('unavailable', 'Graph focus is absent');
    const traversal =
      selected?.identity == null
        ? undefined
        : this.#db.current.traverse({
            root: stamp.location,
            phase: stamp.phase,
            start: [selected.identity],
            depth: Math.min(3, Math.max(0, depth)),
            maxNodes: 250,
            maxEdges: 500,
            ...(coordinate === undefined ? {} : { coordinate }),
          });
    const ids =
      traversal === undefined
        ? new Set(graph.nodes.keys())
        : new Set([
            ...traversal.nodes.map((n) => n.identity),
            ...traversal.gated.flatMap((e) => [e.from, e.to].filter((id): id is string => id !== null)),
          ]);
    const candidates = view.records.filter(
      (r) => r.status === 'admitted' && r.identity !== null && ids.has(r.identity),
    );
    const nodes = candidates.slice(0, 250),
      visible = new Set(nodes.map((r) => r.identity));
    const allEdges =
      traversal === undefined ? graph.edges : [...traversal.edges, ...traversal.gated, ...traversal.dangling];
    const edges = allEdges
      .filter((e) => (e.from === null || visible.has(e.from)) && (e.to === null || visible.has(e.to)))
      .slice(0, 500)
      .map((e) => this.#relationship(e, coordinate, graph.nodes));
    const groups = new Map<string, number>();
    for (const node of graph.nodes.values()) groups.set(node.system, (groups.get(node.system) ?? 0) + 1);
    return {
      stamp,
      nodes,
      edges,
      containment: this.#containment(view, visible, stamp.location, stamp.phase),
      truncated: traversal?.truncated === true || candidates.length > nodes.length || allEdges.length > edges.length,
      totals: { nodes: candidates.length, edges: allEdges.length },
      groups: [...groups].map(([system, count]) => ({ system, count })),
    };
  }
  /** N04: nested admitted winners with at least one visible endpoint; never added to edges, traversal, nodes or totals. */
  #containment(
    view: EditorView,
    visible: ReadonlySet<string | null>,
    location: string,
    phase: Phase | null,
  ): GraphView['containment'] {
    const admitted = new Map(
      view.records.flatMap((r) => (r.status === 'admitted' && r.identity !== null ? [[r.identity, r] as const] : [])),
    );
    const links: GraphView['containment']['links'][number][] = [],
      nodes = new Map<string, RecordSummary>();
    let truncated = false;
    for (const source of this.sources)
      if (reaches(source.location.placement.reach, location))
        for (const record of recordsIn(this.#project(source.path).ast)) {
          const parent =
            record.nested.length === 0 ? undefined : this.#node(source.path, record, location, phase)?.identity;
          if (parent === undefined || !admitted.has(parent)) continue;
          for (const nested of record.nested) {
            const child = this.#node(source.path, nested, location, phase)?.identity;
            if (child === undefined || !admitted.has(child) || (!visible.has(parent) && !visible.has(child))) continue;
            const extra = [parent, child].filter((id) => !visible.has(id) && !nodes.has(id));
            if (links.length >= 500 || nodes.size + extra.length > 250) {
              truncated = true;
              continue;
            }
            for (const id of extra) nodes.set(id, admitted.get(id)!);
            links.push({
              parent,
              child,
              source: this.#link(source.path, { line: nested.span.line, endLine: nested.span.line }),
            });
          }
        }
    return { links, nodes: [...nodes.values()], truncated };
  }
  steward(system: string, identity?: string): ReturnType<typeof evaluateSteward> {
    return evaluateSteward(
      this.#db.current.records(),
      system,
      identity === undefined ? { kind: 'operator' } : { kind: 'agent', identity },
    );
  }
  draftShapes(): readonly DraftShape[] {
    const view = this.#db.current.inspect();
    return [...view.graph.registry.registrations.values()]
      .filter((r) => !['system', 'schema'].includes(r.keyword) && view.admittedSystems.includes(r.system))
      .flatMap((registration) => {
        const schema = view.graph.registry.schemas.get(registration.schema);
        return schema === undefined || !this.#instanceTarget(registration.system)
          ? []
          : [
              {
                discriminator: registration.keyword,
                system: registration.system,
                schema: schema.name,
                sections: schema.sections,
                fields: schema.fields.map((f) => ({
                  section: f.section,
                  key: f.key,
                  must: f.must,
                  type: this.#fieldType(f.type),
                  ...(f.description === undefined ? {} : { description: f.description }),
                })),
              },
            ];
      });
  }
  draft(discriminator: string, name: string, fields: Readonly<Record<string, string>> = {}): ProposedFile {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name))
      throw new EditorError(
        'invalid',
        'Use a record name beginning with a letter, followed by letters, numbers or hyphens',
      );
    const shape = this.draftShapes().find((s) => s.discriminator === discriminator);
    if (shape === undefined)
      throw new EditorError('unavailable', 'No writable admitted system provides this discriminator');
    const schema = this.#db.current.inspect().graph.registry.schemas.get(shape.schema);
    if (schema === undefined) throw new EditorError('unavailable', 'The draft schema is no longer admitted');
    const text = draftSource(discriminator, name, schema, fields);
    return { path: `.ia/src/systems/${shape.system}/records/${name.toLowerCase()}.ia`, text };
  }
  validateProposal(
    files: readonly ProposedFile[],
    stamp: ViewStamp,
    target?: { readonly system: string; readonly discriminator: string },
  ): ProposalValidation {
    this.assertStamp(stamp);
    const messages: string[] = [],
      paths = new Set<string>();
    if (
      !Array.isArray(files as unknown) ||
      files.some((f) => f === null || typeof f !== 'object' || typeof f.path !== 'string' || typeof f.text !== 'string')
    )
      throw new EditorError('invalid', 'Expected source paths and text');
    if (new Set(files.map((f) => f.path.split('/')[3])).size > 1)
      messages.push('A proposal must create files in one admitted system.');
    if (
      files.length === 0 ||
      files.length > 10 ||
      files.reduce((n, f) => n + Buffer.byteLength(f.text), 0) > 1024 * 1024
    )
      messages.push('Propose 1–10 files, at most 1 MiB total.');
    for (const file of files) {
      if (typeof file.path !== 'string' || typeof file.text !== 'string' || Buffer.byteLength(file.text) > 256 * 1024) {
        messages.push('Each file needs a path and at most 256 KiB of source.');
        continue;
      }
      const parts = file.path.split('/'),
        system = parts[3] ?? '',
        pathKey = file.path.toLowerCase();
      if (
        parts.slice(0, 3).join('/') !== '.ia/src/systems' ||
        parts.length < 5 ||
        !file.path.endsWith('.ia') ||
        parts.some(
          (p) =>
            !p ||
            p === '.' ||
            p === '..' ||
            /[\\\u0000-\u001f<>:"|?*]|[. ]$/.test(p) ||
            /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
        )
      ) {
        messages.push(`Unsafe target path: ${file.path}`);
        continue;
      }
      if (
        paths.has(pathKey) ||
        this.sources.some((s) => s.path.toLowerCase() === pathKey) ||
        existsSync(resolve(this.root, file.path))
      )
        messages.push(`Target already exists or aliases another proposal: ${file.path}`);
      paths.add(pathKey);
      let parent = this.root;
      for (const part of parts.slice(0, -1)) {
        parent = resolve(parent, part);
        if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
          messages.push(`Source aliases are refused: ${file.path}`);
      }
      if (!this.#instanceTarget(system))
        messages.push(`Target system is not an admitted writable authored system: ${system}`);
      const decision = evaluateSteward(this.#db.current.records(), system, { kind: 'operator' });
      if (!decision.allowed) messages.push(decision.message);
      const ast = parse(file.text, file.path).ast;
      if (
        target !== undefined &&
        (system !== target.system || recordsIn(ast).some((r) => r.discriminator !== target.discriminator))
      )
        messages.push('Proposed instances do not match the requested system and discriminator.');
      if (
        recordsIn(ast).some(
          (r) => r.discriminator === 'system' || r.discriminator === 'schema' || r.name.endsWith('-steward'),
        )
      )
        messages.push('Create Files cannot change system, schema or steward authority.');
      const foreign = recordsIn(ast).find(
        (r) => this.#db.current.inspect().graph.registry.registrations.get(r.discriminator)?.system !== system,
      );
      if (foreign !== undefined) messages.push(`@${foreign.discriminator} is not owned by ${system}.`);
    }
    let diagnostics: readonly EditorFinding[] = [];
    if (messages.length === 0) {
      const candidate = this.#db.current.candidate(files.map((f) => ({ ...f, version: 0 })));
      try {
        const before = this.#db.current.inspect(),
          after = candidate.inspect();
        const key = (f: { code: string; path: string; line: number; message: string }): string =>
          stableSerialize([f.code, f.path, f.line, f.message]);
        const existing = new Set(before.report.findings.filter((f) => f.severity === 'error').map(key));
        const newErrors = after.report.findings.filter((f) => f.severity === 'error' && !existing.has(key(f)));
        diagnostics = newErrors.map((f) => ({
          code: f.code,
          severity: f.severity,
          message: f.message,
          path: f.path,
          range: lineRange(candidate.sources.find((s) => s.path === f.path)?.text ?? '', {
            line: f.line,
            endLine: f.endLine ?? f.line,
          }),
        }));
        if (newErrors.length > 0) messages.push(`${newErrors.length} new admission error(s).`);
        const admitted = new Set(
          [...after.graph.nodes.values()].map((n) => stableSerialize([n.identity, n.source.path])),
        );
        if ([...before.graph.nodes.values()].some((n) => !admitted.has(stableSerialize([n.identity, n.source.path]))))
          messages.push('The proposal removes or shadows an existing admitted record.');
        for (const file of files)
          if (![...after.graph.nodes.values()].some((n) => n.source.path === file.path))
            messages.push(`No record from ${file.path} was admitted.`);
      } finally {
        candidate.close();
      }
    }
    return {
      stamp,
      allowed: messages.length === 0,
      messages,
      diagnostics,
      files: files.map((f) => ({ ...f, hash: hash(f.text) })),
    };
  }
  close(): void {
    this.#db.close();
    this.#closed = true;
    this.#actions.clear();
    this.#projections.clear();
  }
}
