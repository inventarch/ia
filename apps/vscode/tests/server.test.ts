import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { URI } from 'vscode-uri';
import { EditorWorkspace } from '@ia/runtime/editor';
import type { EditorComposition, EditorView } from '@ia/runtime/editor';
import { digestValue } from '@ia/runtime/authoring';
import { createScope } from '@tools/testing/resources.js';
import { spawnOwned } from '@tools/testing/subprocess.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it('initializes beside package links and answers real stdio editor requests', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-vscode-lsp-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, '.ia/src'), {
    recursive: true,
    filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
  });
  // Exercise the bundled reader against the colocated pnpm layout that crashed an older installed VSIX.
  const system = resolve(root, '.ia/src/systems/agent-composition-system'),
    dependency = resolve(root, 'dependency');
  mkdirSync(resolve(system, 'node_modules/@ia'), { recursive: true });
  mkdirSync(resolve(system, 'dist'), { recursive: true });
  mkdirSync(dependency);
  writeFileSync(resolve(dependency, 'not-source.ia'), 'dependency bytes are not IA source');
  writeFileSync(resolve(system, 'dist/not-source.ia'), 'build output is not IA source');
  symlinkSync(
    dependency,
    resolve(system, 'node_modules/@ia/agent-system'),
    globalThis.process.platform === 'win32' ? 'junction' : 'dir',
  );
  const scope = createScope(),
    process = spawnOwned(
      scope,
      'vscode server',
      globalThis.process.execPath,
      [resolve(import.meta.dirname, '../dist/server.cjs')],
      { timeoutMs: 25_000 },
    );
  cleanup.push(() => scope.dispose());
  const connection = createMessageConnection(
    new StreamMessageReader(process.stdout),
    new StreamMessageWriter(process.stdin),
  );
  cleanup.push(() => connection.dispose());
  connection.listen();
  const initialized = await connection.sendRequest<{ capabilities: { definitionProvider: boolean } }>('initialize', {
    processId: null,
    capabilities: {},
    initializationOptions: { protocol: 1, root },
  });
  expect(initialized.capabilities.definitionProvider).toBe(true);
  await connection.sendNotification('initialized', {});
  const view = await connection.sendRequest<EditorView>('ia/editor/v1/request', { protocol: 1, operation: 'view' });
  expect(view.records.length).toBeGreaterThan(100);
  expect(view.records.some((r) => r.name === 'sample-procedure')).toBe(true);
  expect(view.records.some((r) => /\/(node_modules|dist)\//.test(r.source.path))).toBe(false);
  const record = view.records.find((r) => r.name === 'sample-procedure')!,
    uri = URI.file(resolve(root, record.source.path)).toString();
  const result = await connection.sendRequest<readonly { uri: string }[]>('textDocument/typeDefinition', {
    textDocument: { uri },
    position: record.source.range.start,
  });
  expect(result[0]?.uri).toContain('playbook.schema.ia');
  await connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'inventarch-ia', version: 1, text: '#! ia 1.0\n@pla' },
  });
  const list = await connection.sendRequest<{ isIncomplete: boolean; items: readonly { label: string }[] }>(
    'textDocument/completion',
    { textDocument: { uri }, position: { line: 1, character: 4 } },
  );
  const completions = list.items;
  expect(list.isIncomplete).toBe(true);
  expect(completions.some((c) => c.label === '@playbook')).toBe(true);
  // C04: documentation is not sent with the list; resolve loads it for the selected item under the list's binding.
  expect(
    (initialized.capabilities as { completionProvider?: { resolveProvider?: boolean } }).completionProvider
      ?.resolveProvider,
  ).toBe(true);
  const selected = completions.find((c) => c.label === '@playbook') as { documentation?: unknown; data?: unknown };
  expect(selected.documentation).toBeUndefined();
  expect(selected.data).toBeDefined();
  const resolved = await connection.sendRequest<{ documentation?: { kind: string; value: string } }>(
    'completionItem/resolve',
    selected,
  );
  expect(resolved.documentation?.kind).toBe('markdown');
  expect(resolved.documentation?.value).toContain('Schema `playbook`');
  await connection.sendNotification('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: '#! ia 1.0\n@play' }],
  });
  expect(
    (await connection.sendRequest<{ documentation?: unknown }>('completionItem/resolve', selected)).documentation,
  ).toBeUndefined();
  expect(
    (
      await connection.sendRequest<{ documentation?: unknown }>('completionItem/resolve', {
        ...selected,
        data: { forged: true },
      })
    ).documentation,
  ).toBeUndefined();
  await expect(
    connection.sendRequest('ia/editor/v1/request', {
      protocol: 1,
      operation: 'source',
      action: record.source.action,
      stamp: view.stamp,
    }),
  ).rejects.toThrow('view changed');
  await expect(connection.sendRequest('ia/editor/v1/request', { protocol: 9, operation: 'view' })).rejects.toThrow(
    'protocol',
  );
  await connection.sendRequest('shutdown');
  await connection.sendNotification('exit');
  await new Promise<void>((done) => {
    process.once('exit', () => done());
    setTimeout(done, 1500);
  });
});

it('admits project records through a pinned workspace binding and resolves read-only adopted schemas', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-vscode-lsp-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const foundation = resolve(root, 'vendor/foundation');
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(foundation, '.ia/src'), {
    recursive: true,
    filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
  });
  const captured = new EditorWorkspace(foundation, { adopted: [] });
  const sources = captured.sources
    .filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  captured.close();
  const revision = digestValue(sources);
  const path = '.ia/src/systems/agent-system/records/local-reader.ia';
  mkdirSync(resolve(root, path, '..'), { recursive: true });
  writeFileSync(
    resolve(root, path),
    '#! ia 1.0\n@agent local-reader\n  meaning\n    says "Review the service corpus."\n    answers "Who helps here?"\n  governance\n    applies []\n',
  );
  writeFileSync(
    resolve(root, '.ia/workspace.json'),
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: 'vendor/foundation', revision }] }),
  );
  const scope = createScope(),
    child = spawnOwned(scope, 'vscode server', process.execPath, [resolve(import.meta.dirname, '../dist/server.cjs')], {
      timeoutMs: 25_000,
    });
  cleanup.push(() => scope.dispose());
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  cleanup.push(() => connection.dispose());
  connection.listen();
  await connection.sendRequest('initialize', {
    processId: null,
    capabilities: {},
    initializationOptions: { protocol: 1, root },
  });
  const view = await connection.sendRequest<EditorView>('ia/editor/v1/request', { protocol: 1, operation: 'view' });
  const author = view.records.find((r) => r.name === 'local-reader')!;
  expect(author.status).toBe('admitted');
  expect(author.source.readOnly).toBe(false);
  const composition = await connection.sendRequest<EditorComposition>('ia/editor/v1/request', {
    protocol: 1,
    operation: 'composition',
    stamp: view.stamp,
  });
  expect(composition.dependencies).toEqual([
    expect.objectContaining({ id: 'foundation', revision, access: 'captured-source' }),
  ]);
  expect(composition.uses.filter((u) => u.occurrence === author.occurrence).map((u) => u.reason)).toEqual([
    'schema',
    'registration',
  ]);
  expect(view.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const schemas = await connection.sendRequest<readonly { uri: string }[]>('textDocument/typeDefinition', {
    textDocument: { uri: URI.file(resolve(root, path)).toString() },
    position: author.source.range.start,
  });
  expect(schemas[0]?.uri).toContain('inventarch-source:');
  expect(schemas[0]?.uri).toContain('agent.schema.ia');
  expect(
    await connection.sendRequest('ia/editor/v1/request', {
      protocol: 1,
      operation: 'virtualSource',
      path: schemas[0]!.uri,
    }),
  ).toContain('@schema agent');
  writeFileSync(resolve(foundation, sources[0]!.path), sources[0]!.text + '\n# changed dependency\n');
  await expect(connection.sendRequest('ia/editor/v1/request', { protocol: 1, operation: 'rebuild' })).rejects.toThrow(
    'Pinned source revision differs',
  );
  await expect(connection.sendRequest('ia/editor/v1/request', { protocol: 1, operation: 'view' })).rejects.toThrow(
    'Local capture failed',
  );
  await expect(
    connection.sendRequest('ia/editor/v1/request', { protocol: 1, operation: 'composition', stamp: view.stamp }),
  ).rejects.toThrow('Local capture failed');
  writeFileSync(resolve(foundation, sources[0]!.path), sources[0]!.text);
  const restored = await connection.sendRequest<EditorView>('ia/editor/v1/request', {
    protocol: 1,
    operation: 'rebuild',
  });
  expect(restored.records.find((r) => r.name === 'local-reader')?.status).toBe('admitted');
  await connection.sendRequest('shutdown');
  await connection.sendNotification('exit');
});
