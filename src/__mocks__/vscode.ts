const vscode = {
    window: {
        createWebviewPanel: jest.fn(() => ({
            webview: {
                html: '',
                onDidReceiveMessage: jest.fn(),
                postMessage: jest.fn(),
                asWebviewUri: jest.fn((uri) => uri),
                cspSource: 'self'
            },
            onDidDispose: jest.fn(),
            dispose: jest.fn(),
            reveal: jest.fn(),
            title: ''
        })),
        activeTextEditor: undefined,
        showErrorMessage: jest.fn()
    },
    Uri: {
        file: jest.fn((f) => ({ fsPath: f, scheme: 'file' })),
        parse: jest.fn((u) => ({ fsPath: u, scheme: 'file' })),
        joinPath: jest.fn((...args) => ({ fsPath: args.join('/'), scheme: 'file' }))
    },
    ViewColumn: {
        One: 1
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key) => {
                if (key === 'logDirectory') return 'log';
                if (key === 'autoRefresh') return true;
                if (key === 'showLineNumbers') return true;
                if (key === 'filePattern') return '*.log';
                return undefined;
            })
        })),
        workspaceFolders: [{ uri: { fsPath: '/root' } }],
        onDidChangeConfiguration: jest.fn()
    },
    commands: {
        registerCommand: jest.fn()
    },
    Disposable: {
        from: jest.fn()
    }
};

module.exports = vscode;
