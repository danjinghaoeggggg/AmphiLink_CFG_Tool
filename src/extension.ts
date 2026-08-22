import * as vscode from 'vscode';
import { AmphiLinkCfgViewProvider } from './webview/amphiLinkCfgViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AmphiLinkCfgViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(AmphiLinkCfgViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('amphilinkCfg.refreshEnvironment', () => provider.refreshEnvironment()),
    vscode.commands.registerCommand('amphilinkCfg.refreshDevices', () => provider.refreshDevices()),
    vscode.commands.registerCommand('amphilinkCfg.saveProject', () => provider.saveProject())
  );
}

export function deactivate(): void {}
