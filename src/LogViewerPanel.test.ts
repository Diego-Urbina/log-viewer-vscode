import * as vscode from 'vscode';
import * as fs from 'fs';
import { LogViewerPanel } from './LogViewerPanel';

// Mock fs
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    watch: jest.fn(() => ({
        close: jest.fn(),
        on: jest.fn()
    })),
    readdirSync: jest.fn(),
    readFileSync: jest.fn(),
    statSync: jest.fn(() => ({
        isDirectory: jest.fn(() => true)
    }))
}));

describe('LogViewerPanel', () => {
    const extensionUri = { fsPath: '/ext' } as any;

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset static currentPanel
        if (LogViewerPanel.currentPanel) {
            LogViewerPanel.currentPanel.dispose();
        }
    });

    test('createOrShow should create a new panel if none exists', () => {
        LogViewerPanel.createOrShow(extensionUri);
        
        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            LogViewerPanel.viewType,
            'Log Viewer',
            vscode.ViewColumn.One,
            expect.any(Object)
        );
        expect(LogViewerPanel.currentPanel).toBeDefined();
    });

    test('createOrShow should reveal existing panel', () => {
        LogViewerPanel.createOrShow(extensionUri);
        const firstPanel = LogViewerPanel.currentPanel;
        
        // Call again
        LogViewerPanel.createOrShow(extensionUri);
        
        expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
        // @ts-ignore - accessing private property for test
        expect(firstPanel._panel.reveal).toHaveBeenCalled();
    });

    test('dispose should clear currentPanel', () => {
        LogViewerPanel.createOrShow(extensionUri);
        expect(LogViewerPanel.currentPanel).toBeDefined();
        
        LogViewerPanel.currentPanel?.dispose();
        expect(LogViewerPanel.currentPanel).toBeUndefined();
    });

    test('should setup file watcher on creation', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        
        LogViewerPanel.createOrShow(extensionUri);
        
        expect(fs.watch).toHaveBeenCalled();
    });
});
