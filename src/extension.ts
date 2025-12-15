import * as vscode from 'vscode';
import { LogViewerPanel } from './LogViewerPanel';

export function activate(context: vscode.ExtensionContext) {
	console.log('Log Viewer is now active!');

	context.subscriptions.push(
		vscode.commands.registerCommand('log-viewer.open', () => {
			console.log('Command log-viewer.open executed');
			LogViewerPanel.createOrShow(context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('log-viewer.close', () => {
			console.log('Command log-viewer.close executed');
			LogViewerPanel.close();
		})
	);

	if (vscode.window.registerWebviewPanelSerializer) {
		// Make sure we register a serializer in activation event
		vscode.window.registerWebviewPanelSerializer(LogViewerPanel.viewType, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				console.log(`Got state: ${state}`);
				// Reset the webview options so we use latest uri for `localResourceRoots`.
				webviewPanel.webview.options = {
					enableScripts: true,
					localResourceRoots: [context.extensionUri]
				};
				LogViewerPanel.revive(webviewPanel, context.extensionUri);
			}
		});
	}
}

export function deactivate() {}
