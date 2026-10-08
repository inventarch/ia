import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { PHASES, PRIMITIVE_ANCHORS, SHAPE_ROWS } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { expect, it } from 'vitest';
import {
  Door,
  K0,
  SCOPE_KEY_CAPS,
  context,
  normalizeScopeKey,
  prepareCoordinate,
  resolveScopeKey,
  rootRelative,
  select,
} from '../src/index.js';
import type { ScopeKey, Shape } from '../src/index.js';
import { database, lawId, lawPath, methodId, put, workspace } from './workspace.js';

// R14 (position-and-projection §1, design item 10; decision scope-key-caps): the scope key, its caps, defaults and K0,
// its seat and the coordinate it derives, kept apart from the frozen version 1 context and select requests.
const foundation = 'workspace-system/definition/workspace/foundation-workspace',
  governanceSystem = 'floor/definition/system/governance-system',
  sampleMandate = 'agent-system/policy/mandate/sample-mandate';
/** A key refusal, and, when `next` is given, the one command it names (design row 27). */
const invalid = (message: string, next?: string) =>
  expect.objectContaining({
    code: 'IA-RUNTIME-REQUEST-INVALID',
    message: expect.stringContaining(message),
    ...(next === undefined ? {} : { next }),
  });
const keyed = (part: Readonly<Record<string, unknown>>) => ({ ...K0, ...part }) as unknown as ScopeKey;
const partial = (part: Readonly<Record<string, unknown>>) => part as Partial<ScopeKey>;
const outside = (path: string) =>
  invalid(`Scope key seat path '${path}' must be inside the workspace: workspace-relative, or absolute under its root`);

it('publishes the caps and K0 of decision scope-key-caps', () => {
  expect(SCOPE_KEY_CAPS).toEqual({ depth: 2, budget: 64 });
  // K0 = (workspace seat, context, orient, 0, 0, no word): no seat or word is named.
  expect(K0).toEqual({ shape: 'context', phase: 'orient', depth: 0, budget: 0 });
  expect(Object.isFrozen(K0) && Object.isFrozen(SCOPE_KEY_CAPS)).toBe(true);
});

it('completes a partial key with the defaults of design §1, an empty one being K0', () => {
  for (const empty of [undefined, {}, partial({ seat: undefined, shape: undefined, word: undefined })])
    expect(normalizeScopeKey(empty)).toBe(K0);
  // Naming any part takes depth 1 and budget 16, and the phase is the anchor of the shape's primitive.
  const anchors = { context: 'orient', governance: 'plan', execution: 'act', sequence: 'plan', learning: 'learn' };
  for (const shape of Object.keys(SHAPE_ROWS) as Shape[]) {
    expect(anchors[shape]).toBe(PRIMITIVE_ANCHORS[SHAPE_ROWS[shape].primitive]);
    expect(normalizeScopeKey({ shape })).toEqual({ shape, phase: anchors[shape], depth: 1, budget: 16 });
  }
  expect(normalizeScopeKey({ seat: lawId })).toEqual({
    seat: lawId,
    shape: 'context',
    phase: 'orient',
    depth: 1,
    budget: 16,
  });
  expect(normalizeScopeKey({ word: 'law' })).toEqual({
    shape: 'context',
    phase: 'orient',
    depth: 1,
    budget: 16,
    word: 'law',
  });
  expect(normalizeScopeKey({ phase: 'act' })).toEqual({ shape: 'context', phase: 'act', depth: 1, budget: 16 });
  expect(normalizeScopeKey({ depth: 0 })).toEqual({ shape: 'context', phase: 'orient', depth: 0, budget: 16 });
  expect(normalizeScopeKey({ budget: 0 })).toEqual({ shape: 'context', phase: 'orient', depth: 1, budget: 0 });
  // A key naming every part keeps them, in K order, frozen and apart from what was supplied.
  const supplied = { word: 'law', budget: 64, depth: 2, phase: 'learn', shape: 'sequence', seat: { path: lawPath } };
  const got = normalizeScopeKey(supplied as Partial<ScopeKey>);
  expect(JSON.stringify(got)).toBe(
    `{"seat":{"path":"${lawPath}"},"shape":"sequence","phase":"learn","depth":2,"budget":64,"word":"law"}`,
  );
  supplied.seat.path = 'elsewhere';
  expect(got.seat).toEqual({ path: lawPath });
  expect(Object.isFrozen(got) && Object.isFrozen(got.seat)).toBe(true);
  // The defaults are a key's own: K0 itself names every part, so it is kept as it is.
  expect(normalizeScopeKey(K0)).toEqual(K0);
});

it('resolves a key that names only a shape, and refuses depth 3 or budget 65 before any default', () => {
  const db = database(workspace()),
    within = db.resolveScope().token;
  const got = resolveScopeKey(db, within, normalizeScopeKey({ shape: 'governance' }));
  expect(got.key).toEqual({ shape: 'governance', phase: 'plan', depth: 1, budget: 16 });
  expect(got.seat).toEqual({ kind: 'workspace', identity: foundation });
  expect(got.coordinate.values).toEqual({
    shape: 'governance',
    phase: 'plan',
    category: 'rule',
    primitive: 'Inference',
  });
  expect(resolveScopeKey(db, within, normalizeScopeKey())).toEqual(resolveScopeKey(db, within, K0));
  for (const part of [{ depth: 3 }, { shape: 'governance', depth: 3 }])
    expect(() => normalizeScopeKey(partial(part))).toThrow(invalid('Scope key depth must be an integer in 0..2'));
  for (const part of [{ budget: 65 }, { seat: lawId, budget: 65 }])
    expect(() => normalizeScopeKey(partial(part))).toThrow(invalid('Scope key budget must be an integer in 0..64'));
});

it('refuses a partial key outside the closed sets, caps and seat form, and reads nothing to complete one', () => {
  const normalizing = (part: Readonly<Record<string, unknown>>) => () => normalizeScopeKey(partial(part));
  // An unknown part is refused even where nothing else is named; a key never declares its primitive.
  for (const part of ['primitive', 'text', 'within'])
    expect(normalizing({ [part]: undefined })).toThrow(
      invalid(`Unknown scope key part '${part}'; admitted: seat, shape, phase, depth, budget, word`, 'ia position'),
    );
  for (const key of [null, [], 'K0'])
    expect(() => normalizeScopeKey(key as unknown as Partial<ScopeKey>)).toThrow(
      invalid('A scope key must be an object', 'ia position'),
    );
  // A shape is checked before its anchor phase is taken, and null names a part as any other value does.
  for (const shape of ['invented', 'Context', null, 3])
    expect(normalizing({ shape })).toThrow(
      invalid('Scope key shape must be one of context, governance, execution, sequence, learning'),
    );
  for (const phase of ['review', null])
    expect(normalizing({ phase })).toThrow(invalid('Scope key phase must be one of orient, plan, act, learn'));
  for (const value of [-1, 1.5, '1', null]) {
    expect(normalizing({ depth: value })).toThrow(invalid('Scope key depth must be an integer in 0..2'));
    expect(normalizing({ budget: value })).toThrow(invalid('Scope key budget must be an integer in 0..64'));
  }
  for (const seat of [null, 7, {}, { path: 1 }, ['src']])
    expect(normalizing({ seat })).toThrow(invalid('Scope key seat must be a record identity or {path}'));
  expect(normalizing({ word: null })).toThrow(invalid('Scope key word must be a string'));
  // Nothing is read: the word and the seat are checked when the key is resolved through a scope.
  const db = database(workspace()),
    within = db.resolveScope().token,
    unread = normalizeScopeKey({ seat: { path: '../x' }, word: 'widget' });
  expect(unread).toEqual({
    seat: { path: '../x' },
    shape: 'context',
    phase: 'orient',
    depth: 1,
    budget: 16,
    word: 'widget',
  });
  expect(() => resolveScopeKey(db, within, unread)).toThrow(invalid("Scope key word 'widget' is not registered"));
  expect(() => resolveScopeKey(db, within, { ...unread, word: 'law' })).toThrow(outside('../x'));
});

it('seats K0 at the repository workspace and derives its primitive from the shape row', () => {
  const db = database(workspace()),
    within = db.resolveScope().token,
    got = resolveScopeKey(db, within, K0);
  expect(got.key).toEqual(K0);
  // The resolved seat is the workspace; the database's resolution of '' keeps the record declared there and the rule.
  expect(got.seat).toEqual({ kind: 'workspace', identity: foundation });
  expect(got.resolution).toEqual({ path: '', seat: foundation, by: 'repository', claimants: [] });
  expect(got.coordinate.values).toEqual({
    shape: 'context',
    phase: 'orient',
    category: 'relation',
    primitive: 'Attention',
  });
  expect(got.coordinate.sources).toMatchObject({
    shape: 'declared',
    phase: 'declared',
    category: 'derived',
    primitive: 'derived',
  });
  expect(got.coordinate.focus).toEqual({
    kinds: ['definition', 'contract'],
    lanes: ['definitions', 'contracts'],
    predicates: ['cite', 'ground', 'require'],
  });
  for (const part of [
    got,
    got.key,
    got.seat,
    got.resolution,
    got.coordinate,
    got.coordinate.values,
    got.coordinate.sources,
  ])
    expect(Object.isFrozen(part)).toBe(true);
});

it('completes a key from shape and phase alone, where a version 1 coordinate still lacks its primitive', () => {
  const db = database(workspace()),
    within = db.resolveScope().token;
  for (const shape of Object.keys(SHAPE_ROWS) as Shape[])
    for (const phase of PHASES) {
      const { coordinate } = resolveScopeKey(db, within, { shape, phase, depth: 1, budget: 16 }),
        { primitive, ...values } = coordinate.values,
        { primitive: source, ...sources } = coordinate.sources;
      expect(primitive).toBe(SHAPE_ROWS[shape].primitive);
      expect(source).toBe('derived');
      // The completeness rule that refuses a context or select request: phase and primitive are both present.
      expect(['phase', 'primitive'].filter((axis) => coordinate.values[axis as 'phase'] === undefined)).toEqual([]);
      // Everything else is what prepareCoordinate makes of the same declaration, which leaves the primitive absent.
      const request = prepareCoordinate('', { shape, phase });
      expect(request.values.primitive).toBeUndefined();
      expect(request.sources.primitive).toBe('absent');
      expect(values).toEqual(request.values);
      expect(sources).toEqual((({ primitive: _primitive, ...rest }) => rest)(request.sources));
      expect(coordinate.focus).toEqual(request.focus);
    }
});

it('still refuses a version 1 context or select request that declares only shape and phase, byte for byte', () => {
  const root = workspace(),
    db = database(root),
    within = db.resolveScope().token,
    coordinate = { shape: K0.shape, phase: K0.phase };
  // The bytes the frozen routes returned before the scope key existed.
  const refusal =
    '{"ok":false,"code":"coordinate-incomplete","escalation":"coordinate-incomplete","message":"Declare primitive on the request","missing":["primitive"]}';
  expect(JSON.stringify(context(db, { within, text: '', coordinate }, { tokens: 4000, records: 50 }))).toBe(refusal);
  expect(JSON.stringify(select(db, { within, text: '', coordinate }, [methodId]))).toBe(refusal);
  const door = new Door(root, { cache: false });
  try {
    expect(JSON.stringify(door.request({ operation: 'context', params: { text: '', coordinate } }))).toBe(refusal);
    expect(
      JSON.stringify(door.request({ operation: 'select', params: { text: '', coordinate, candidates: [methodId] } })),
    ).toBe(refusal);
    // A key is not a version 1 parameter: the context route still refuses scope key parts.
    expect(door.request({ operation: 'context', params: { text: '', coordinate, depth: 0 } })).toMatchObject({
      ok: false,
      code: 'IA-RUNTIME-REQUEST-INVALID',
    });
  } finally {
    door.close();
  }
});

it('refuses depth 3 or budget 65, naming each cap', () => {
  const db = database(workspace()),
    within = db.resolveScope().token,
    resolving = (part: Readonly<Record<string, unknown>>) => () => resolveScopeKey(db, within, keyed(part));
  expect(resolving({ depth: 3 })).toThrow(invalid('Scope key depth must be an integer in 0..2'));
  expect(resolving({ budget: 65 })).toThrow(invalid('Scope key budget must be an integer in 0..64'));
  for (const value of [-1, 1.5, '1', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(resolving({ depth: value })).toThrow(invalid('Scope key depth must be an integer in 0..2'));
    expect(resolving({ budget: value })).toThrow(invalid('Scope key budget must be an integer in 0..64'));
  }
  for (const depth of [0, 1, 2])
    for (const budget of [0, 48, 64])
      expect(resolveScopeKey(db, within, keyed({ depth, budget })).key).toEqual({ ...K0, depth, budget });
});

it('refuses a shape, phase or part outside the closed sets, and reads only through a scope token', () => {
  const root = workspace(),
    db = database(root),
    within = db.resolveScope().token,
    resolving = (part: Readonly<Record<string, unknown>>) => () => resolveScopeKey(db, within, keyed(part));
  for (const shape of ['invented', 'Context', undefined, 3])
    expect(resolving({ shape })).toThrow(
      invalid('Scope key shape must be one of context, governance, execution, sequence, learning'),
    );
  for (const phase of ['review', 'Orient', undefined])
    expect(resolving({ phase })).toThrow(invalid('Scope key phase must be one of orient, plan, act, learn'));
  // The primitive is derived, never declared on a key.
  expect(resolving({ primitive: 'Memory' })).toThrow(
    invalid("Unknown scope key part 'primitive'; admitted: seat, shape, phase, depth, budget, word", 'ia position'),
  );
  for (const key of [null, [], 'K0'])
    expect(() => resolveScopeKey(db, within, key as unknown as ScopeKey)).toThrow(
      invalid('A scope key must be an object', 'ia position'),
    );
  expect(() => resolveScopeKey(db, '', K0)).toThrow(invalid('Runtime reads require an explicit scope token'));
  // Every seat form and the word read through the token, and a database token failure keeps its code: forged, stale
  // after a source change or closed with the handle.
  const keys = [K0, { ...K0, seat: lawId }, { ...K0, seat: { path: lawPath } }, { ...K0, word: 'law' }];
  const failing = (token: string, code: string) => {
    for (const key of keys)
      expect(() => resolveScopeKey(db, token, key)).toThrow(expect.objectContaining({ code: `IA-DB-${code}` }));
  };
  failing('forged', 'SCOPE-UNAVAILABLE');
  // The parts, closed sets, caps and seat form are checked before any read, whatever the token.
  expect(() => resolveScopeKey(db, 'forged', keyed({ seat: 7, word: 'law' }))).toThrow(
    invalid('Scope key seat must be a record identity or {path}'),
  );
  put(root, '.ia/src/new.ia', '#! ia 1.0\n');
  db.refresh();
  failing(within, 'STALE');
  const fresh = db.resolveScope().token;
  db.close();
  failing(fresh, 'CLOSED');
});

it('accepts only a word registered in the closure', () => {
  const db = database(workspace()),
    within = db.resolveScope().token;
  expect(resolveScopeKey(db, within, { ...K0, word: 'law' }).key).toEqual({ ...K0, word: 'law' });
  expect(resolveScopeKey(db, within, { ...K0, word: 'system' }).key.word).toBe('system');
  expect(() => resolveScopeKey(db, within, { ...K0, word: 'widget' })).toThrow(
    invalid(
      `Scope key word 'widget' is not registered in this closure; registered: ${db.words({ within }).join(', ')}`,
    ),
  );
  expect(() => resolveScopeKey(db, within, keyed({ word: 7 }))).toThrow(invalid('Scope key word must be a string'));
});

// This case rebuilds full native vocabulary views for a second root, as db's scope tests do.
it("checks the word against the registry of the scope's own view (db D09a)", () => {
  const root = workspace(),
    prefix = '.ia/src/systems/extension',
    locations: Record<string, Location> = {};
  const files = {
    'system.ia':
      '#! ia 1.0\n@system extension\n  provider "fixture"\n  version "1.0.0"\n  steward @agent extension-steward\n  requires\n    - agent-system\n  discriminators\n    widget lowers to definition\n      category thing\n      facets [widget]\n      schema @schema widget\n  edges\n    cite * using *\n',
    'schemas/widget.ia': '#! ia 1.0\n@schema widget\n  lowers to definition\n  sections\n    open\n',
    'steward.ia':
      '#! ia 1.0\n@agent extension-steward\n  meaning\n    says "Own extension"\n    answers "Who owns widget?"\n  governance\n    applies [widget]\n',
    'one.ia': '#! ia 1.0\n@widget one\n',
  };
  for (const [name, text] of Object.entries(files)) {
    const path = `${prefix}/${name}`;
    put(root, path, text);
    locations[path] = { placement: { kind: 'authored', band: 100, reach: 'team' }, provenance: 'workspace' };
  }
  const db = database(root, { locations }),
    team = db.resolveScope({ root: 'team' }).token,
    within = db.resolveScope().token;
  // Only the team root's view admits the extension, so only a key read through it may name its word.
  expect(resolveScopeKey(db, team, { ...K0, word: 'widget' }).key).toEqual({ ...K0, word: 'widget' });
  expect(() => resolveScopeKey(db, within, { ...K0, word: 'widget' })).toThrow(
    invalid("Scope key word 'widget' is not registered in this closure"),
  );
});

it('resolves a seat named by identity or by path, keeping the database resolution apart from the seat', () => {
  const db = database(workspace()),
    within = db.resolveScope().token;
  const record = resolveScopeKey(db, within, { ...K0, seat: lawId });
  expect(record.key).toEqual({ ...K0, seat: lawId });
  expect(record.seat).toEqual({ kind: 'record', identity: lawId });
  expect(record.resolution).toBeUndefined();
  const absent = 'governance-system/governance/law/absent';
  expect(() => resolveScopeKey(db, within, { ...K0, seat: absent })).toThrow(
    invalid(`Scope key seat '${absent}' is not an admitted record in this scope`),
  );
  // A record outside the scope is not a seat in it.
  const narrow = db.resolveScope({ identities: [methodId] }).token;
  expect(() => resolveScopeKey(db, narrow, { ...K0, seat: lawId })).toThrow(
    invalid(`Scope key seat '${lawId}' is not an admitted record in this scope`),
  );
  // Nor is a path declared outside it: the scope prunes the record declared there and the claimants (db D02b, D09).
  expect(resolveScopeKey(db, narrow, { ...K0, seat: { path: lawPath } })).toMatchObject({
    seat: { kind: 'location', path: lawPath, unknown: 'undeclared' },
    resolution: { path: lawPath, unknown: 'undeclared', claimants: [] },
  });
  // A location is the seat; the record it is declared at (db D02b) and the rule stay in the resolution, with the
  // claimants.
  const location = resolveScopeKey(db, within, { ...K0, seat: { path: lawPath } });
  expect(location.seat).toEqual({ kind: 'location', path: lawPath });
  expect(location.resolution).toEqual({ path: lawPath, seat: governanceSystem, by: 'system', claimants: [] });
  // The key keeps the canonical path the location resolved to.
  const docs = resolveScopeKey(db, within, { ...K0, seat: { path: 'docs\\guide.md' } });
  expect(docs.key.seat).toEqual({ path: 'docs/guide.md' });
  expect(docs.seat).toEqual({ kind: 'location', path: 'docs/guide.md' });
  expect(docs.resolution).toMatchObject({ path: 'docs/guide.md', seat: foundation, by: 'repository' });
  expect(docs.resolution!.claimants.map((claimant) => claimant.identity)).toEqual([sampleMandate]);
  // A path no seat declares is not refused: the unknown is named and the claimants kept (design row 17).
  expect(resolveScopeKey(db, within, { ...K0, seat: { path: '.ia/work/notes.md' } })).toMatchObject({
    key: { seat: { path: '.ia/work/notes.md' } },
    seat: { kind: 'location', path: '.ia/work/notes.md', unknown: 'undeclared' },
    resolution: { path: '.ia/work/notes.md', unknown: 'undeclared', claimants: [] },
  });
  for (const path of ['../x', 'src/../../x', '/x', '\\x', 'C:/x', 'C:\\x', 'C:x', '//server/share/x'])
    expect(() => resolveScopeKey(db, within, { ...K0, seat: { path } })).toThrow(outside(path));
  for (const seat of [null, 7, {}, { path: 1 }, { path: 'src', root: '' }, ['src']])
    expect(() => resolveScopeKey(db, within, keyed({ seat }))).toThrow(
      invalid('Scope key seat must be a record identity or {path}'),
    );
});

it('reads an absolute path inside the root as the root-relative path it names', () => {
  const db = database(workspace()),
    within = db.resolveScope().token,
    seated = (path: string) => resolveScopeKey(db, within, { ...K0, seat: { path } }),
    slashed = db.root.split(sep).join('/');
  const unrooted = (got: unknown) => {
    for (const root of [slashed, JSON.stringify(db.root).slice(1, -1)]) expect(JSON.stringify(got)).not.toContain(root);
  };
  // Native separators, forward slashes and a mix of both name the same location, and the key never carries the root.
  for (const path of [resolve(db.root, lawPath), `${slashed}/${lawPath}`, `${db.root}${sep}${lawPath}`]) {
    expect(seated(path)).toEqual(seated(lawPath));
    unrooted(seated(path));
  }
  expect(seated(resolve(db.root, 'docs', 'guide.md'))).toEqual(seated('docs/guide.md'));
  // The root itself is the location '', however it is spelled; it is not the workspace seat K0 takes.
  const top = seated('');
  expect(top.key).toEqual({ ...K0, seat: { path: '' } });
  expect(top.seat).toEqual({ kind: 'location', path: '' });
  expect(top.resolution).toEqual({ path: '', seat: foundation, by: 'repository', claimants: [] });
  for (const path of ['.', './', 'src/..', db.root, slashed, `${db.root}${sep}`, `${slashed}/.`, `${slashed}/src/..`]) {
    expect(seated(path)).toEqual(top);
    unrooted(seated(path));
  }
  // A name that only begins with '..' is inside the root, spelled relative or absolute; only a '..' segment escapes.
  for (const path of ['..cache', '..cache/x.md', '...x']) expect(seated(resolve(db.root, path))).toEqual(seated(path));
  expect(seated(`${slashed}/..cache/x.md`).seat).toEqual({ kind: 'location', path: '..cache/x.md' });
  // Every absolute path outside the root is refused, a sibling whose name begins with the root's included.
  for (const path of [
    resolve(db.root, '..'),
    resolve(db.root, '..', 'elsewhere', lawPath),
    `${db.root}-sibling${sep}${lawPath}`,
    `${slashed}/../x`,
    `${slashed}/src/../../${lawPath}`,
  ])
    expect(() => seated(path)).toThrow(outside(path));
});

it('exports the one absolute-path rule that a location seat and an ia read locator share', () => {
  const root = resolve(workspace()),
    slashed = root.split(sep).join('/');
  // A path inside the root, in native separators, forward slashes or a mix, is its `/`-separated relative path.
  for (const path of [resolve(root, lawPath), `${slashed}/${lawPath}`, `${root}${sep}${lawPath}`])
    expect(rootRelative(root, path), path).toBe(lawPath);
  // The root itself is '', the workspace root, however it is spelled.
  for (const path of [root, slashed, `${root}${sep}`, `${slashed}/.`, `${slashed}/src/..`])
    expect(rootRelative(root, path), path).toBe('');
  // The check is segment by segment: a name that only begins with '..' is inside; a '..' segment escapes.
  for (const path of ['..cache', '..cache/x.md', '...x'])
    expect(rootRelative(root, resolve(root, path)), path).toBe(path);
  for (const path of [resolve(root, '..'), `${slashed}/../x`, `${root}-sibling${sep}${lawPath}`])
    expect(rootRelative(root, path), path).toBeUndefined();
  // A relative path is the database's to canonicalise, so it is returned as given, an escaping one included.
  for (const path of [lawPath, '../outside.md', '.']) expect(rootRelative(root, path)).toBe(path);
  if (process.platform === 'win32') {
    const other = `${root.slice(0, 2).toUpperCase() === 'Z:' ? 'Y:' : 'Z:'}${root.slice(2)}\\${lawPath}`;
    expect(rootRelative(root, other)).toBeUndefined();
    expect(rootRelative(root, `${root.slice(0, 2).toLowerCase()}${root.slice(2)}\\${lawPath}`)).toBe(lawPath);
  }
});

it.skipIf(process.platform !== 'win32')('reads a Windows absolute path as the file system compares it', () => {
  const db = database(workspace()),
    within = db.resolveScope().token,
    relative = resolveScopeKey(db, within, { ...K0, seat: { path: lawPath } });
  const drive = db.root.slice(0, 2),
    rest = db.root.slice(2);
  // A drive letter in either case and backslashes beside forward slashes name the same location under the root.
  for (const root of [drive.toLowerCase() + rest, drive.toUpperCase() + rest, db.root.toUpperCase()])
    expect(resolveScopeKey(db, within, { ...K0, seat: { path: `${root}\\${lawPath}` } })).toEqual(relative);
  // Another drive is outside the root whatever its path.
  const other = `${drive.toUpperCase() === 'Z:' ? 'Y:' : 'Z:'}${rest}\\${lawPath.replaceAll('/', '\\')}`;
  expect(() => resolveScopeKey(db, within, { ...K0, seat: { path: other } })).toThrow(outside(other));
});

/** A second @workspace in the repository's own tree, declaring `sources`. */
function billing(root: string, sources: readonly string[]): string {
  put(
    root,
    '.ia/src/systems/workspace-system/records/billing-workspace.ia',
    [
      '#! ia 1.0',
      '',
      '@workspace billing-workspace',
      '  meaning',
      '    says "The billing fixture boundary."',
      '    answers "Which roots does it declare?"',
      '  composition',
      '    systems [@system governance-system]',
      ...(sources.length > 0 ? [`    sources [${sources.map((s) => JSON.stringify(s)).join(', ')}]`] : []),
      '',
    ].join('\n'),
  );
  return 'workspace-system/definition/workspace/billing-workspace';
}

it('seats K0 at the workspace declaring the whole repository as a root, before the repository rule', () => {
  const root = workspace(),
    workspacePath = '.ia/src/systems/workspace-system/records/foundation-workspace.ia';
  // Both workspaces declare a root, so D02b decides no repository workspace; billing's `.` holds the repository root.
  const own = billing(root, ['. @authored']);
  put(
    root,
    workspacePath,
    readFileSync(resolve(root, workspacePath), 'utf8').replace(
      '  relationships\n',
      '    sources ["src @authored"]\n  relationships\n',
    ),
  );
  const db = database(root);
  expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  // The premise: foundation now declares `src`, the longer root under it.
  expect(db.resolveSeat('src/a.ts')).toMatchObject({ seat: foundation, by: 'root' });
  expect(db.resolveSeat('lib/a.ts')).toMatchObject({ seat: own, by: 'root' });
  const got = resolveScopeKey(db, db.resolveScope().token, K0);
  expect(got.seat).toEqual({ kind: 'workspace', identity: own });
  expect(got.resolution).toEqual({ path: '', seat: own, by: 'root', claimants: [] });
});

it('names the unknown instead of refusing K0 when the repository workspace is undecided', () => {
  // Two @workspace records in the repository's own tree and neither declares a root: none is its own.
  const root = workspace();
  billing(root, []);
  for (const db of [database(root), database(workspace(null))]) {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const got = resolveScopeKey(db, db.resolveScope().token, K0);
    expect(got.seat).toEqual({ kind: 'workspace', unknown: 'undeclared' });
    expect(got.resolution).toEqual({ path: '', unknown: 'undeclared', claimants: [] });
    expect(got.key).toEqual(K0);
  }
});

it('resolves equal keys to equal results, copying the key in K order', () => {
  const db = database(workspace()),
    supplied = { word: 'law', budget: 16, depth: 1, phase: 'plan', shape: 'governance', seat: { path: lawPath } };
  const got = resolveScopeKey(db, db.resolveScope().token, supplied as ScopeKey);
  expect(JSON.stringify(got.key)).toBe(
    `{"seat":{"path":"${lawPath}"},"shape":"governance","phase":"plan","depth":1,"budget":16,"word":"law"}`,
  );
  supplied.seat.path = 'elsewhere';
  supplied.word = 'plan';
  expect(got.key).toMatchObject({ seat: { path: lawPath }, word: 'law' });
  // Another scope of the same view resolves the same key to the same result.
  expect(resolveScopeKey(db, db.resolveScope().token, got.key)).toEqual(got);
  expect(got.coordinate.values).toMatchObject({ shape: 'governance', phase: 'plan', primitive: 'Inference' });
});
