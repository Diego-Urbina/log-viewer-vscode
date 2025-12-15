import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { matchesFilePattern } from './utils';
import { LogDataProvider } from './LogDataProvider';

export class LogViewerPanel {
    public static currentPanel: LogViewerPanel | undefined;
    public static readonly viewType = 'logViewerV2';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _dataProvider: LogDataProvider;
    private _disposables: vscode.Disposable[] = [];
    private _fileWatcher: fs.FSWatcher | undefined;
    private _rootWatcher: fs.FSWatcher | undefined;
    
    // Debouncing for file changes
    private _pendingFileChanges: Set<string> = new Set();
    private _fileChangeTimer: NodeJS.Timeout | undefined;
    private _sessionRefreshTimer: NodeJS.Timeout | undefined;
    private static readonly DEBOUNCE_DELAY = 150; // ms

    public static createOrShow(extensionUri: vscode.Uri) {
        console.log('LogViewerPanel.createOrShow called');
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (LogViewerPanel.currentPanel) {
            LogViewerPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            LogViewerPanel.viewType,
            'Log Viewer',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        LogViewerPanel.currentPanel = new LogViewerPanel(panel, extensionUri);
    }

    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        LogViewerPanel.currentPanel = new LogViewerPanel(panel, extensionUri);
    }

    public static close() {
        if (LogViewerPanel.currentPanel) {
            LogViewerPanel.currentPanel._panel.dispose();
        }
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._dataProvider = new LogDataProvider();

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'alert':
                        vscode.window.showErrorMessage(message.text);
                        return;
                    case 'getSessions':
                        // Send initial settings along with sessions
                        const cfg = this._getConfig();
                        this._panel.webview.postMessage({
                            command: 'updateSettings',
                            showLineNumbers: cfg.showLineNumbers,
                            wrapLines: cfg.wrapLines,
                            tailMode: cfg.tailMode
                        });
                        this._sendSessions();
                        return;
                    case 'getLogsForSession':
                        this._sendLogsForSession(message.session);
                        return;
                    case 'getLogContent':
                        this._sendLogContent(message.session, message.logName);
                        return;
                }
            },
            null,
            this._disposables
        );

        // Setup file watcher for auto-refresh
        this._setupFileWatcher();

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('logViewer.logDirectory') || e.affectsConfiguration('logViewer.filePattern')) {
                this._setupFileWatcher();
                // Notify webview to reset state when directory changes
                this._panel.webview.postMessage({ command: 'resetState' });
                this._sendSessions();
            }
            if (e.affectsConfiguration('logViewer.autoRefresh')) {
                this._setupFileWatcher();
                // If autoRefresh was enabled, refresh all logs
                if (this._getConfig().autoRefresh) {
                    this._panel.webview.postMessage({ command: 'refreshAllLogs' });
                }
            }
            if (e.affectsConfiguration('logViewer.showLineNumbers') || 
                e.affectsConfiguration('logViewer.wrapLines') ||
                e.affectsConfiguration('logViewer.tailMode')) {
                const cfg = this._getConfig();
                this._panel.webview.postMessage({ 
                    command: 'updateSettings',
                    showLineNumbers: cfg.showLineNumbers,
                    wrapLines: cfg.wrapLines,
                    tailMode: cfg.tailMode
                });
            }
        }, null, this._disposables);
    }

    private _getConfig() {
        const config = vscode.workspace.getConfiguration('logViewer');
        return {
            logDirectory: config.get<string>('logDirectory') || 'log',
            autoRefresh: config.get<boolean>('autoRefresh') ?? true,
            showLineNumbers: config.get<boolean>('showLineNumbers') ?? true,
            filePattern: config.get<string>('filePattern') || '*.log',
            wrapLines: config.get<boolean>('wrapLines') ?? false,
            tailMode: config.get<boolean>('tailMode') ?? false,
            stripAnsiCodes: config.get<boolean>('stripAnsiCodes') ?? true
        };
    }

    private _matchesFilePattern(filename: string): boolean {
        return matchesFilePattern(filename, this._getConfig().filePattern);
    }

    private _getLogDirectoryName(): string {
        return this._getConfig().logDirectory;
    }

    private _setupFileWatcher() {
        // Clean up existing watchers first
        if (this._fileWatcher) {
            this._fileWatcher.close();
            this._fileWatcher = undefined;
        }
        if (this._rootWatcher) {
            this._rootWatcher.close();
            this._rootWatcher = undefined;
        }

        // Skip if autoRefresh is disabled
        if (!this._getConfig().autoRefresh) {
            return;
        }

        if (!vscode.workspace.workspaceFolders) {
            return;
        }
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const logDirName = this._getLogDirectoryName();
        const logDir = path.join(rootPath, logDirName);

        if (fs.existsSync(logDir)) {
            // Watch the log directory for changes
            this._fileWatcher = fs.watch(logDir, { recursive: true }, (eventType, filename) => {
                // Check if log directory still exists (might have been deleted)
                if (!fs.existsSync(logDir)) {
                    this._setupFileWatcher();
                    this._sendSessions();
                    return;
                }
                
                if (filename && this._matchesFilePattern(path.basename(filename))) {
                    // Add to pending changes (debounced)
                    const logName = path.basename(filename);
                    this._pendingFileChanges.add(logName);
                    this._scheduleFileChangeFlush();
                }
                // Debounce session refresh too
                this._scheduleSessionRefresh();
            });

            this._fileWatcher.on('error', () => {
                this._setupFileWatcher();
                this._sendSessions();
            });
        } else {
            this._rootWatcher = fs.watch(rootPath, (eventType, filename) => {
                if (filename === logDirName) {
                    const logDirPath = path.join(rootPath, logDirName);
                    if (fs.existsSync(logDirPath) && fs.statSync(logDirPath).isDirectory()) {
                        this._setupFileWatcher();
                        this._sendSessions();
                    }
                }
            });

            this._rootWatcher.on('error', () => {
                setTimeout(() => this._setupFileWatcher(), 1000);
            });
        }
    }

    private _scheduleFileChangeFlush() {
        if (this._fileChangeTimer) {
            clearTimeout(this._fileChangeTimer);
        }
        this._fileChangeTimer = setTimeout(() => {
            this._flushFileChanges();
        }, LogViewerPanel.DEBOUNCE_DELAY);
    }

    private _flushFileChanges() {
        if (this._pendingFileChanges.size === 0) {
            return;
        }
        // Send all pending file changes as a batch
        const files = Array.from(this._pendingFileChanges);
        this._pendingFileChanges.clear();
        
        // Send batch notification to webview
        this._panel.webview.postMessage({ 
            command: 'filesChanged', 
            filenames: files 
        });
    }

    private _scheduleSessionRefresh() {
        if (this._sessionRefreshTimer) {
            clearTimeout(this._sessionRefreshTimer);
        }
        this._sessionRefreshTimer = setTimeout(() => {
            this._sendSessions();
            // Also notify webview to refresh current session's logs
            this._panel.webview.postMessage({ command: 'refreshCurrentSession' });
        }, LogViewerPanel.DEBOUNCE_DELAY * 2); // Slightly longer delay for sessions
    }

    public dispose() {
        LogViewerPanel.currentPanel = undefined;

        // Clear pending timers
        if (this._fileChangeTimer) {
            clearTimeout(this._fileChangeTimer);
        }
        if (this._sessionRefreshTimer) {
            clearTimeout(this._sessionRefreshTimer);
        }

        // Close file watchers
        if (this._fileWatcher) {
            this._fileWatcher.close();
            this._fileWatcher = undefined;
        }
        if (this._rootWatcher) {
            this._rootWatcher.close();
            this._rootWatcher = undefined;
        }

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.title = 'Log Viewer';
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));

        // Do the same for the stylesheet.
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Log Viewer</title>
                <link href="${styleUri}" rel="stylesheet">
            </head>
            <body>
                <div class="sidebar">
                    <div class="session-selector">
                        <select id="session-select">
                            <option value="" disabled selected>Select session...</option>
                        </select>
                    </div>
                    <div class="section-header" id="pinned-header" style="display:none;"><svg class="section-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 1.5L10.793 2.207L11.793 3.207L8.5 6.5L5 4.5L3.5 6L7.793 9.293L2.5 14.586V15.5H3.414L8.707 10.207L12 14.5L13.5 13L11.5 9.5L14.793 6.207L15.793 7.207L16.5 6.5L11.5 1.5Z"/></svg> Pinned</div>
                    <div class="pinned-section" id="pinned-logs"></div>
                    <div class="section-header" id="all-logs-header">All Logs</div>
                    <div class="log-section" id="all-logs"></div>
                </div>
                
                <div class="main-area" id="main-area" tabindex="-1">
                    <div class="log-header">
                        <span class="log-title" id="current-log-title">Select a log</span>
                    </div>
                    <div class="filter-bar">
                        <div class="filter-input-wrapper">
                            <input type="text" class="filter-input" id="filter-text" placeholder="Filter logs...">
                            <button class="filter-clear hidden" id="filter-clear" title="Clear filter">×</button>
                        </div>
                        <div class="severity-filters">
                            <button class="severity-btn error active" data-severity="log-error">ERROR</button>
                            <button class="severity-btn warn active" data-severity="log-warn">WARN</button>
                            <button class="severity-btn info active" data-severity="log-info">INFO</button>
                            <button class="severity-btn debug active" data-severity="log-debug">DEBUG</button>
                            <button class="severity-btn trace active" data-severity="log-trace">TRACE</button>
                            <button class="severity-btn verbose active" data-severity="log-verbose">VERBOSE</button>
                        </div>
                    </div>
                    <div id="log-content"><div class="empty-state">Select a log from the sidebar</div></div>
                    
                    <!-- Search bar (Ctrl+F) -->
                    <div class="search-bar" id="search-bar">
                        <input type="text" id="search-input" placeholder="Find in log...">
                        <span class="search-count" id="search-count"></span>
                        <button class="search-nav-btn" id="search-prev" title="Previous (Shift+Enter)">▲</button>
                        <button class="search-nav-btn" id="search-next" title="Next (Enter)">▼</button>
                        <button class="search-close" id="search-close" title="Close (Esc)">×</button>
                    </div>
                </div>
                
                <!-- Quick Picker (Ctrl+P) -->
                <div class="quick-picker-overlay" id="quick-picker-overlay">
                    <div class="quick-picker">
                        <input type="text" class="quick-picker-input" id="quick-picker-input" placeholder="Select log...">
                        <div class="quick-picker-list" id="quick-picker-list"></div>
                    </div>
                </div>
                
                <!-- Help Panel (? or F1) -->
                <div class="help-overlay" id="help-overlay">
                    <div class="help-panel">
                        <div class="help-title">
                            <span>Keyboard Shortcuts</span>
                            <button class="help-close" id="help-close" title="Close (Esc)">×</button>
                        </div>
                        <div class="help-section">
                            <div class="help-section-title">Navigation</div>
                            <div class="help-row"><span>Go to filter bar</span><span class="help-key">Ctrl+L</span></div>
                            <div class="help-row"><span>Search in log</span><span class="help-key">Ctrl+F</span></div>
                            <div class="help-row"><span>Quick log picker</span><span class="help-key">Ctrl+P</span></div>
                            <div class="help-row"><span>Previous/Next log</span><span class="help-key">Alt+↑/↓</span></div>
                            <div class="help-row"><span>Toggle pin</span><span class="help-key">Alt+P</span></div>
                        </div>
                        <div class="help-section">
                            <div class="help-section-title">Scrolling</div>
                            <div class="help-row"><span>Scroll up/down</span><span class="help-key">↑/↓</span></div>
                            <div class="help-row"><span>Page up/down</span><span class="help-key">PgUp/PgDn</span></div>
                            <div class="help-row"><span>Go to start/end</span><span class="help-key">Home/End</span></div>
                        </div>
                        <div class="help-section">
                            <div class="help-section-title">Search</div>
                            <div class="help-row"><span>Next match</span><span class="help-key">Enter</span></div>
                            <div class="help-row"><span>Previous match</span><span class="help-key">Shift+Enter</span></div>
                        </div>
                        <div class="help-section">
                            <div class="help-section-title">General</div>
                            <div class="help-row"><span>Show this help</span><span class="help-key">? / F1</span></div>
                            <div class="help-row"><span>Close panel/dialog</span><span class="help-key">Esc</span></div>
                        </div>
                    </div>
                </div>

                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    private _sendSessions() {
        if (!vscode.workspace.workspaceFolders) {
            return;
        }
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const logDirName = this._getLogDirectoryName();
        const logDir = path.join(rootPath, logDirName);
        const filePattern = this._getConfig().filePattern;

        const { sessions, hasRootLogs } = this._dataProvider.getSessions(logDir, filePattern);

        this._panel.webview.postMessage({ command: 'setSessions', sessions, hasRootLogs });
    }

    private _sendLogsForSession(session: string) {
        if (!vscode.workspace.workspaceFolders) {
            return;
        }
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const logDirName = this._getLogDirectoryName();
        const sessionDir = session === '__root__' 
            ? path.join(rootPath, logDirName)
            : path.join(rootPath, logDirName, session);
        const filePattern = this._getConfig().filePattern;

        const logs = this._dataProvider.getLogs(sessionDir, filePattern);

        this._panel.webview.postMessage({ command: 'setSessionLogs', logs, session });
    }

    private _sendLogContent(session: string, logName: string) {
        if (!vscode.workspace.workspaceFolders) {
            return;
        }
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const logDirName = this._getLogDirectoryName();
        const logPath = session === '__root__'
            ? path.join(rootPath, logDirName, logName)
            : path.join(rootPath, logDirName, session, logName);

        const content = this._dataProvider.getLogContent(logPath, this._getConfig().stripAnsiCodes);
        
        if (content !== null) {
            this._panel.webview.postMessage({ 
                command: 'setLogContent', 
                content: content,
                logName: logName
            });
        }
    }
}
