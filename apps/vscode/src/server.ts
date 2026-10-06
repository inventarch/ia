import { relative, resolve, sep } from 'node:path';
import {
  createConnection,
  TextDocuments,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  CompletionItemKind,
  SymbolKind,
  SemanticTokensBuilder,
  ResponseError,
  ErrorCodes,
  CodeActionKind,
  InlayHintKind,
} from 'vscode-languageserver/node';
import type { CompletionItem, Diagnostic, Location, TextDocumentPositionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { EditorWorkspace, EditorError } from '@inventarch/runtime/editor';
import type { CompletionCitation, EditorFinding, SourceLink, ViewStamp } from '@inventarch/runtime/editor';
import { METHOD, request } from './protocol.js';
// esbuild inlines only this field, so the bundled server reports the extension's own manifest version.
import { version } from '../package.json';

const connection = createConnection(process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
const legend = ['type', 'class', 'namespace', 'variable', 'property', 'keyword', 'enumMember', 'string'];
let owner: EditorWorkspace | undefined,
  root = '',
  pending = false,
  refresh = false,
  timer: NodeJS.Timeout | undefined;
let published = new Set<string>(),
  debounce = 150,
  hints = true,
  unavailable = false;
const virtual = new Map<string, string>();
function workspace(): EditorWorkspace {
  if (owner === undefined) throw new EditorError('unavailable', 'No local workspace owner');
  return owner;
}
function sourcePath(uri: string): string | undefined {
  if (virtual.has(uri)) return virtual.get(uri);
  const parsed = URI.parse(uri);
  if (parsed.scheme === 'inventarch-source' && parsed.authority === owner?.ownerSession) {
    const path = parsed.path.slice(1);
    return owner.sources.some((s) => s.path === path && s.origin !== 'local') ? path : undefined;
  }
  if (parsed.scheme !== 'file') return undefined;
  const path = relative(root, parsed.fsPath).split(sep).join('/');
  return path.startsWith('.ia/src/') && path.endsWith('.ia') && !path.includes('../') ? path : undefined;
}
function uriFor(path: string): string {
  const source = workspace().sources.find((s) => s.path === path);
  if (source?.origin !== 'local') {
    const uri = URI.from({
      scheme: 'inventarch-source',
      authority: workspace().ownerSession,
      path: '/' + path,
    }).toString();
    virtual.set(uri, path);
    return uri;
  }
  return URI.file(resolve(root, path)).toString();
}
const severity = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
};
function diagnostic(f: EditorFinding): Diagnostic {
  return {
    range: f.range,
    severity: severity[f.severity],
    code: f.code,
    source: f.code.startsWith('IA-LANG') ? 'IA language' : f.code.startsWith('IA-GRAPH') ? 'IA graph' : 'IA compliance',
    message: f.message,
  };
}
function publish(): void {
  const groups = new Map<string, Diagnostic[]>();
  for (const finding of workspace().diagnostics()) {
    const uri = uriFor(finding.path),
      group = groups.get(uri) ?? [];
    group.push(diagnostic(finding));
    groups.set(uri, group);
  }
  for (const uri of new Set([...published, ...groups.keys()])) {
    const document = documents.get(uri);
    void connection.sendDiagnostics({
      uri,
      diagnostics: groups.get(uri) ?? [],
      ...(document === undefined ? {} : { version: document.version }),
    });
  }
  published = new Set(groups.keys());
  void connection.sendNotification(METHOD + 'status', {
    state: 'ready',
    stamp: workspace().stamp(),
    diagnostics: workspace().diagnostics().length,
  });
}
function flush(): void {
  if (!pending || owner === undefined) return;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  try {
    const overlays = documents.all().flatMap((doc) => {
      const path = sourcePath(doc.uri);
      if (path === undefined || URI.parse(doc.uri).scheme !== 'file') return [];
      const source = workspace().sources.find((s) => s.path === path);
      return source?.text === doc.getText() && !source.dirty
        ? []
        : [{ path, text: doc.getText(), version: doc.version }];
    });
    owner.update(overlays, refresh);
    unavailable = false;
    pending = false;
    refresh = false;
    virtual.clear();
    publish();
  } catch (error) {
    unavailable = true;
    pending = false;
    refresh = false;
    // Clear stale problems: retained internal state is unavailable for host actions until rebuilt.
    for (const uri of published) void connection.sendDiagnostics({ uri, diagnostics: [] });
    published.clear();
    void connection.sendNotification(METHOD + 'status', {
      state: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
function schedule(disk = false): void {
  pending = true;
  refresh ||= disk;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      flush();
    } catch {
      /* status already reports the failed capture */
    }
  }, debounce);
  void connection.sendNotification(METHOD + 'status', { state: 'checking' });
}
function guarded<T>(fn: () => T): T {
  try {
    flush();
    if (unavailable) throw new EditorError('unavailable', 'Local capture failed. Rebuild the index before continuing.');
    return fn();
  } catch (error) {
    throw new ResponseError(
      error instanceof EditorError && error.code === 'stale' ? -32801 : ErrorCodes.InvalidRequest,
      error instanceof Error ? error.message : String(error),
    );
  }
}
function at<T>(params: TextDocumentPositionParams, fn: (path: string) => T, fallback: T): T {
  return guarded(() => {
    const path = sourcePath(params.textDocument.uri);
    return path === undefined || workspace().sourceText(path) === undefined ? fallback : fn(path);
  });
}
function location(link: SourceLink): Location {
  return { uri: uriFor(link.path), range: link.range };
}
connection.onInitialize((params) => {
  const options = params.initializationOptions as
    | { protocol?: number; root?: string; debounce?: number; hints?: boolean }
    | undefined;
  if (options?.protocol !== 1 || typeof options.root !== 'string')
    throw new ResponseError(ErrorCodes.InvalidParams, 'A local root and editor protocol 1 are required');
  root = options.root;
  owner = new EditorWorkspace(root);
  debounce = options.debounce ?? 150;
  hints = options.hints ?? true;
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
      completionProvider: { triggerCharacters: ['@', '#', ' '], resolveProvider: true },
      hoverProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      foldingRangeProvider: true,
      documentFormattingProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.Source + '.format'] },
      inlayHintProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: legend, tokenModifiers: ['declaration'] }, full: true },
    },
    serverInfo: { name: 'InventArch', version },
  };
});
connection.onInitialized(() => publish());
documents.onDidChangeContent(() => schedule());
documents.onDidSave(() => schedule(true));
documents.onDidClose(() => schedule(true));
connection.onDidChangeWatchedFiles(() => schedule(true));
connection.onDidChangeConfiguration((params) => {
  const settings = params.settings as { inventarch?: { hints?: boolean; debounceMs?: number } };
  hints = settings.inventarch?.hints ?? true;
  debounce = Math.min(1000, Math.max(50, settings.inventarch?.debounceMs ?? 150));
});
// Design C04: items carry their view binding and citation; documentation loads only on resolve, and a stale binding resolves to nothing.
interface CompletionBinding {
  readonly stamp: ViewStamp;
  readonly path: string;
  readonly uri: string;
  readonly version: number | null;
  readonly citation: CompletionCitation;
}
// The list is marked incomplete so the client asks again after each edit instead of filtering items whose binding went stale.
connection.onCompletion((params, token) =>
  at(
    params,
    (path) => {
      if (token.isCancellationRequested) return { isIncomplete: true, items: [] };
      const stamp = workspace().stamp(),
        version = documents.get(params.textDocument.uri)?.version ?? null;
      return {
        isIncomplete: true,
        items: workspace()
          .completions(path, params.position)
          .map((item) => ({
            label: item.label,
            kind:
              item.kind === 'reference'
                ? CompletionItemKind.Reference
                : item.kind === 'field'
                  ? CompletionItemKind.Field
                  : item.kind === 'value'
                    ? CompletionItemKind.EnumMember
                    : CompletionItemKind.Keyword,
            detail: item.detail,
            textEdit: { range: item.range, newText: item.insertText },
            ...(item.documentation === undefined ? {} : { documentation: item.documentation }),
            ...(item.citation === undefined
              ? {}
              : {
                  data: {
                    stamp,
                    path,
                    uri: params.textDocument.uri,
                    version,
                    citation: item.citation,
                  } satisfies CompletionBinding,
                }),
          })),
      };
    },
    { isIncomplete: true, items: [] },
  ),
);
function binding(data: unknown): CompletionBinding | undefined {
  const value = data as Partial<CompletionBinding> | null;
  return value !== null &&
    typeof value === 'object' &&
    typeof value.path === 'string' &&
    typeof value.uri === 'string' &&
    (value.version === null || typeof value.version === 'number') &&
    value.stamp !== null &&
    typeof value.stamp === 'object' &&
    value.citation !== null &&
    typeof value.citation === 'object' &&
    ['record', 'word', 'field'].includes((value.citation as { kind?: unknown }).kind as string)
    ? (value as CompletionBinding)
    : undefined;
}
connection.onCompletionResolve((item: CompletionItem, token): CompletionItem => {
  const bound = binding(item.data);
  if (bound === undefined || token.isCancellationRequested) return item;
  try {
    flush();
    if (
      unavailable ||
      (documents.get(bound.uri)?.version ?? null) !== bound.version ||
      sourcePath(bound.uri) !== bound.path
    )
      return item;
    const markdown = workspace().completionDocumentation(bound.path, bound.citation, bound.stamp);
    return token.isCancellationRequested || markdown === undefined
      ? item
      : { ...item, documentation: { kind: 'markdown', value: markdown } };
  } catch {
    return item;
  }
});
connection.onHover((params) =>
  at(
    params,
    (path) => {
      const hover = workspace().hover(path, params.position);
      return hover === undefined
        ? null
        : { range: hover.range, contents: { kind: 'markdown' as const, value: hover.markdown } };
    },
    null,
  ),
);
connection.onDefinition((params) =>
  at(params, (path) => workspace().definition(path, params.position).map(location), []),
);
connection.onTypeDefinition((params) =>
  at(params, (path) => workspace().definition(path, params.position, true).map(location), []),
);
connection.onReferences((params) =>
  at(
    params,
    (path) => workspace().references(path, params.position, params.context.includeDeclaration).map(location),
    [],
  ),
);
connection.onDocumentSymbol((params) =>
  guarded(() => {
    const path = sourcePath(params.textDocument.uri);
    return path === undefined
      ? []
      : workspace()
          .symbols(path)
          .map((s) => ({
            name: s.name,
            detail: s.detail,
            kind: SymbolKind.Class,
            range: s.range,
            selectionRange: s.selectionRange,
          }));
  }),
);
connection.onWorkspaceSymbol((params, token) =>
  guarded(() =>
    token.isCancellationRequested
      ? []
      : workspace()
          .symbols(undefined, params.query)
          .slice(0, 1000)
          .map((s) => ({
            name: s.name,
            kind: SymbolKind.Class,
            containerName: s.detail,
            location: { uri: uriFor(s.path), range: s.selectionRange },
          })),
  ),
);
connection.onFoldingRanges((params) =>
  guarded(() => {
    const path = sourcePath(params.textDocument.uri);
    return path === undefined
      ? []
      : workspace()
          .folding(path)
          .map((r) => ({ startLine: r.start.line, endLine: r.end.line }));
  }),
);
connection.onDocumentFormatting((params) =>
  guarded(() => {
    const path = sourcePath(params.textDocument.uri),
      document = documents.get(params.textDocument.uri);
    if (path === undefined || document === undefined) return [];
    const text = workspace().formatting(path);
    return text === null || text === document.getText()
      ? []
      : [
          {
            range: { start: { line: 0, character: 0 }, end: document.positionAt(document.getText().length) },
            newText: text,
          },
        ];
  }),
);
connection.onCodeAction((params) =>
  guarded(() => {
    const path = sourcePath(params.textDocument.uri),
      document = documents.get(params.textDocument.uri);
    if (path === undefined || document === undefined) return [];
    const text = workspace().formatting(path);
    if (text === null || text === document.getText()) return [];
    return [
      {
        title: 'Format IA with preservation checks',
        kind: CodeActionKind.Source + '.format',
        edit: {
          documentChanges: [
            {
              textDocument: { uri: document.uri, version: document.version },
              edits: [
                {
                  range: { start: { line: 0, character: 0 }, end: document.positionAt(document.getText().length) },
                  newText: text,
                },
              ],
            },
          ],
        },
      },
    ];
  }),
);
connection.languages.semanticTokens.on((params) =>
  guarded(() => {
    const path = sourcePath(params.textDocument.uri),
      builder = new SemanticTokensBuilder();
    if (path !== undefined && workspace().sourceText(path) !== undefined)
      for (const t of workspace().semanticTokens(path))
        builder.push(
          t.line,
          t.character,
          t.length,
          legend.indexOf(t.type),
          t.modifiers.includes('declaration') ? 1 : 0,
        );
    return builder.build();
  }),
);
connection.languages.inlayHint.on((params) =>
  guarded(() => {
    const path = sourcePath(params.textDocument.uri);
    if (!hints || path === undefined) return [];
    return workspace()
      .symbols(path)
      .filter(
        (s) =>
          s.selectionRange.start.line >= params.range.start.line &&
          s.selectionRange.start.line <= params.range.end.line,
      )
      .map((s) => ({ position: s.selectionRange.end, label: s.detail, paddingLeft: true, kind: InlayHintKind.Type }));
  }),
);
connection.onRequest(METHOD + 'request', (input: unknown): unknown => {
  if (request(input).operation === 'rebuild') schedule(true);
  return guarded<unknown>(() => {
    const message = request(input),
      stamp: ViewStamp = message.stamp ?? workspace().stamp();
    switch (message.operation) {
      case 'view':
        return workspace().view();
      case 'composition':
        return workspace().composition(stamp);
      case 'inspect':
        return workspace().inspect(message.occurrence ?? '', stamp, message.coordinate);
      case 'graph':
        return workspace().graph(message.occurrence, stamp, message.coordinate, message.depth);
      case 'source':
        return workspace().source(message.action ?? '', stamp);
      case 'virtualSource': {
        const path = sourcePath(message.path ?? '');
        return path === undefined ? null : workspace().sourceText(path);
      }
      case 'shapes':
        return workspace().draftShapes();
      case 'steward':
        workspace().assertStamp(stamp);
        return workspace().steward(message.name ?? '');
      case 'draft':
        return workspace().draft(message.discriminator ?? '', message.name ?? '', message.fields);
      case 'validateProposal':
        return workspace().validateProposal(message.files ?? [], stamp);
      case 'sources':
        workspace().assertStamp(stamp);
        return workspace().sources;
      case 'rebuild':
        return workspace().view();
      default:
        throw new EditorError('invalid', 'Unknown editor operation');
    }
  });
});
connection.onShutdown(() => {
  if (timer !== undefined) clearTimeout(timer);
  owner?.close();
});
documents.listen(connection);
connection.listen();
