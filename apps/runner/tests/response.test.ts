import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { adoptWorkspace } from '@inventarch/workspace-runtime';
import { openRunner } from '../src/open.js';
import { main } from '../src/main.js';
import { readResponseFile } from '../src/response.js';

const repository = resolve(import.meta.dirname, '../../..');
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(resolve(tmpdir(), 'ia-runner-response-'));
  roots.push(root);
  return { root, response: resolve(root, 'response.json') };
}
function track(response: string, onRead?: () => void) {
  const open = fs.openSync,
    read = fs.readSync,
    full = fs.readFileSync,
    close = fs.closeSync;
  const descriptors = new Set<number>();
  const result = { opened: 0, bytes: 0, largestBuffer: 0, fullReads: 0 };
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    const fd = open(path, flags, mode);
    if (String(path) === response) {
      descriptors.add(fd);
      result.opened++;
    }
    return fd;
  });
  vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
    if (descriptors.has(args[0])) {
      onRead?.();
      result.largestBuffer = Math.max(result.largestBuffer, args[1].byteLength);
    }
    const count = Reflect.apply(read, fs, args) as number;
    if (descriptors.has(args[0])) result.bytes += count;
    return count;
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
    if (String(args[0]) === response) result.fullReads++;
    return Reflect.apply(full, fs, args);
  });
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    descriptors.delete(fd);
    close(fd);
  });
  return result;
}

it('reads a regular response exactly at the 64 KiB boundary with a fixed buffer', () => {
  const { response } = fixture(),
    content = '{}'.padEnd(65536, ' ');
  fs.writeFileSync(response, content);
  const measured = track(response);
  expect(readResponseFile(response)).toBe(content);
  expect(measured).toMatchObject({ bytes: 65536, largestBuffer: 65536, fullReads: 0 });
});

it('refuses oversized response payloads before opening or consuming any bytes', () => {
  const { response } = fixture();
  fs.writeFileSync(response, Buffer.alloc(1024 * 1024, 32));
  const measured = track(response);
  expect(() => readResponseFile(response)).toThrow('exceeds 64 KiB');
  expect(measured).toEqual({ opened: 0, bytes: 0, largestBuffer: 0, fullReads: 0 });
});

it('refuses a nonregular response before opening it', () => {
  const { root } = fixture(),
    measured = track(root);
  expect(() => readResponseFile(root)).toThrow('regular file');
  expect(measured.opened).toBe(0);
  expect(measured.bytes).toBe(0);
});

it('caps bytes consumed when a regular response grows after the opened-file metadata check', () => {
  const { response } = fixture();
  fs.writeFileSync(response, '{}');
  let grew = false;
  const measured = track(response, () => {
    if (!grew) {
      grew = true;
      fs.appendFileSync(response, Buffer.alloc(1024 * 1024, 32));
    }
  });
  expect(() => readResponseFile(response)).toThrow('changed while reading');
  expect(grew).toBe(true);
  expect(measured.bytes).toBe(65536);
  expect(measured.largestBuffer).toBe(65536);
  expect(measured.fullReads).toBe(0);
});

it('CLI submit leaves the deferred request intact after over-limit input and accepts bounded valid JSON', async () => {
  const { root, response } = fixture();
  fs.cpSync(resolve(repository, 'examples/conformance/composition/.ia'), resolve(root, '.ia'), { recursive: true });
  const language = adoptWorkspace(repository, 'public-language');
  for (const source of language.sources) {
    const path = resolve(root, 'vendor/public', source.path);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, source.text);
  }
  fs.writeFileSync(
    resolve(root, '.ia/workspace.json'),
    JSON.stringify({ version: 1, adopted: [{ id: language.id, path: 'vendor/public', revision: language.revision }] }),
  );
  const runner = openRunner({ root, profile: 'runner-reader-profile' });
  let attempt: string, sequence: number;
  try {
    await runner.start('Submit bounded response input', 'response-cli');
    const waiting = await runner.run();
    attempt = Object.values(waiting.attempts).find((row) => row.kind === 'model' && row.status === 'dispatched')!.id;
    sequence = waiting.sequence;
  } finally {
    await runner.close();
  }
  const args = [
    'submit',
    '--root',
    root,
    '--profile',
    'runner-reader-profile',
    '--id',
    'response-cli',
    '--attempt',
    attempt!,
    '--response',
    response,
  ];
  fs.writeFileSync(response, Buffer.alloc(1024 * 1024, 32));
  const measured = track(response);
  await expect(main(args)).rejects.toMatchObject({
    code: 'IA-RUNNER-ARGUMENT',
    message: 'Response file exceeds 64 KiB',
  });
  expect(measured).toEqual({ opened: 0, bytes: 0, largestBuffer: 0, fullReads: 0 });
  const unchanged = openRunner({ root, profile: 'runner-reader-profile' });
  try {
    const state = await unchanged.resume('response-cli');
    expect(state.sequence).toBe(sequence!);
    expect(state.attempts[attempt!]!.status).toBe('dispatched');
  } finally {
    await unchanged.close();
  }
  const content = JSON.stringify({
    action: { type: 'outcome', kind: 'answer', message: 'Bounded response accepted.', continuation: 'finish' },
    usage: 1,
    model: 'runner/external',
    provider: 'local-test',
  });
  fs.writeFileSync(response, content);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await main(args);
  } finally {
    stdout.mockRestore();
  }
  expect(measured.bytes).toBe(Buffer.byteLength(content));
  expect(measured.fullReads).toBe(0);
  const completed = openRunner({ root, profile: 'runner-reader-profile' });
  try {
    const state = await completed.resume('response-cli');
    expect(state.attempts[attempt!]!.status).toBe('observed');
    expect((await completed.run()).runs['root']?.status).toBe('completed');
  } finally {
    await completed.close();
  }
});
