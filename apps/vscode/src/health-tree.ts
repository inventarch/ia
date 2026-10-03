import * as vscode from 'vscode';
import type { EditorView } from '@inventarch/runtime/editor';

interface HealthOwner {
  readonly folder: vscode.WorkspaceFolder;
  readonly view?: EditorView;
  readonly state: string;
  readonly message?: string;
}
interface HealthItem extends vscode.TreeItem {
  readonly ownerKey?: string;
}

export function healthProvider(
  owners: () => Iterable<HealthOwner>,
  changed: vscode.Event<undefined>,
): vscode.TreeDataProvider<HealthItem> {
  return {
    onDidChangeTreeData: changed,
    getTreeItem: (item) => item,
    getChildren(parent) {
      if (parent) {
        if (!parent.ownerKey) return [];
        const owner = [...owners()].find((candidate) => candidate.folder.uri.toString() === parent.ownerKey);
        return (owner?.view?.health ?? []).map((health) => {
          const item = new vscode.TreeItem(`${health.check}: ${health.outcome}`);
          item.id = JSON.stringify([parent.ownerKey, health.check]);
          item.description = owner!.folder.name;
          item.iconPath = new vscode.ThemeIcon(
            health.outcome === 'pass' ? 'pass' : health.outcome === 'fail' ? 'error' : 'circle-outline',
          );
          return item;
        });
      }
      return [...owners()].map((owner) => {
        const item: HealthItem = Object.assign(
          new vscode.TreeItem(
            owner.folder.name,
            owner.view?.health.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
          ),
          { ownerKey: owner.folder.uri.toString() },
        );
        item.id = JSON.stringify([item.ownerKey]);
        const errors = owner.view?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
        const warnings = owner.view?.diagnostics.filter((d) => d.severity === 'warning').length ?? 0;
        item.description =
          owner.view === undefined
            ? owner.state
            : `${errors} errors · ${warnings} warnings · gen ${owner.view.stamp.generation}`;
        item.iconPath = new vscode.ThemeIcon(owner.state === 'unavailable' ? 'warning' : errors > 0 ? 'error' : 'pass');
        item.tooltip = owner.message ?? owner.folder.uri.fsPath;
        item.command = { command: 'inventarch.workbench', title: 'Open Workbench' };
        item.contextValue = 'healthWorkspace';
        return item;
      });
    },
  };
}
