/**
 * The Door's `read` operation (MACHINE_PROTOCOL version 2, SPEC R12): `readBody` bound to the door's scope by identity,
 * reading documents through db `readWorkspaceBytes` (or the host's injected reader) and adopted mounts through the
 * `.ia/workspace.json` bindings, over copies of the conformance corpus and the loop fixture. A narrowed scope's misses
 * are one plain refusal, a whole-workspace one's name what the sources hold, and no refusal names the server's root.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { stableSerialize } from '@inventarch/graph';
import { readInputs } from '@inventarch/db';
import type { Location } from '@inventarch/language';
import { Door, MACHINE_PROTOCOL, readBody } from '../src/index.js';
import type { DoorOptions, DoorResponse, Scope } from '../src/index.js';
import { database, methodId, methodPath, put, workspace } from './workspace.js';

const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const MIXED = '.ia/src/systems/agent-system/records/mixed.ia';
const INSIDE = 'agent-system/binding/agent/inside-agent',
  OUTSIDE = 'agent-system/binding/agent/outside-agent',
  FOREIGN = 'governance-system/definition/procedure/foreign-procedure';
const CONTRACT = 'compliance-system/contract/signature/foundation-authoring-contract';
const SPECS = '.ia/src/systems/work-system/records/located.ia';
/** One source holding a record the narrowed boundary admits, one it leaves out and one admission refuses. */
const MIXED_TEXT = [
  '#! ia 1.0',
  '@agent inside-agent',
  '  meaning',
  '    says "Inside the scope."',
  '    answers "Who is inside?"',
  '  governance',
  '    applies []',
  '',
  '@agent outside-agent',
  '  meaning',
  '    says "Outside the scope."',
  '    answers "Who is outside?"',
  '  governance',
  '    applies []',
  '',
  // A @playbook is the governance system's word, so the agent system's folder cannot author one.
  '@playbook foreign-procedure',
  '  meaning',
  '    says "Foreign here."',
  '    answers "What is foreign?"',
  '  cognition',
  '    act',
  '      primary Decision',
  '      Decision means "Foreign."',
  '',
].join('\n');
const spec = (name: string, source: string): string =>
  `\n@spec ${name}\n  meaning\n    says "The ${name} statement."\n    answers "Where is ${name} written?"\n  work\n    title "${name}"\n    status draft\n    source "${source}"\n`;
const SECTION = '## Reading a body\n\nThe body behind a locator.\n\n';
const DOCUMENT = `# Located\n\n${SECTION}## Next\n\nAnother section.\n`;
/** The one refusal a scoped read gives for every locator outside its scope. */
const MISS = { ok: false, code: 'IA-RUNTIME-READ-UNADMITTED', message: 'The locator is not in this scope' };
const RUNTIME: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' };
const PRINCIPLE_PATH = '.ia/src/systems/governance-system/records/sample-principle.ia',
  PRINCIPLE = 'governance-system/governance/principle/sample-principle';

/** The conformance corpus with the mixed source and specs whose source locators name documents in and under a link. */
function corpus(): string {
  const root = workspace();
  put(root, MIXED, MIXED_TEXT);
  put(
    root,
    SPECS,
    [
      '#! ia 1.0\n',
      spec('whole-spec', 'docs/located.md'),
      spec('section-spec', 'docs/located.md#reading-a-body'),
      spec('absent-spec', 'docs/absent.md'),
      spec('linked-spec', 'linked/located.md'),
      spec('hard-linked-spec', 'docs/hard-linked.md'),
    ].join(''),
  );
  put(root, 'docs/located.md', DOCUMENT);
  // A second name for one file, which neither source admission nor the reader admits.
  put(root, 'docs/original.md', DOCUMENT);
  linkSync(resolve(root, 'docs/original.md'), resolve(root, 'docs/hard-linked.md'));
  // A directory reached through a junction, which the reader refuses to read through.
  const target = workspace(null);
  writeFileSync(resolve(target, 'located.md'), DOCUMENT);
  symlinkSync(target, resolve(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}
function door(root: string, options: DoorOptions = {}): Door {
  return new Door(root, { cache: false, ...options });
}
const reading =
  (gate: Door) =>
  (locator: string, params: Record<string, unknown> = {}): DoorResponse =>
    gate.request({ operation: 'read', params: { locator, ...params } });

it('reads inside a narrowed boundary and refuses every locator outside it alike, naming nothing beyond it', () => {
  const root = corpus(),
    narrowed = door(root, { boundary: { identities: [INSIDE, methodId, CONTRACT] } }),
    read = reading(narrowed);
  try {
    // In-scope reads succeed: the record's own body, a cell, a requirement and a line of its span.
    expect(read(INSIDE)).toEqual({
      ok: true,
      result: {
        locator: INSIDE,
        identity: INSIDE,
        kind: 'record',
        digest: sha256('Inside the scope.'),
        body: 'Inside the scope.',
        certified: false,
      },
    });
    expect(read(`${methodId}#act/Decision`)).toMatchObject({
      ok: true,
      result: { body: 'Sample fixture statement 18.' },
    });
    expect(read(`${CONTRACT}#REQ-FOUNDATION-INPUT`)).toMatchObject({ ok: true, result: { identity: CONTRACT } });
    expect(read(`${MIXED}:4`)).toMatchObject({ ok: true, result: { identity: INSIDE, locator: `${MIXED}:4` } });
    const steward = 'agent-system/binding/agent/agent-steward';
    const outside = database(root).get(steward)!.source;
    // The boundary is by identity: the record beside it in the same source, the refused one there, and another
    // source's record, by identity, fragment and line, each get the same plain refusal, which names no path, line,
    // identity or refused record.
    for (const locator of [
      OUTSIDE,
      `${MIXED}:11`,
      FOREIGN,
      `${FOREIGN}#act/Decision`,
      `${MIXED}:20`,
      steward,
      `${steward}#act/Decision`,
      `${outside.path}:${outside.line}`,
      `${MIXED}:999`,
      'agent-system/binding/agent/absent',
      '../outside.ia:3',
    ]) {
      const got = read(locator);
      expect(got, locator).toEqual(MISS);
      expect(JSON.stringify(got), locator).not.toMatch(/mixed|agent-steward|steward\.ia|foreign|outside|absent/);
    }
  } finally {
    narrowed.close();
  }
  // Unscoped, a reader of the same workspace says what the sources hold there: exactly what the scope keeps back.
  const db = database(root),
    options = { read: () => new Uint8Array() };
  expect(readBody(db, FOREIGN, options)).toMatchObject({
    code: 'IA-RUNTIME-READ-UNADMITTED',
    path: MIXED,
    file: 'refused',
  });
  expect(readBody(db, `${MIXED}:20`, options)).toMatchObject({ path: MIXED, line: 20, file: 'refused' });
  expect(readBody(db, OUTSIDE, options)).toMatchObject({ ok: true });
  // readBody itself binds to the token it is given, and a token failure keeps its database code.
  const within = db.resolveScope({ identities: [INSIDE] }).token;
  for (const locator of [OUTSIDE, FOREIGN, `${MIXED}:11`, `${MIXED}:20`])
    expect(readBody(db, locator, { ...options, within }), locator).toEqual(MISS);
  expect(readBody(db, INSIDE, { ...options, within })).toMatchObject({ ok: true, body: { identity: INSIDE } });
  expect(() => readBody(db, INSIDE, { ...options, within: 'forged' })).toThrow('IA-DB-SCOPE-UNAVAILABLE');
});

it('reads through the scope its token names: the initial boundary when within is omitted, a narrowed one when passed', () => {
  const root = corpus(),
    gate = door(root),
    read = reading(gate);
  try {
    const scoped = gate.request({ operation: 'scope', params: { identities: [INSIDE] } });
    if (!scoped.ok) throw new Error('Fixture scope failed');
    const token = (scoped.result as Scope).token;
    expect(read(OUTSIDE)).toMatchObject({ ok: true, result: { identity: OUTSIDE } });
    expect(read(OUTSIDE, { within: token })).toEqual(MISS);
    expect(read(INSIDE, { within: token })).toMatchObject({ ok: true, result: { identity: INSIDE } });
    // Every miss in the narrowed scope is the plain refusal; the initial whole-workspace boundary's are not (below).
    expect(read(FOREIGN, { within: token })).toEqual(MISS);
    expect(read('agent-system/binding/agent/absent', { within: token })).toEqual(MISS);
    expect(read(INSIDE, { within: 'forged' })).toMatchObject({ ok: false, code: 'IA-DB-SCOPE-UNAVAILABLE' });
    for (const params of [{}, { locator: 3 }, { locator: 'Not/A/Locator' }, { locator: INSIDE, includeRuntime: 'yes' }])
      expect(gate.request({ operation: 'read', params }), JSON.stringify(params)).toMatchObject({
        ok: false,
        code: 'IA-RUNTIME-REQUEST-INVALID',
      });
  } finally {
    gate.close();
  }
  expect(read(INSIDE)).toMatchObject({ ok: false, code: 'IA-DB-CLOSED' });
});

// One disclosure rule for the version 2 operations (R12, db PT5), as next has it: only a whole-workspace token names a
// record admission refused, with its reason. A token is one when its scope, and every scope it was issued under, is at
// the workspace root with no phase or identities (db isCompleteScope): the initial token of a door opened without a
// boundary, or with one that narrows nothing, and a token `scope` issues from such a token without narrowing it. A
// token bound to a root below the workspace root, a phase or identities names nothing outside its scope, even one that
// admits every record the workspace admits.
it('names a record admission refused, with its reason, only through a whole-workspace token', () => {
  const root = corpus(),
    db = database(root),
    options = { read: () => new Uint8Array() },
    every = db.records().map((node) => node.identity),
    refused = db.refused.find((record) => record.identity === FOREIGN)!;
  expect(refused).toMatchObject({ path: MIXED, reason: expect.any(String) });
  const gate = door(root),
    read = reading(gate);
  try {
    // The whole workspace's token reads as the root view reads, so its misses are the root view's: the refused record
    // with its path, line and reason, an identity no source holds, and what a source holds at a line.
    expect(read(FOREIGN)).toEqual({
      ok: false,
      code: 'IA-RUNTIME-READ-UNADMITTED',
      message: `${FOREIGN} is in this workspace's sources, but admission refused it`,
      identity: FOREIGN,
      path: MIXED,
      line: refused.line,
      file: 'refused',
      reason: refused.reason,
    });
    for (const locator of [
      FOREIGN,
      'agent-system/binding/agent/absent',
      `${MIXED}:20`,
      `${MIXED}:999`,
      '../outside.ia:3',
    ])
      expect(read(locator), locator).toEqual(readBody(db, locator, options));
    const through = (params: Record<string, unknown>) => {
      const scope = gate.request({ operation: 'scope', params });
      if (!scope.ok) throw new Error(scope.message);
      const within = (scope.result as Scope).token;
      return (locator: string) => read(locator, { within });
    };
    const unbounded = door(root, { boundary: {} }),
      bounded = door(root, { boundary: { identities: every } });
    try {
      // A scope that narrows nothing is the whole workspace however it was issued, so its misses are the initial
      // token's, the refused record named with its reason.
      for (const [label, whole] of [
        ['scope {}', through({})],
        ["scope {root: ''}", through({ root: '' })],
        ['scope {phase: null}', through({ phase: null })],
        ['boundary {}', reading(unbounded)],
      ] as const)
        for (const locator of [FOREIGN, `${MIXED}:20`, 'agent-system/binding/agent/absent'])
          expect(whole(locator), `${label} ${locator}`).toEqual(read(locator));
      for (const [label, narrowed] of [
        ['identities', through({ identities: every })],
        ['phase', through({ phase: 'act' })],
        ['root', through({ root: '.ia/src/systems' })],
        ['bounded', reading(bounded)],
      ] as const)
        for (const locator of [FOREIGN, `${FOREIGN}#act/Decision`, `${MIXED}:20`, 'agent-system/binding/agent/absent'])
          expect(narrowed(locator), `${label} ${locator}`).toEqual(MISS);
      // Admitted records read alike through every token that holds them.
      expect(reading(bounded)(OUTSIDE)).toEqual(read(OUTSIDE));
      expect(through({ identities: every })(OUTSIDE)).toEqual(read(OUTSIDE));
    } finally {
      unbounded.close();
      bounded.close();
    }
  } finally {
    gate.close();
  }
});

// The Door's reader names a document by its workspace-relative path alone, never by where the server keeps the
// workspace (R12): the CLI's own reader may name a link by its local path, but a Door answers a remote caller.
it("names a document it cannot read by its path relative to the workspace, never the server's root", () => {
  const root = corpus(),
    canonical = realpathSync(root),
    spellings = (directory: string) => [
      directory,
      directory.replaceAll('\\', '/'),
      JSON.stringify(directory).slice(1, -1),
      basename(directory),
    ];
  put(root, `${SPECS.slice(0, -'.ia'.length)}-escape.ia`, `#! ia 1.0\n${spec('escaping-spec', '../outside.md')}`);
  const target = realpathSync(resolve(root, 'linked')),
    gate = door(root),
    read = reading(gate);
  const unreadable = (name: string, message: RegExp): void => {
    const got = read(`work-system/contract/spec/${name}`);
    expect(got, name).toMatchObject({ ok: false, code: 'IA-RUNTIME-READ-UNREACHABLE' });
    expect(got.ok ? '' : got.message, name).toMatch(message);
    for (const spelling of [...spellings(root), ...spellings(canonical), ...spellings(target)])
      expect(JSON.stringify(got), `${name} ${spelling}`).not.toContain(spelling);
  };
  try {
    unreadable('linked-spec', /Symlink\/junction traversal is not admitted: linked\/located\.md$/);
    unreadable('escaping-spec', /, \.\.\/outside\.md, is outside the workspace$/);
    // The workspace moved while the door serves: the root it opened can no longer be opened, which db names by the
    // root; the door names the document alone.
    renameSync(root, `${root}-moved`);
    try {
      unreadable(
        'whole-spec',
        /cannot be read: IA-DB-ROOT-INVALID: The workspace can no longer be opened to read docs\/located\.md$/,
      );
      expect(read('work-system/contract/spec/whole-spec')).toMatchObject({ path: 'docs/located.md' });
    } finally {
      renameSync(`${root}-moved`, root);
    }
    expect(read('work-system/contract/spec/whole-spec')).toMatchObject({ ok: true, result: { body: DOCUMENT } });
  } finally {
    gate.close();
  }
});

it('reads documents through the db workspace reader or the reader the host injects, refusing a link either way', () => {
  const root = corpus(),
    gate = door(root),
    read = reading(gate);
  try {
    expect(read('work-system/contract/spec/whole-spec')).toEqual({
      ok: true,
      result: {
        locator: 'work-system/contract/spec/whole-spec',
        identity: 'work-system/contract/spec/whole-spec',
        kind: 'document',
        path: 'docs/located.md',
        digest: sha256(readFileSync(resolve(root, 'docs/located.md'))),
        body: DOCUMENT,
        certified: false,
      },
    });
    expect(read('work-system/contract/spec/section-spec')).toMatchObject({
      ok: true,
      result: { path: 'docs/located.md', digest: sha256(SECTION), body: SECTION },
    });
    const unreachable = (name: string, path: string, reason: RegExp): void => {
      const got = read(`work-system/contract/spec/${name}`);
      expect(got, name).toMatchObject({
        ok: false,
        code: 'IA-RUNTIME-READ-UNREACHABLE',
        identity: `work-system/contract/spec/${name}`,
        path,
      });
      expect(got.ok ? '' : got.message, name).toMatch(reason);
    };
    unreachable(
      'absent-spec',
      'docs/absent.md',
      /cannot be read: IA-DB-SOURCE-UNAVAILABLE: Missing file docs\/absent\.md$/,
    );
    // The reader names the link by the document's canonical path alone, never by where the workspace is on disk.
    unreachable(
      'linked-spec',
      'linked/located.md',
      /cannot be read: IA-DB-PATH-UNSAFE: Symlink\/junction traversal is not admitted: linked\/located\.md$/,
    );
    unreachable(
      'hard-linked-spec',
      'docs/hard-linked.md',
      /cannot be read: IA-DB-PATH-UNSAFE: Expected an unaliased regular file: docs\/hard-linked\.md$/,
    );
  } finally {
    gate.close();
  }
  // The host's reader is the one asked, with the canonical workspace-relative path, and the only one.
  const asked: string[] = [],
    injected = door(root, {
      read: (path) => {
        asked.push(path);
        return new TextEncoder().encode('# Injected\n');
      },
    });
  try {
    expect(reading(injected)('work-system/contract/spec/linked-spec')).toMatchObject({
      ok: true,
      result: { kind: 'document', path: 'linked/located.md', body: '# Injected\n', digest: sha256('# Injected\n') },
    });
    expect(asked).toEqual(['linked/located.md']);
  } finally {
    injected.close();
  }
});

const VENDOR = 'vendor/foundation',
  GUIDE = 'authoring-system/definition/authoring-guide/spec-guide';
/** An empty workspace adopting a vendored copy of the conformance corpus whose authoring guide names a document. */
function adopting() {
  const root = workspace(null),
    vendor = VENDOR;
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, vendor, '.ia/src'), {
    recursive: true,
  });
  put(
    root,
    `${vendor}/.ia/src/systems/authoring-system/records/guide.ia`,
    '#! ia 1.0\n@authoring-guide spec-guide\n  meaning\n    says "Guides a spec."\n    answers "How is a spec authored?"\n  reference\n    owner work-system\n    word spec\n    schema @schema spec\n    document "docs/spec-guide.md#writing"\n  guidance\n    select-when "A spec."\n    avoid-when "Not a spec."\n    consider "Fields."\n  relationships\n    cites @schema spec\n',
  );
  put(root, `${vendor}/docs/spec-guide.md`, '# Guide\n\n## Writing\n\nState the status.\n');
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  const sources = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = sha256(stableSerialize(sources));
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  return { root, revision, sources, tree: `.ia/adopted/foundation/${revision}` };
}
const GUIDE_READ = {
  ok: true,
  result: {
    locator: GUIDE,
    identity: GUIDE,
    kind: 'document',
    path: `${VENDOR}/docs/spec-guide.md`,
    digest: sha256('## Writing\n\nState the status.\n'),
    body: '## Writing\n\nState the status.\n',
    certified: false,
  },
};

it("reads an adopted record's document from the directory the manifest binds its mount to, and not from explicit captures", () => {
  const { root, revision, sources, tree } = adopting();
  const bound = door(root);
  try {
    expect(reading(bound)(GUIDE)).toEqual(GUIDE_READ);
  } finally {
    bound.close();
  }
  // Explicit captures replace the manifest's bindings and name no directory, so the same mount is bound to none.
  const captured = door(root, { adopted: [{ id: 'foundation', revision, sources }] });
  try {
    expect(reading(captured)(GUIDE)).toEqual({
      ok: false,
      code: 'IA-RUNTIME-READ-UNREACHABLE',
      message: `The reference.document of ${GUIDE}, docs/spec-guide.md#writing, is in adopted mount ${tree}, which the read binds to no directory`,
      identity: GUIDE,
    });
  } finally {
    captured.close();
  }
});

it('binds the mounts once, when the door opens, so a manifest rewritten later changes no read', () => {
  const { root } = adopting(),
    bound = door(root),
    read = reading(bound);
  try {
    expect(read(GUIDE)).toEqual(GUIDE_READ);
    // A manifest a host rewrites while the door serves, half-written or pinned to another revision, is not read again:
    // reads answer from the bindings of the snapshot the door opened, those needing no mount and the adopted document
    // alike, as get answers from that snapshot.
    for (const manifest of [
      '{"version": 1, "adopted": [',
      JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: VENDOR, revision: 'a'.repeat(64) }] }),
    ]) {
      put(root, '.ia/workspace.json', manifest);
      expect(read(`${methodId}#act/Decision`), manifest).toMatchObject({
        ok: true,
        result: { body: 'Sample fixture statement 18.' },
      });
      expect(read(GUIDE), manifest).toEqual(GUIDE_READ);
      expect(bound.request({ operation: 'get', params: { identity: GUIDE } }).ok, manifest).toBe(true);
    }
  } finally {
    bound.close();
  }
  // A door opened now reads the manifest as it is, and refuses it.
  expect(() => door(root)).toThrow('IA-DB-SOURCE-UNAVAILABLE');
});

// spec-0012 DRF-02 for the version 2 row: its example reads the loop fixture, locator is required, and the refusal list
// is proven both ways. apps/cli/tests/cli.test.ts proves the version 1 rows, which are the CLI's machine routes.
it('holds the read row of the machine protocol table to the Door', () => {
  const row = MACHINE_PROTOCOL.operations.find((operation) => operation.name === 'read')!;
  expect(row).toMatchObject({ since: 2, mcp: 'ia_read' });
  const loop = door(resolve(import.meta.dirname, '../../compliance/fixtures/loop'));
  try {
    expect(loop.request({ operation: 'read', params: row.example })).toMatchObject({
      ok: true,
      result: { identity: methodId, kind: 'record' },
    });
    expect((row.params as { required: readonly string[] }).required).toEqual(['locator']);
    expect(loop.request({ operation: 'read', params: {} }).ok).toBe(false);
  } finally {
    loop.close();
  }
  const root = corpus(),
    placed = door(root, { locations: { [PRINCIPLE_PATH]: RUNTIME } });
  const triggers: Readonly<Record<string, Record<string, unknown>>> = {
    'IA-RUNTIME-REQUEST-INVALID': { locator: INSIDE, unlisted: 1 },
    'IA-DB-SCOPE-UNAVAILABLE': { locator: INSIDE, within: 'forged' },
    'IA-RUNTIME-READ-UNADMITTED': { locator: 'agent-system/binding/agent/absent' },
    'IA-RUNTIME-READ-FRAGMENT': { locator: `${CONTRACT}#REQ-ABSENT` },
    'IA-RUNTIME-READ-UNREACHABLE': { locator: 'work-system/contract/spec/absent-spec' },
    'IA-RUNTIME-READ-PLACEMENT': { locator: PRINCIPLE },
  };
  try {
    const observed = Object.values(triggers).map((params) => {
      const response = placed.request({ operation: 'read', params });
      return response.ok ? 'accepted' : response.code;
    });
    expect(observed).toEqual(Object.keys(triggers));
    expect(row.refusals.map((refusal) => refusal.code).sort()).toEqual(Object.keys(triggers).sort());
    // The placement is judged before the fragment, and includeRuntime reads the record as any other.
    expect(placed.request({ operation: 'read', params: { locator: `${PRINCIPLE}#REQ-ABSENT` } })).toMatchObject({
      code: 'IA-RUNTIME-READ-PLACEMENT',
      identity: PRINCIPLE,
      path: PRINCIPLE_PATH,
    });
    expect(placed.request({ operation: 'read', params: { locator: PRINCIPLE, includeRuntime: true } })).toMatchObject({
      ok: true,
      result: { identity: PRINCIPLE, body: 'Sample fixture statement 1.' },
    });
    expect(placed.request({ operation: 'read', params: { locator: `${methodPath}:3` } })).toMatchObject({
      ok: true,
      result: { identity: methodId },
    });
  } finally {
    placed.close();
  }
});
