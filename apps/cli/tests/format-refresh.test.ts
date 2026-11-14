import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Handle } from '@inventarch/db';
import { collectFormat } from '../src/format.js';
import { cleanup, FORMATTABLE, workspace } from './workspace-fixture.js';

afterAll(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
});

/** Each refresh rereads and rebuilds the whole workspace (db D05); format used to make one for every file it drafted. */
const refreshes = () => vi.spyOn(Handle.prototype, 'refresh');
const deform = (root: string): void => {
  const path = resolve(root, FORMATTABLE);
  writeFileSync(path, readFileSync(path, 'utf8').replace('  meaning\n', '  meaning   \n'));
};
const statuses = (view: ReturnType<typeof collectFormat>) => view.files.map((file) => [file.path, file.status]);

describe('ia format checks staleness once per run', () => {
  it('makes one refresh for a whole-tree check, whatever the number of files it drafts', () => {
    const root = workspace();
    deform(root);
    const spy = refreshes();
    const view = collectFormat(root, [], false);
    const drafted = view.files.filter((file) => file.status === 'unchanged' || file.status === 'differs').length;
    expect(drafted).toBeGreaterThan(1);
    expect(view.changed).toBe(1);
    expect(view.files.find((file) => file.path === FORMATTABLE)?.status).toBe('differs');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('makes no refresh when every selected file is outside the formatter, as before', () => {
    const root = workspace();
    const all = collectFormat(root, [], false);
    const unsupported = all.files.filter((file) => file.status === 'unsupported').map((file) => file.path);
    expect(unsupported.length).toBeGreaterThan(0);
    const spy = refreshes();
    const view = collectFormat(root, unsupported, false);
    expect(view.files.every((file) => file.status === 'unsupported')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses as stale and writes nothing when a source changes before the drafts are written', () => {
    const root = workspace();
    deform(root);
    const before = readFileSync(resolve(root, FORMATTABLE), 'utf8');
    const original = Handle.prototype.refresh;
    vi.spyOn(Handle.prototype, 'refresh').mockImplementation(function (this: Handle) {
      // Another writer edits a different source while format runs.
      const other = resolve(root, '.ia/src/blocking.ia');
      writeFileSync(other, `${readFileSync(other, 'utf8')}\n`);
      return original.call(this);
    });
    expect(() => collectFormat(root, [], true)).toThrow(expect.objectContaining({ code: 'IA-DIST-PLAN-STALE' }));
    expect(readFileSync(resolve(root, FORMATTABLE), 'utf8')).toBe(before);
  });

  it('refuses as stale when a drafted source changes after the refresh, and writes nothing', () => {
    const root = workspace();
    deform(root);
    const path = resolve(root, FORMATTABLE);
    const changed = `${readFileSync(path, 'utf8')}# edited meanwhile\n`;
    const original = Handle.prototype.refresh;
    vi.spyOn(Handle.prototype, 'refresh').mockImplementation(function (this: Handle) {
      // The revision is taken first; the drafted source then changes, so only its re-read can see it.
      const snapshot = original.call(this);
      writeFileSync(path, changed);
      return snapshot;
    });
    expect(() => collectFormat(root, [], true)).toThrow(expect.objectContaining({ code: 'IA-DIST-PLAN-STALE' }));
    expect(readFileSync(path, 'utf8')).toBe(changed);
  });

  it('reports the same statuses as before for a clean tree and a deformed one', () => {
    const root = workspace();
    const clean = statuses(collectFormat(root, [], false));
    expect(clean.every(([, status]) => status === 'unchanged' || status === 'unsupported')).toBe(true);
    deform(root);
    const deformed = statuses(collectFormat(root, [], false));
    expect(deformed).toEqual(clean.map(([path, status]) => [path, path === FORMATTABLE ? 'differs' : status]));
  });
});
