import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({
  EventEmitter: class {
    event = (): void => undefined;
    fire(): void {
      /* unused */
    }
  },
  ViewColumn: { Beside: -2 },
  Uri: {
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({ fsPath: resolve(base.fsPath, ...segments) }),
  },
  window: { createWebviewPanel: (viewType: string, title: string) => ({ viewType, title }) },
}));
vi.mock('vscode-languageclient/node', () => ({ LanguageClient: class {}, TransportKind: { stdio: 0 } }));

const root = resolve(import.meta.dirname, '..');
interface Manifest {
  contributes: { languages: readonly { id: string; icon?: { light: string; dark: string } }[] };
}
const language = (): { icon?: { light: string; dark: string } } => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest;
  return manifest.contributes.languages.find((l) => l.id === 'inventarch-ia')!;
};
it('contributes an existing light and dark file icon for IA sources', () => {
  const icon = language().icon;
  expect(icon).toBeDefined();
  for (const path of [icon!.light, icon!.dark]) {
    expect(path).toMatch(/\.svg$/);
    expect(existsSync(resolve(root, path))).toBe(true);
  }
});
