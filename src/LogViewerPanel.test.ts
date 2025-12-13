import * as vscode from 'vscode';
import * as fs from 'fs';
import { LogViewerPanel } from './LogViewerPanel';
import { LogDataProvider } from './LogDataProvider';

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

// Mock LogDataProvider
jest.mock('./LogDataProvider', () => ({
    LogDataProvider: jest.fn().mockImplementation(() => ({
        getSessions: jest.fn().mockReturnValue({ sessions: ['s1'], hasRootLogs: true }),
        getLogs: jest.fn().mockReturnValue(['a.log']),
        getLogContent: jest.fn().mockReturnValue('log content')
    }))
}));

describe('LogViewerPanel', () => {
    const extensionUri = { fsPath: '/ext' } as any;
    let mockWebview: any;
    let mockPanel: any;
    let messageCallback: (message: any) => void;
    let configCallback: (e: any) => void;
    let watchCallback: (eventType: string, filename: string) => void;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        
        // Restore workspace folders
        // @ts-ignore
        vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/root' } }];

        // Restore configuration
        (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
            get: jest.fn((key) => {
                if (key === 'logDirectory') return 'log';
                if (key === 'autoRefresh') return true;
                if (key === 'showLineNumbers') return true;
                if (key === 'filePattern') return '*.log';
                return undefined;
            })
        }));

        // Setup mock webview and panel
        mockWebview = {
            onDidReceiveMessage: jest.fn((cb) => { messageCallback = cb; }),
            postMessage: jest.fn(),
            asWebviewUri: jest.fn((uri) => uri),
            cspSource: 'mock-csp',
            html: ''
        };
        
        mockPanel = {
            webview: mockWebview,
            reveal: jest.fn(),
            dispose: jest.fn(),
            onDidDispose: jest.fn(),
            title: ''
        };

        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);
        
        // Capture config change callback
        (vscode.workspace.onDidChangeConfiguration as jest.Mock).mockImplementation((cb) => {
            configCallback = cb;
            return { dispose: jest.fn() };
        });

        // Capture fs.watch callback
        (fs.watch as jest.Mock).mockImplementation((path, options, cb) => {
            // console.log('fs.watch called with:', path);
            if (typeof options === 'function') {
                cb = options;
            }
            watchCallback = cb;
            return { close: jest.fn(), on: jest.fn() };
        });

        // Reset static currentPanel
        if (LogViewerPanel.currentPanel) {
            LogViewerPanel.currentPanel.dispose();
        }
    });

    afterEach(() => {
        jest.useRealTimers();
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
        expect(mockPanel.reveal).toHaveBeenCalled();
    });

    test('dispose should clear currentPanel', () => {
        LogViewerPanel.createOrShow(extensionUri);
        expect(LogViewerPanel.currentPanel).toBeDefined();
        
        LogViewerPanel.currentPanel?.dispose();
        expect(LogViewerPanel.currentPanel).toBeUndefined();
        expect(mockPanel.dispose).toHaveBeenCalled();
    });

    test('should setup file watcher on creation', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        
        LogViewerPanel.createOrShow(extensionUri);
        
        expect(fs.watch).toHaveBeenCalled();
    });

    describe('Message Handling', () => {
        beforeEach(() => {
            LogViewerPanel.createOrShow(extensionUri);
        });

        test('should handle alert message', () => {
            messageCallback({ command: 'alert', text: 'test error' });
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('test error');
        });

        test('should handle getSessions message', () => {
            messageCallback({ command: 'getSessions' });
            
            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'updateSettings'
            }));
            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'setSessions',
                sessions: ['s1'],
                hasRootLogs: true
            }));
        });

        test('should handle getLogsForSession message', () => {
            messageCallback({ command: 'getLogsForSession', session: 's1' });
            
            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'setSessionLogs',
                logs: ['a.log'],
                session: 's1'
            }));
        });

        test('should handle getLogContent message', () => {
            messageCallback({ command: 'getLogContent', session: 's1', logName: 'a.log' });
            
            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'setLogContent',
                content: 'log content',
                logName: 'a.log'
            }));
        });
    });

    describe('Configuration Changes', () => {
        beforeEach(() => {
            LogViewerPanel.createOrShow(extensionUri);
        });

        test('should refresh when logDirectory changes', () => {
            const event = {
                affectsConfiguration: (section: string) => section === 'logViewer.logDirectory'
            };
            
            configCallback(event);
            
            expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'resetState' });
            // Should also trigger session refresh
            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'setSessions'
            }));
        });

        test('should refresh when autoRefresh changes', () => {
            const event = {
                affectsConfiguration: (section: string) => section === 'logViewer.autoRefresh'
            };
            
            configCallback(event);
            
            expect(mockWebview.postMessage).toHaveBeenCalledWith({ command: 'refreshAllLogs' });
        });

        test('should update settings when display settings change', () => {
            const event = {
                affectsConfiguration: (section: string) => section === 'logViewer.showLineNumbers'
            };
            
            configCallback(event);
            
            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'updateSettings'
            }));
        });
    });

    describe('File Watching', () => {
        beforeEach(() => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            LogViewerPanel.createOrShow(extensionUri);
        });

        test('should handle file changes with debounce', () => {
            // Trigger file change
            watchCallback('change', 'test.log');
            
            // Should not send immediately
            expect(mockWebview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
                command: 'filesChanged'
            }));

            // Fast forward timers
            jest.runAllTimers();

            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'filesChanged',
                filenames: ['test.log']
            }));
        });

        test('should debounce multiple file changes', () => {
            watchCallback('change', 'log1.log');
            watchCallback('change', 'log2.log');
            
            jest.runAllTimers();

            // Should send batch
            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'filesChanged',
                filenames: expect.arrayContaining(['log1.log', 'log2.log'])
            }));
        });

        test('should refresh sessions on file change', () => {
            watchCallback('change', 'new.log');
            
            jest.runAllTimers();

            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'refreshCurrentSession'
            }));
            expect(mockWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: 'setSessions'
            }));
        });

        test('should handle log directory deletion', () => {
            // Simulate log dir deleted
            (fs.existsSync as jest.Mock).mockReturnValue(false);
            
            watchCallback('rename', 'log');
            
            // Should re-setup watcher (which will now use root watcher)
            expect(fs.watch).toHaveBeenCalledTimes(2);
        });

        test('should handle watcher error', () => {
            // Get the error handler from the mock
            const mockWatcher = (fs.watch as jest.Mock).mock.results[0].value;
            const errorCallback = mockWatcher.on.mock.calls.find((call: any) => call[0] === 'error')[1];
            
            errorCallback(new Error('Watcher error'));
            
            // Should re-setup watcher
            expect(fs.watch).toHaveBeenCalledTimes(2);
        });
    });

    describe('Edge Cases', () => {
        test('should handle no workspace folders', () => {
            // @ts-ignore
            vscode.workspace.workspaceFolders = undefined;
            
            LogViewerPanel.createOrShow(extensionUri);
            
            // Trigger methods that check for workspace folders
            messageCallback({ command: 'getSessions' });
            messageCallback({ command: 'getLogsForSession', session: 's1' });
            messageCallback({ command: 'getLogContent', session: 's1', logName: 'a.log' });
            
            // Should not post messages (except updateSettings which doesn't check workspace)
            expect(mockWebview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
                command: 'setSessions'
            }));
        });

        test('should dispose all resources', () => {
            LogViewerPanel.createOrShow(extensionUri);
            
            // Add a disposable
            const mockDisposable = { dispose: jest.fn() };
            // @ts-ignore
            LogViewerPanel.currentPanel._disposables.push(mockDisposable);
            
            LogViewerPanel.currentPanel?.dispose();
            
            expect(mockDisposable.dispose).toHaveBeenCalled();
        });

        test('should close panel via static method', () => {
            LogViewerPanel.createOrShow(extensionUri);
            expect(LogViewerPanel.currentPanel).toBeDefined();
            
            LogViewerPanel.close();
            
            expect(mockPanel.dispose).toHaveBeenCalled();
        });

        test('should not setup watcher if autoRefresh is disabled', () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: (key: string) => {
                    if (key === 'autoRefresh') return false;
                    return undefined;
                }
            });
            
            LogViewerPanel.createOrShow(extensionUri);
            
            expect(fs.watch).not.toHaveBeenCalled();
        });
    });
});
