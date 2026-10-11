import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import { withScope } from '@tools/testing/resources.js';
import { runBounded, spawnOwned } from '@tools/testing/subprocess.js';
import { MAX_LINE_BYTES } from '../src/main.js';

/** Links a file. Windows grants file links only with a privilege (Developer Mode or elevation): without it, EPERM, and false. */
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};

// Process startup and protocol exchanges share one bounded integration allowance.
vi.setConfig({ testTimeout: 30_000 });

const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 20_000;
const root = resolve(import.meta.dirname, '../../..'),
  fixture = resolve(root, 'packages/compliance/fixtures/loop'),
  entrypoint = resolve(root, 'apps/mcp-door/dist/main.js');
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'subprocess-test', version: '1' } },
};
const line = (value: unknown) => JSON.stringify(value) + '\n';
it('keeps the issuer alive for reusable tokens and returns only protocol output', () =>
  withScope(async (scope) => {
    const child = spawnOwned(scope, 'mcp-door', process.execPath, [entrypoint, '--root', fixture], {
      cwd: root,
      timeoutMs: 20_000,
    });
    const reader = createInterface({ input: child.stdout }),
      output = reader[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const read = async () => {
      const next = await output.next();
      if (next.done) throw new Error('Protocol closed early');
      return JSON.parse(next.value);
    };
    try {
      child.stdin.write(line(initialize));
      expect((await read()).result.protocolVersion).toBe('2025-11-25');
      child.stdin.write(line({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      child.stdin.write(
        line({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'ia_scope',
            arguments: { identities: ['governance-system/definition/procedure/sample-procedure'] },
          },
        }),
      );
      const scope = (await read()).result.structuredContent.result;
      child.stdin.write(
        line({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'ia_context',
            arguments: {
              within: scope.token,
              text: '',
              coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' },
            },
          },
        }),
      );
      const packet = (await read()).result.structuredContent.result;
      expect(packet.included).toHaveLength(1);
      expect(packet.included[0].step).toBe(1);
      child.stdin.write(
        line({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'ia_get', arguments: { within: packet.scope.token, identity: 'outside' } },
        }),
      );
      expect((await read()).result).toMatchObject({ isError: true, structuredContent: { code: 'IA-DB-OUT-OF-SCOPE' } });
      // ia_read (protocol version 2) reads through the same live token: the body inside it, one plain refusal outside.
      for (const [id, locator] of [
        [5, 'governance-system/definition/procedure/sample-procedure#act/Decision'],
        [6, 'agent-system/binding/agent/agent-steward'],
      ] as const)
        child.stdin.write(
          line({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'ia_read', arguments: { within: scope.token, locator } },
          }),
        );
      expect((await read()).result).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          result: { kind: 'record', body: 'Sample fixture statement 18.', certified: false },
        },
      });
      expect((await read()).result.structuredContent).toEqual({
        ok: false,
        code: 'IA-RUNTIME-READ-UNADMITTED',
        message: 'The locator is not in this scope',
      });
      // ia_next (protocol version 2) answers through the same token; the loop fixture authors no plan, so its refusal
      // names the one command to run, as a version 2 refusal may.
      child.stdin.write(
        line({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'ia_next', arguments: { within: scope.token } },
        }),
      );
      expect((await read()).result).toEqual({
        content: [{ type: 'text', text: expect.stringContaining('"code":"IA-RUNTIME-NEXT-NO-PLAN"') }],
        structuredContent: {
          ok: false,
          code: 'IA-RUNTIME-NEXT-NO-PLAN',
          message: 'No admitted @plan at authored placement (band 100) in this scope',
          next: 'ia next --help',
        },
        isError: true,
      });
      // ia_position (protocol version 2) reads body(K) through the same token, which reads no admission finding and
      // says so; a refusal of the key names the one command to run.
      for (const [id, args] of [
        [
          8,
          {
            within: scope.token,
            seat: 'governance-system/definition/procedure/sample-procedure',
            shape: 'governance',
          },
        ],
        [9, { within: scope.token, budget: 65 }],
      ] as const)
        child.stdin.write(
          line({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ia_position', arguments: args } }),
        );
      const positioned = (await read()).result;
      expect(positioned).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          result: {
            body: {
              format: 'ia.position-body.v1',
              key: { seat: 'governance-system/definition/procedure/sample-procedure', shape: 'governance' },
              loaded: [{ identity: 'governance-system/definition/procedure/sample-procedure' }],
            },
            digest: expect.stringMatching(/^[0-9a-f]{64}$/),
            hostNote: { freshness: expect.any(String) },
          },
        },
      });
      expect(positioned.structuredContent.result.body.unknowns).toContainEqual(
        expect.objectContaining({ kind: 'unread' }),
      );
      expect((await read()).result.structuredContent).toEqual({
        ok: false,
        code: 'IA-RUNTIME-REQUEST-INVALID',
        message: 'IA-RUNTIME-REQUEST-INVALID: Scope key budget must be an integer in 0..64',
        next: 'ia position --budget 64',
      });
      const closing = once(child, 'close');
      child.stdin.end();
      expect((await closing)[0]).toBe(0);
      expect(stderr).toBe('');
      expect(existsSync(resolve(fixture, '.ia/.iadb'))).toBe(false);
    } finally {
      reader.close();
    }
  }));
/** Every path under a directory with its size and modification time, to show a session wrote nothing. */
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = resolve(entry.parentPath, entry.name),
        stat = statSync(path);
      return `${relative(dir, path)} ${entry.isDirectory() ? 'dir' : stat.size} ${stat.mtimeMs}`;
    })
    .sort();
it('serves ia_vocabulary from the built package: the CLI catalogue, unknown words and bad input refuse, nothing is written', async () => {
  const cli = JSON.parse(readFileSync(resolve(root, 'apps/cli/assets/vocabulary.json'), 'utf8')) as {
    sourceDigest: string;
    words: { word: string }[];
  };
  const shipped = resolve(root, 'apps/mcp-door/assets/vocabulary.json'),
    before = { fixture: tree(fixture), catalogue: statSync(shipped).mtimeMs };
  const call = (id: number, args: unknown) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'ia_vocabulary', arguments: args },
  });
  const input = [
    initialize,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    call(3, {}),
    call(4, { word: 'law', schema: true }),
    call(5, { domain: ['taxonomy'], kind: ['definition'] }),
    call(6, { word: 'lawz' }),
    call(7, { word: 'law', within: 'forged' }),
    call(8, { schema: 1 }),
  ]
    .map(line)
    .join('');
  const got = await runBounded(process.execPath, [entrypoint, '--root', fixture], {
    cwd: root,
    input,
    timeoutMs: SUBPROCESS,
  });
  expect(got.status).toBe(0);
  expect(got.stderr).toBe('');
  const responses = new Map(
    got.stdout
      .trim()
      .split('\n')
      .map((text) => JSON.parse(text))
      .map((response) => [response.id, response.result]),
  );
  expect(responses.get(2).tools.find((tool: { name: string }) => tool.name === 'ia_vocabulary')).toMatchObject({
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false },
  });
  const all = responses.get(3);
  expect(all.isError).toBe(false);
  expect(JSON.parse(all.content[0].text)).toEqual(all.structuredContent);
  expect(all.structuredContent.result.sourceDigest).toBe(cli.sourceDigest);
  expect(all.structuredContent.result.words.map((word: { word: string }) => word.word)).toEqual(
    cli.words.map((word) => word.word),
  );
  expect(responses.get(4).structuredContent.result.words).toEqual(cli.words.filter((word) => word.word === 'law'));
  const filtered = responses.get(5).structuredContent.result.words as { owner: string; kind: string }[];
  expect(filtered.length).toBeGreaterThan(0);
  expect(filtered.every((word) => word.owner === 'taxonomy' && word.kind === 'definition')).toBe(true);
  expect(responses.get(6)).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-VOCABULARY-UNKNOWN-WORD' },
  });
  expect(responses.get(7)).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID' },
  });
  expect(responses.get(8)).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID' },
  });
  expect({ fixture: tree(fixture), catalogue: statSync(shipped).mtimeMs }).toEqual(before);
  expect(existsSync(resolve(fixture, '.ia/.iadb'))).toBe(false);
});
it('handles a non-newline final message and malformed JSON without stdout logging', async () => {
  const got = await runBounded(process.execPath, [entrypoint, '--root', fixture], {
    input: line(initialize) + '{',
    timeoutMs: SUBPROCESS,
  });
  expect(got.status).toBe(0);
  expect(got.stderr).toBe('');
  const responses = got.stdout
    .trim()
    .split('\n')
    .map((text) => JSON.parse(text));
  expect(responses).toHaveLength(2);
  expect(responses[1].error.code).toBe(-32700);
});
it.each([
  [Buffer.from([0xc3, 0x28]), -32700],
  [Buffer.alloc(MAX_LINE_BYTES + 1, 0x20), -32600],
])('closes invalid UTF-8 or oversized input with a named protocol error', async (input, code) => {
  const got = await runBounded(process.execPath, [entrypoint, '--root', fixture], { input, timeoutMs: SUBPROCESS });
  expect(got.status).toBe(0);
  expect(got.stderr).toBe('');
  expect(JSON.parse(got.stdout).error.code).toBe(code);
});
it('refuses unsupported startup arguments without opening the protocol', async () => {
  const got = await runBounded(process.execPath, [entrypoint, '--unknown'], { timeoutMs: SUBPROCESS });
  expect(got.status).toBe(2);
  expect(got.stdout).toBe('');
  expect(got.stderr).toContain('Usage:');
});
it('treats a disconnected stdout pipe as connection closure', () =>
  withScope(async (scope) => {
    const child = spawnOwned(scope, 'mcp-door', process.execPath, [entrypoint, '--root', fixture], {
      cwd: root,
      timeoutMs: 20_000,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closing = once(child, 'close');
    child.stdout.destroy();
    child.stdin.end(line(initialize));
    expect((await closing)[0]).toBe(0);
    expect(stderr).toBe('');
  }));
it(
  'runs the built entry point when a link reaches it, as npm .bin entries and global installs do',
  () =>
    withScope(async (scope) => {
      // Node loads an entry from its real path, so the entry check compares real paths. A directory junction needs no
      // privilege on Windows; the file link does, so it runs wherever that is granted. The service entry
      // point's case stays with the service implementation, which the public tree does not ship.
      const base = mkdtempSync(resolve(tmpdir(), 'mcp entry link ')),
        linked = resolve(base, 'linked dist');
      scope.defer('entry link directory', () => {
        rmSync(base, { recursive: true, force: true });
      });
      symlinkSync(resolve(root, 'apps/mcp-door/dist'), linked, 'junction');
      const entries = [resolve(linked, 'main.js')];
      if (fileLink(resolve(root, 'apps/mcp-door/dist/main.js'), resolve(base, 'main')))
        entries.push(resolve(base, 'main'));
      for (const entry of entries) {
        const got = await runBounded(process.execPath, [entry, '--help'], { cwd: base, timeoutMs: SUBPROCESS });
        expect({
          entry,
          status: got.status,
          usage: got.stdout.startsWith('Usage: ia-mcp-door '),
          stderr: got.stderr,
        }).toEqual({ entry, status: 0, usage: true, stderr: '' });
      }
    }),
  90_000,
);
