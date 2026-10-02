import * as vscode from 'vscode';
import { resolve } from 'node:path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

const clients = new Map<string, LanguageClient>();
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const start = async (folder: vscode.WorkspaceFolder): Promise<void> => {
    if (folder.uri.scheme !== 'file' || clients.has(folder.uri.toString())) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.ia/**/*.ia'));
    const client = new LanguageClient(
      `ia-${folder.index}`,
      'IA language',
      {
        module: resolve(context.extensionPath, 'dist/server.cjs'),
        transport: TransportKind.stdio,
      },
      {
        workspaceFolder: folder,
        documentSelector: [
          { scheme: 'file', language: 'inventarch-ia', pattern: `${folder.uri.fsPath.replaceAll('\\', '/')}/**/*.ia` },
        ],
        initializationOptions: { protocol: 1, root: folder.uri.fsPath },
        synchronize: { fileEvents: watcher },
      },
    );
    clients.set(folder.uri.toString(), client);
    context.subscriptions.push(watcher);
    try {
      await client.start();
    } catch (error) {
      clients.delete(folder.uri.toString());
      throw error;
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) {
        const key = folder.uri.toString(),
          client = clients.get(key);
        clients.delete(key);
        void client?.stop();
      }
      for (const folder of event.added)
        void start(folder).catch((error) => vscode.window.showErrorMessage(String(error)));
    }),
  );
  await Promise.all((vscode.workspace.workspaceFolders ?? []).map(start));
}
export async function deactivate(): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.stop()));
  clients.clear();
}
