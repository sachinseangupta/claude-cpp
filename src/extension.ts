import * as vscode from 'vscode';
import { Controller } from './controller';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('claudeCpp.open', () => controller.open()),
    vscode.commands.registerCommand('claudeCpp.compile', () => controller.compile()),
    vscode.commands.registerCommand('claudeCpp.send', () => controller.send()),
    vscode.commands.registerCommand('claudeCpp.newSession', () => controller.newSession()),
    vscode.commands.registerCommand('claudeCpp.resetHeader', () => controller.resetHeader()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (controller.isPromptSource(doc.uri) && vscode.workspace.getConfiguration('claudeCpp').get<boolean>('compileOnSave', true)) {
        void controller.compile();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void controller.compile()),
  );

  if (vscode.workspace.workspaceFolders?.length && vscode.workspace.getConfiguration('claudeCpp').get<boolean>('autoOpen', true)) {
    void controller.open({ focusEditor: true });
  }
}

export function deactivate(): void {}
