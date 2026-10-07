import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPTURE_DIR, captureOf, writeCaptured } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { digest, stableSerialize } from '@inventarch/graph';
import type { Location } from '@inventarch/language';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BODY_DIGEST_FORMAT,
  Door,
  HOST_NOTE_FORMAT,
  bodyDigest,
  normalizeScopeKey,
  position,
  positionBody,
} from '../src/index.js';
import type { HostFacts, Position, ScopeKey } from '../src/index.js';
import { database, methodPath, playbook, put, workspace } from './workspace.js';

const runtime: Location = {
  placement: { kind: 'runtime', band: 0, reach: '' },
  provenance: 'runtime',
};
function at(db: Handle, key: ScopeKey = {}, hostFacts?: () => HostFacts): Position {
  return position(db, db.resolveScope({}).token, normalizeScopeKey(key), hostFacts === undefined ? {} : { hostFacts });
}
const capture = (root: string): void => {
  const db = database(root);
  writeCaptured(root, CAPTURE_DIR, captureOf(db));
};
afterEach(() => {
  vi.useRealTimers();
});

it('hands over the body, its digest and a separate host note', () => {
  const db = database(workspace()),
    within = db.resolveScope({}).token,
    key = normalizeScopeKey({ shape: 'governance' }),
    result = position(db, within, key);
  expect(Object.keys(result)).toEqual(['body', 'digest', 'hostNote']);
  // The body is the position body unchanged; the digest is the canonical digest of exactly those bytes.
  expect(stableSerialize(result.body)).toBe(stableSerialize(positionBody(db, within, key)));
  expect(BODY_DIGEST_FORMAT).toBe('ia-body-1');
  expect(result.digest).toBe(digest({ format: BODY_DIGEST_FORMAT, body: result.body }));
  expect(result.digest).toBe(bodyDigest(result.body));
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.hostNote.format).toBe(HOST_NOTE_FORMAT);
  expect(result.hostNote.revision).toBe(result.body.revision);
  expect(Object.isFrozen(result) && Object.isFrozen(result.hostNote)).toBe(true);
  // Nothing of the host note reaches the body.
  expect(Object.keys(result.body)).not.toContain('hostNote');
});

it('keeps the body byte-equal across scope tokens, host facts and a capture present or absent; only the host note moves', () => {
  const root = workspace(),
    key = normalizeScopeKey({ shape: 'governance', depth: 2 });
  const plain = database(root),
    bare = position(plain, plain.resolveScope({}).token, key);
  capture(root);
  const host = database(root),
    token = host.resolveScope({}).token,
    facts: HostFacts = { cli: 'ia@9.9.9', adapter: 'fixture-adapter@1.0.0', installedStateDigest: 'f'.repeat(64) },
    hosted = position(host, token, key, { hostFacts: () => facts });
  expect(token).not.toBe(plain.resolveScope({}).token);
  expect(stableSerialize(hosted.body)).toBe(stableSerialize(bare.body));
  expect(hosted.digest).toBe(bare.digest);
  expect(stableSerialize(hosted.hostNote)).not.toBe(stableSerialize(bare.hostNote));
  expect(hosted.hostNote).toMatchObject({
    cli: 'ia@9.9.9',
    adapter: 'fixture-adapter@1.0.0',
    installedStateDigest: 'f'.repeat(64),
    captured: { freshness: 'current' },
  });
  expect(bare.hostNote).toMatchObject({
    cli: null,
    adapter: null,
    installedStateDigest: null,
    captured: { freshness: 'absent' },
  });
  const text = stableSerialize(hosted.body);
  for (const absent of [token, root, 'ia@9.9.9', 'fixture-adapter', 'f'.repeat(64), CAPTURE_DIR, 'freshness'])
    expect(text).not.toContain(absent);
});

it('gives one digest per normalized key value: spellings, cache state, clock and the workspace path never reach it', () => {
  const [a, b] = [workspace(), workspace()];
  const k0 = at(database(a)),
    spelled = at(database(a), { shape: 'context', phase: 'orient', depth: 0, budget: 0 });
  expect(spelled.digest).toBe(k0.digest);
  expect(stableSerialize(spelled.body)).toBe(stableSerialize(k0.body));
  // How each key part was supplied is host state: it is in the host note, never in the body.
  expect(k0.hostNote.key.sources.shape).toBe('default');
  expect(spelled.hostNote.key.sources.shape).toBe('declared');
  expect(k0.hostNote.key.k0 && spelled.hostNote.key.k0).toBe(true);
  expect(stableSerialize(k0.body)).not.toContain('"sources"');
  // Another copy of the workspace, a cached handle and another clock.
  vi.useFakeTimers({ now: new Date('2001-02-03T04:05:06Z') });
  const cached = database(b, { cache: true });
  expect(at(cached).digest).toBe(k0.digest);
  vi.setSystemTime(new Date('2031-12-31T23:59:59Z'));
  expect(at(database(b)).digest).toBe(k0.digest);
  vi.useRealTimers();
  // A different key value is a different body.
  expect(at(database(a), { shape: 'governance' }).digest).not.toBe(k0.digest);
});

it('never reads the runtime band into the body: editing a runtime-band record moves only the revision', () => {
  const root = workspace(),
    locations = { [methodPath]: runtime },
    key = { shape: 'governance', depth: 2 };
  const before = at(database(root, { locations }), key);
  put(root, methodPath, readFileSync(resolve(root, methodPath), 'utf8').replace('statement 1.', 'statement one.'));
  const after = at(database(root, { locations }), key);
  expect(after.body.revision).not.toBe(before.body.revision);
  expect(stableSerialize({ ...after.body, revision: '' })).toBe(stableSerialize({ ...before.body, revision: '' }));
});

it('reads freshness and staleness from the capture store with a cache-free handle', () => {
  const root = workspace();
  put(root, '.ia/src/gone.ia', playbook('gone'));
  const first = database(root);
  // No capture yet: nothing to compare against.
  expect(at(first).hostNote).toMatchObject({
    captured: { revision: null, previousRevision: null, freshness: 'absent' },
    staleness: null,
    observations: [],
  });
  const members = first.membership().length;
  writeCaptured(root, CAPTURE_DIR, captureOf(first));
  expect(at(database(root)).hostNote).toMatchObject({
    captured: { revision: first.revision, previousRevision: null, freshness: 'current' },
    staleness: { changed: 0, new: 0, removed: 0, unchanged: members },
  });
  // Edit one record, add one and remove one after the capture.
  put(root, methodPath, readFileSync(resolve(root, methodPath), 'utf8').replace('statement 1.', 'statement one.'));
  put(root, '.ia/src/fresh.ia', playbook('fresh'));
  rmSync(resolve(root, '.ia/src/gone.ia'));
  const second = database(root),
    stale = at(second).hostNote;
  expect(stale).toMatchObject({
    revision: second.revision,
    captured: { revision: first.revision, previousRevision: null, freshness: 'stale' },
    staleness: { changed: 1, new: 1, removed: 1, unchanged: members - 2 },
  });
  // A new capture rotates the old one into previous.
  writeCaptured(root, CAPTURE_DIR, captureOf(second));
  expect(at(database(root)).hostNote).toMatchObject({
    captured: { revision: second.revision, previousRevision: first.revision, freshness: 'current' },
    staleness: { changed: 0, new: 0, removed: 0, unchanged: members },
  });
  // Every handle here was opened cache-free: the host note never needed the disposable cache.
  expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);
});

it('reports an unreadable capture as an observation and treats it as absent', () => {
  const root = workspace();
  capture(root);
  writeFileSync(resolve(root, CAPTURE_DIR, 'current.json'), '{"format":"ia-snapshot-1"}\n');
  const note = at(database(root)).hostNote;
  expect(note.captured).toEqual({ revision: null, previousRevision: null, freshness: 'absent' });
  expect(note.staleness).toBeNull();
  expect(note.observations).toEqual([
    expect.objectContaining({
      code: 'IA-DB-SNAPSHOT-UNAVAILABLE',
      severity: 'warning',
      path: `${CAPTURE_DIR}/current.json`,
    }),
  ]);
});

it('carries the key used with its sources and no classification rule', () => {
  const note = at(database(workspace()), { shape: 'governance', word: 'law' }).hostNote;
  expect(note.key).toEqual({
    seat: null,
    shape: 'governance',
    phase: 'plan',
    primitive: 'Inference',
    depth: 1,
    budget: 16,
    word: 'law',
    k0: false,
    sources: {
      seat: 'default',
      shape: 'declared',
      phase: 'derived',
      primitive: 'derived',
      depth: 'default',
      budget: 'default',
      word: 'declared',
    },
  });
  expect(Object.keys(note)).toEqual([
    'format',
    'revision',
    'captured',
    'staleness',
    'installedStateDigest',
    'cli',
    'adapter',
    'key',
    'observations',
  ]);
});

it('asks the host for its facts once per position, and refuses facts that are not text', () => {
  const db = database(workspace()),
    facts = vi.fn((): HostFacts => ({ cli: 'ia@9.9.9' }));
  const note = at(db, {}, facts).hostNote;
  expect(facts).toHaveBeenCalledTimes(1);
  expect([note.cli, note.adapter, note.installedStateDigest]).toEqual(['ia@9.9.9', null, null]);
  for (const bad of [{ cli: '' }, { adapter: 7 }, { installedStateDigest: null }])
    expect(() => at(db, {}, () => bad as unknown as HostFacts)).toThrow(/IA-RUNTIME-REQUEST-INVALID/);
});

it('accepts host facts on the door without reading them on the nine routes', () => {
  const facts = vi.fn((): HostFacts => ({ cli: 'ia@9.9.9' })),
    door = new Door(workspace(), { cache: false, hostFacts: facts });
  try {
    for (const request of [
      { operation: 'scope', params: {} },
      { operation: 'records', params: {} },
      { operation: 'search', params: { text: 'sample' } },
      { operation: 'context', params: { text: 'sample', coordinate: { phase: 'act', primitive: 'Decision' } } },
    ])
      expect(door.request(request)).toMatchObject({ ok: true });
    // The nine routes' admitted list is unchanged; the position operation follows it.
    expect(door.request({ operation: 'unlisted', params: {} })).toMatchObject({
      ok: false,
      message: expect.stringContaining('admitted: scope, context, select, get, records, resolve, search, traverse'),
    });
    expect(facts).not.toHaveBeenCalled();
    // Only the position operation asks for them, once, for its host note.
    expect(door.request({ operation: 'position', params: {} })).toMatchObject({
      ok: true,
      result: { hostNote: { cli: 'ia@9.9.9' } },
    });
    expect(facts).toHaveBeenCalledTimes(1);
  } finally {
    door.close();
  }
});
