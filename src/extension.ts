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
}

export function deactivate() {}
