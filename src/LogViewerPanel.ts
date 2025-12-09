import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class LogViewerPanel {
    public static currentPanel: LogViewerPanel | undefined;
    public static readonly viewType = 'logViewerV2';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _fileWatcher: fs.FSWatcher | undefined;
    private _rootWatcher: fs.FSWatcher | undefined;

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

    public static close() {
        if (LogViewerPanel.currentPanel) {
            LogViewerPanel.currentPanel._panel.dispose();
        }
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

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

    private _stripAnsiCodes(text: string): string {
        // Remove ANSI escape codes (colors, formatting, cursor control, etc.)
        // eslint-disable-next-line no-control-regex
        return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
    }

    private _matchesFilePattern(filename: string): boolean {
        const patterns = this._getConfig().filePattern;
        // Support multiple patterns separated by comma
        const patternList = patterns.split(',').map(p => p.trim()).filter(p => p);
        
        return patternList.some(pattern => {
            // Convert glob pattern to regex
            const regexPattern = pattern
                .replace(/\./g, '\\.')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.');
            const regex = new RegExp(`^${regexPattern}$`, 'i');
            return regex.test(filename);
        });
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
                    // Notify webview to request updated content
                    const logName = path.basename(filename);
                    this._panel.webview.postMessage({ command: 'fileChanged', filename: logName });
                }
                // Refresh sessions in case new folders were added
                this._sendSessions();
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

    public dispose() {
        LogViewerPanel.currentPanel = undefined;

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
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Log Viewer</title>
                <style>
                    body { 
                        font-family: var(--vscode-font-family); 
                        padding: 0; 
                        margin: 0;
                        color: var(--vscode-editor-foreground); 
                        background-color: var(--vscode-editor-background);
                        display: flex;
                        flex-direction: row;
                        height: 100vh;
                    }
                    
                    /* Sidebar */
                    .sidebar {
                        display: flex;
                        flex-direction: column;
                        background: var(--vscode-sideBar-background);
                        border-right: 1px solid var(--vscode-sideBar-border);
                        width: 200px;
                        flex-shrink: 0;
                        overflow: hidden;
                    }
                    
                    /* Session selector */
                    .session-selector {
                        padding: 8px;
                        border-bottom: 1px solid var(--vscode-sideBar-border);
                    }
                    .session-selector select {
                        width: 100%;
                        background: var(--vscode-dropdown-background);
                        color: var(--vscode-dropdown-foreground);
                        border: 1px solid var(--vscode-dropdown-border);
                        padding: 4px 6px;
                        font-size: 12px;
                    }
                    
                    /* Section headers */
                    .section-header {
                        padding: 8px 10px;
                        font-weight: bold;
                        font-size: 11px;
                        text-transform: uppercase;
                        color: var(--vscode-sideBarSectionHeader-foreground);
                        background: var(--vscode-sideBarSectionHeader-background);
                        border-bottom: 1px solid var(--vscode-sideBar-border);
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .section-icon {
                        width: 12px;
                        height: 12px;
                        fill: currentColor;
                    }
                    
                    /* Log sections */
                    .log-section {
                        flex: 1;
                        overflow-y: auto;
                        display: flex;
                        flex-direction: column;
                    }
                    .pinned-section {
                        border-bottom: 1px solid var(--vscode-sideBar-border);
                    }
                    .pinned-section:empty {
                        display: none;
                    }
                    .pinned-section:empty + .section-header {
                        border-top: none;
                    }
                    
                    /* Log tabs */
                    .log-tab {
                        display: flex;
                        align-items: center;
                        padding: 6px 10px;
                        cursor: pointer;
                        background: transparent;
                        color: var(--vscode-sideBar-foreground);
                        gap: 6px;
                        overflow: hidden;
                    }
                    .log-tab:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    .log-tab.active {
                        background: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground);
                    }
                    .log-tab .tab-name {
                        flex: 1;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        font-size: 13px;
                    }
                    .log-tab .pin-btn {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        width: 18px;
                        height: 18px;
                        border-radius: 3px;
                        flex-shrink: 0;
                        opacity: 0;
                        cursor: pointer;
                    }
                    .log-tab .pin-btn svg {
                        width: 14px;
                        height: 14px;
                        fill: currentColor;
                    }
                    .log-tab:hover .pin-btn,
                    .log-tab .pin-btn.pinned {
                        opacity: 1;
                    }
                    .log-tab .pin-btn:hover {
                        background: var(--vscode-toolbar-hoverBackground);
                    }
                    .log-tab .pin-btn.pinned {
                        color: var(--vscode-textLink-foreground);
                    }
                    
                    /* Main content area */
                    .main-area {
                        flex: 1;
                        overflow: hidden;
                        display: flex;
                        flex-direction: column;
                    }
                    
                    /* Current log header */
                    .log-header {
                        display: flex;
                        align-items: center;
                        padding: 8px 12px;
                        background: var(--vscode-editor-background);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        gap: 8px;
                    }
                    .log-header .log-title {
                        font-weight: bold;
                        font-size: 13px;
                    }
                    
                    /* Filter bar */
                    .filter-bar {
                        display: flex;
                        align-items: center;
                        padding: 6px 12px;
                        background: var(--vscode-editor-background);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        gap: 8px;
                        flex-wrap: wrap;
                    }
                    .filter-input-wrapper {
                        position: relative;
                        flex: 1;
                        min-width: 150px;
                        display: flex;
                        align-items: center;
                    }
                    .filter-input {
                        width: 100%;
                        padding: 4px 24px 4px 8px;
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border, transparent);
                        border-radius: 2px;
                        font-size: 12px;
                    }
                    .filter-input:focus {
                        outline: 1px solid var(--vscode-focusBorder);
                        border-color: var(--vscode-focusBorder);
                    }
                    .filter-input::placeholder {
                        color: var(--vscode-input-placeholderForeground);
                    }
                    .filter-clear {
                        position: absolute;
                        right: 4px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        width: 16px;
                        height: 16px;
                        border: none;
                        background: transparent;
                        color: var(--vscode-input-foreground);
                        cursor: pointer;
                        opacity: 0.6;
                        font-size: 14px;
                        padding: 0;
                    }
                    .filter-clear:hover {
                        opacity: 1;
                    }
                    .filter-clear.hidden {
                        display: none;
                    }
                    .severity-filters {
                        display: flex;
                        gap: 4px;
                    }
                    .severity-btn {
                        padding: 2px 8px;
                        border: 1px solid var(--vscode-button-border, transparent);
                        border-radius: 3px;
                        font-size: 11px;
                        cursor: pointer;
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        opacity: 0.5;
                    }
                    .severity-btn:hover {
                        opacity: 0.8;
                    }
                    .severity-btn.active {
                        opacity: 1;
                    }
                    .severity-btn.error { border-color: var(--vscode-errorForeground, #f44747); }
                    .severity-btn.error.active { background: var(--vscode-errorForeground, #f44747); color: #fff; }
                    .severity-btn.warn { border-color: var(--vscode-editorWarning-foreground, #cca700); }
                    .severity-btn.warn.active { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
                    .severity-btn.info { border-color: var(--vscode-editorInfo-foreground, #3794ff); }
                    .severity-btn.info.active { background: var(--vscode-editorInfo-foreground, #3794ff); color: #fff; }
                    .severity-btn.debug { border-color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
                    .severity-btn.debug.active { background: var(--vscode-debugTokenExpression-name, #9cdcfe); color: #000; }
                    .severity-btn.trace { border-color: var(--vscode-descriptionForeground, #808080); }
                    .severity-btn.trace.active { background: var(--vscode-descriptionForeground, #808080); color: #fff; }
                    .severity-btn.verbose { border-color: var(--vscode-descriptionForeground, #6a6a6a); }
                    .severity-btn.verbose.active { background: var(--vscode-descriptionForeground, #6a6a6a); color: #fff; }
                    
                    /* Log content */
                    #log-content { 
                        white-space: pre-wrap; 
                        font-family: var(--vscode-editor-font-family), monospace;
                        font-size: var(--vscode-editor-font-size);
                        background: var(--vscode-editor-background); 
                        padding: 10px; 
                        overflow: auto; 
                        flex: 1;
                    }
                    
                    /* Log severity colors */
                    .log-line { display: flex; }
                    .line-number { 
                        color: var(--vscode-editorLineNumber-foreground, #858585); 
                        min-width: 50px; 
                        text-align: right; 
                        padding-right: 12px; 
                        user-select: none;
                        flex-shrink: 0;
                    }
                    .line-content { flex: 1; white-space: pre-wrap; word-break: break-all; }
                    .log-error .line-content { color: var(--vscode-errorForeground, #f44747); }
                    .log-warn .line-content { color: var(--vscode-editorWarning-foreground, #cca700); }
                    .log-info .line-content { color: var(--vscode-editorInfo-foreground, #3794ff); }
                    .log-debug .line-content { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
                    .log-trace .line-content { color: var(--vscode-descriptionForeground, #808080); }
                    .log-verbose .line-content { color: var(--vscode-descriptionForeground, #808080); }
                    
                    /* Empty state */
                    .empty-state {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        height: 100%;
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                    }
                    
                    /* Settings-based styles */
                    #log-content.hide-line-numbers .line-number { display: none; }
                    #log-content.no-wrap .line-content { white-space: pre; word-break: normal; }
                </style>
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
                
                <div class="main-area">
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
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // DOM elements
                    const sessionSelect = document.getElementById('session-select');
                    const pinnedHeader = document.getElementById('pinned-header');
                    const pinnedLogsEl = document.getElementById('pinned-logs');
                    const allLogsHeader = document.getElementById('all-logs-header');
                    const allLogsEl = document.getElementById('all-logs');
                    const logContent = document.getElementById('log-content');
                    const currentLogTitle = document.getElementById('current-log-title');
                    const filterTextInput = document.getElementById('filter-text');
                    const filterClearBtn = document.getElementById('filter-clear');
                    const severityButtons = document.querySelectorAll('.severity-btn');

                    const defaultSeverities = ['log-error', 'log-warn', 'log-info', 'log-debug', 'log-trace', 'log-verbose'];

                    // Restore state or initialize
                    const previousState = vscode.getState() || {};
                    let currentSession = previousState.currentSession || '';
                    let activeLog = previousState.activeLog || '';
                    let pinnedLogs = previousState.pinnedLogs || []; // Array of log names
                    let allLogs = previousState.allLogs || []; // Array of log names
                    let logContents = previousState.logContents || {}; // { logName: content }
                    let logFilters = previousState.logFilters || {}; // { logName: { text: '', severities: [...] } }
                    let tailMode = false; // Will be updated from settings

                    // Get current log's filter settings
                    function getLogFilter(logName) {
                        if (!logFilters[logName]) {
                            logFilters[logName] = { text: '', severities: [...defaultSeverities] };
                        }
                        return logFilters[logName];
                    }

                    // Update filter UI for current log
                    function updateFilterUI() {
                        const filter = getLogFilter(activeLog);
                        filterTextInput.value = filter.text;
                        filterClearBtn.classList.toggle('hidden', !filter.text);
                        severityButtons.forEach(btn => {
                            const severity = btn.dataset.severity;
                            if (filter.severities.includes(severity)) {
                                btn.classList.add('active');
                            } else {
                                btn.classList.remove('active');
                            }
                        });
                    }

                    // Save state helper
                    function saveState() {
                        vscode.setState({
                            currentSession,
                            activeLog,
                            pinnedLogs,
                            allLogs,
                            logContents,
                            logFilters
                        });
                    }

                    // Format log content with severity colors and line numbers
                    function formatLogContent(content) {
                        if (!content) return '<div class="empty-state">No content</div>';
                        
                        const filter = getLogFilter(activeLog);
                        const lines = content.split('\\n');
                        const searchText = filter.text.toLowerCase();
                        let lastSeverityClass = ''; // Track severity for multi-line messages
                        
                        const filteredLines = lines.map((line, index) => {
                            const lineNum = index + 1;
                            let severityClass = getSeverityClass(line);
                            
                            // If no severity found, inherit from previous line
                            if (!severityClass && lastSeverityClass) {
                                severityClass = lastSeverityClass;
                            } else if (severityClass) {
                                lastSeverityClass = severityClass;
                            }
                            
                            // Filter by severity
                            if (severityClass && !filter.severities.includes(severityClass)) {
                                return null;
                            }
                            // If line has no severity, show it anyway for context
                            
                            // Filter by text
                            if (searchText && !line.toLowerCase().includes(searchText)) {
                                return null;
                            }
                            
                            const escapedLine = escapeHtml(line);
                            return '<span class="log-line ' + severityClass + '" data-line="' + lineNum + '"><span class="line-number">' + lineNum + '</span><span class="line-content">' + escapedLine + '</span></span>';
                        }).filter(l => l !== null);
                        
                        if (filteredLines.length === 0) {
                            return '<div class="empty-state">No matching log lines</div>';
                        }
                        
                        return filteredLines.join('');
                    }

                    function escapeHtml(text) {
                        const div = document.createElement('div');
                        div.textContent = text;
                        return div.innerHTML;
                    }

                    function getSeverityClass(line) {
                        const upperLine = line.toUpperCase();
                        
                        // Check for pipe-delimited format first (e.g., "|INFO |" or "|ERROR|")
                        const pipeMatch = upperLine.match(/\\|\\s*(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|INFO|DEBUG|DBG|TRACE|TRC|VERBOSE|VERB|VRB)\\s*\\|/);
                        if (pipeMatch) {
                            const level = pipeMatch[1];
                            if (/ERROR|ERR|FATAL|CRITICAL|EXCEPTION/.test(level)) return 'log-error';
                            if (/WARN|WARNING/.test(level)) return 'log-warn';
                            if (level === 'INFO') return 'log-info';
                            if (/DEBUG|DBG/.test(level)) return 'log-debug';
                            if (/TRACE|TRC/.test(level)) return 'log-trace';
                            if (/VERBOSE|VERB|VRB/.test(level)) return 'log-verbose';
                        }
                        
                        // Check for bracket format (e.g., "[INFO]", "[ERROR]")
                        const bracketMatch = upperLine.match(/\\[\\s*(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|INFO|DEBUG|DBG|TRACE|TRC|VERBOSE|VERB|VRB)\\s*\\]/);
                        if (bracketMatch) {
                            const level = bracketMatch[1];
                            if (/ERROR|ERR|FATAL|CRITICAL|EXCEPTION/.test(level)) return 'log-error';
                            if (/WARN|WARNING/.test(level)) return 'log-warn';
                            if (level === 'INFO') return 'log-info';
                            if (/DEBUG|DBG/.test(level)) return 'log-debug';
                            if (/TRACE|TRC/.test(level)) return 'log-trace';
                            if (/VERBOSE|VERB|VRB/.test(level)) return 'log-verbose';
                        }
                        
                        return '';
                    }

                    // Create a log tab element
                    function createLogTab(logName, isPinned) {
                        const tab = document.createElement('div');
                        tab.className = 'log-tab' + (activeLog === logName ? ' active' : '');
                        
                        const nameSpan = document.createElement('span');
                        nameSpan.className = 'tab-name';
                        nameSpan.textContent = logName;
                        tab.appendChild(nameSpan);
                        
                        const pinBtn = document.createElement('span');
                        pinBtn.className = 'pin-btn' + (isPinned ? ' pinned' : '');
                        pinBtn.innerHTML = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 1.5L10.793 2.207L11.793 3.207L8.5 6.5L5 4.5L3.5 6L7.793 9.293L2.5 14.586V15.5H3.414L8.707 10.207L12 14.5L13.5 13L11.5 9.5L14.793 6.207L15.793 7.207L16.5 6.5L11.5 1.5Z"/></svg>';
                        pinBtn.title = isPinned ? 'Unpin' : 'Pin';
                        pinBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            togglePin(logName);
                        });
                        tab.appendChild(pinBtn);
                        
                        tab.addEventListener('click', () => selectLog(logName));
                        return tab;
                    }

                    // Render the sidebar
                    function renderSidebar() {
                        // Pinned section
                        pinnedLogsEl.innerHTML = '';
                        if (pinnedLogs.length > 0) {
                            pinnedHeader.style.display = 'block';
                            pinnedLogs.forEach(logName => {
                                pinnedLogsEl.appendChild(createLogTab(logName, true));
                            });
                        } else {
                            pinnedHeader.style.display = 'none';
                        }
                        
                        // All logs section (excluding pinned)
                        allLogsEl.innerHTML = '';
                        const unpinnedLogs = allLogs.filter(l => !pinnedLogs.includes(l));
                        if (unpinnedLogs.length > 0) {
                            allLogsHeader.style.display = 'block';
                            unpinnedLogs.forEach(logName => {
                                allLogsEl.appendChild(createLogTab(logName, false));
                            });
                        } else {
                            allLogsHeader.style.display = 'none';
                        }
                    }

                    // Select a log to view
                    function selectLog(logName) {
                        activeLog = logName;
                        currentLogTitle.textContent = logName;
                        
                        // Update filter UI for this log
                        updateFilterUI();
                        
                        if (logContents[logName]) {
                            logContent.innerHTML = formatLogContent(logContents[logName]);
                        } else {
                            logContent.innerHTML = '<div class="empty-state">Loading...</div>';
                            vscode.postMessage({ command: 'getLogContent', session: currentSession, logName });
                        }
                        
                        renderSidebar();
                        saveState();
                    }

                    // Toggle pin status
                    function togglePin(logName) {
                        const idx = pinnedLogs.indexOf(logName);
                        if (idx >= 0) {
                            pinnedLogs.splice(idx, 1);
                        } else {
                            pinnedLogs.push(logName);
                        }
                        renderSidebar();
                        saveState();
                    }

                    // Handle session change
                    sessionSelect.addEventListener('change', () => {
                        const session = sessionSelect.value;
                        if (session) {
                            currentSession = session;
                            activeLog = '';
                            pinnedLogs = [];
                            allLogs = [];
                            logContents = {};
                            currentLogTitle.textContent = 'Select a log';
                            logContent.innerHTML = '<div class="empty-state">Loading logs...</div>';
                            vscode.postMessage({ command: 'getLogsForSession', session });
                            saveState();
                        }
                    });

                    // Handle text filter
                    let filterTimeout;
                    filterTextInput.addEventListener('input', () => {
                        clearTimeout(filterTimeout);
                        filterTimeout = setTimeout(() => {
                            if (!activeLog) return;
                            const filter = getLogFilter(activeLog);
                            filter.text = filterTextInput.value;
                            filterClearBtn.classList.toggle('hidden', !filter.text);
                            if (logContents[activeLog]) {
                                logContent.innerHTML = formatLogContent(logContents[activeLog]);
                            }
                            saveState();
                        }, 150);
                    });

                    // Handle clear button
                    filterClearBtn.addEventListener('click', () => {
                        if (!activeLog) return;
                        const filter = getLogFilter(activeLog);
                        filter.text = '';
                        filterTextInput.value = '';
                        filterClearBtn.classList.add('hidden');
                        if (logContents[activeLog]) {
                            logContent.innerHTML = formatLogContent(logContents[activeLog]);
                        }
                        saveState();
                    });

                    // Handle severity filter buttons
                    severityButtons.forEach(btn => {
                        btn.addEventListener('click', () => {
                            if (!activeLog) return;
                            const filter = getLogFilter(activeLog);
                            const severity = btn.dataset.severity;
                            btn.classList.toggle('active');
                            
                            if (btn.classList.contains('active')) {
                                if (!filter.severities.includes(severity)) {
                                    filter.severities.push(severity);
                                }
                            } else {
                                const idx = filter.severities.indexOf(severity);
                                if (idx >= 0) {
                                    filter.severities.splice(idx, 1);
                                }
                            }
                            
                            if (logContents[activeLog]) {
                                logContent.innerHTML = formatLogContent(logContents[activeLog]);
                            }
                            saveState();
                        });
                    });

                    // Message handling from extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.command) {
                            case 'setSessions':
                                sessionSelect.innerHTML = '<option value="" disabled>Select session...</option>';
                                
                                if (message.hasRootLogs) {
                                    const opt = document.createElement('option');
                                    opt.value = '__root__';
                                    opt.textContent = '📁 log/ (root)';
                                    sessionSelect.appendChild(opt);
                                }
                                
                                message.sessions.forEach(session => {
                                    const opt = document.createElement('option');
                                    opt.value = session;
                                    opt.textContent = '📂 ' + session;
                                    sessionSelect.appendChild(opt);
                                });
                                
                                // Restore or auto-select session
                                if (currentSession && (message.sessions.includes(currentSession) || (currentSession === '__root__' && message.hasRootLogs))) {
                                    sessionSelect.value = currentSession;
                                } else if (message.hasRootLogs) {
                                    // Prioritize root logs if they exist
                                    sessionSelect.value = '__root__';
                                    currentSession = '__root__';
                                    vscode.postMessage({ command: 'getLogsForSession', session: currentSession });
                                } else if (message.sessions.length > 0) {
                                    // Otherwise, select newest session (first in list, already sorted newest first)
                                    sessionSelect.value = message.sessions[0];
                                    currentSession = message.sessions[0];
                                    vscode.postMessage({ command: 'getLogsForSession', session: '__root__' });
                                }
                                break;
                                
                            case 'setSessionLogs':
                                allLogs = message.logs;
                                logContents = {};
                                
                                // Request content for all logs
                                allLogs.forEach(logName => {
                                    vscode.postMessage({ command: 'getLogContent', session: currentSession, logName });
                                });
                                
                                // Select first log if none selected
                                if (allLogs.length > 0 && !activeLog) {
                                    selectLog(allLogs[0]);
                                } else if (allLogs.length === 0) {
                                    logContent.innerHTML = '<div class="empty-state">No logs in this session</div>';
                                }
                                
                                renderSidebar();
                                saveState();
                                break;
                                
                            case 'setLogContent':
                                logContents[message.logName] = message.content;
                                if (activeLog === message.logName) {
                                    logContent.innerHTML = formatLogContent(message.content);
                                    if (tailMode) {
                                        logContent.scrollTop = logContent.scrollHeight;
                                    }
                                }
                                saveState();
                                break;
                                
                            case 'fileChanged':
                                // Auto-refresh changed log
                                if (allLogs.includes(message.filename)) {
                                    vscode.postMessage({ command: 'getLogContent', session: currentSession, logName: message.filename });
                                }
                                break;
                                
                            case 'resetState':
                                // Reset all state when log directory changes
                                currentSession = '';
                                activeLog = '';
                                pinnedLogs = [];
                                allLogs = [];
                                logContents = {};
                                logFilters = {};
                                currentLogTitle.textContent = 'Select a log';
                                logContent.innerHTML = '<div class="empty-state">Select a log from the sidebar</div>';
                                updateFilterUI();
                                renderSidebar();
                                saveState();
                                break;
                                
                            case 'updateSettings':
                                // Update settings
                                if (typeof message.showLineNumbers === 'boolean') {
                                    if (message.showLineNumbers) {
                                        logContent.classList.remove('hide-line-numbers');
                                    } else {
                                        logContent.classList.add('hide-line-numbers');
                                    }
                                }
                                if (typeof message.wrapLines === 'boolean') {
                                    if (message.wrapLines) {
                                        logContent.classList.remove('no-wrap');
                                    } else {
                                        logContent.classList.add('no-wrap');
                                    }
                                }
                                if (typeof message.tailMode === 'boolean') {
                                    tailMode = message.tailMode;
                                }
                                break;
                                
                            case 'refreshAllLogs':
                                // Refresh content of all loaded logs
                                allLogs.forEach(logName => {
                                    vscode.postMessage({ command: 'getLogContent', session: currentSession, logName: logName });
                                });
                                break;
                        }
                    });

                    // Initial load
                    vscode.postMessage({ command: 'getSessions' });
                    renderSidebar();
                    if (activeLog) {
                        updateFilterUI();
                    }
                </script>
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

        if (!fs.existsSync(logDir)) {
            this._panel.webview.postMessage({ command: 'setSessions', sessions: [], hasRootLogs: false });
            return;
        }

        const entries = fs.readdirSync(logDir, { withFileTypes: true });
        
        // Check for subdirectories (sessions)
        const sessions = entries
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .sort((a, b) => b.localeCompare(a)); // Newest first (ISO8601 sorts correctly)
        
        // Check if there are log files directly in log/
        const hasRootLogs = entries.some(e => e.isFile() && this._matchesFilePattern(e.name));

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

        if (!fs.existsSync(sessionDir)) {
            this._panel.webview.postMessage({ command: 'setSessionLogs', logs: [], session });
            return;
        }

        const logs = fs.readdirSync(sessionDir)
            .filter(file => this._matchesFilePattern(file))
            .sort((a, b) => a.localeCompare(b));

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

        if (fs.existsSync(logPath)) {
            let content = fs.readFileSync(logPath, 'utf8');
            if (this._getConfig().stripAnsiCodes) {
                content = this._stripAnsiCodes(content);
            }
            this._panel.webview.postMessage({ 
                command: 'setLogContent', 
                content: content,
                logName: logName
            });
        }
    }
}
