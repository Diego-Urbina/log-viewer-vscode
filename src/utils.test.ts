import {
    stripAnsiCodes,
    matchesFilePattern,
    getSeverityClass,
    escapeHtml
} from './utils';

describe('stripAnsiCodes', () => {
    it('should return plain text unchanged', () => {
        expect(stripAnsiCodes('Hello World')).toBe('Hello World');
    });

    it('should remove color codes', () => {
        // Red text
        expect(stripAnsiCodes('\x1B[31mError\x1B[0m')).toBe('Error');
        // Green text
        expect(stripAnsiCodes('\x1B[32mSuccess\x1B[0m')).toBe('Success');
    });

    it('should remove bold and formatting codes', () => {
        expect(stripAnsiCodes('\x1B[1mBold\x1B[0m')).toBe('Bold');
        expect(stripAnsiCodes('\x1B[4mUnderline\x1B[0m')).toBe('Underline');
    });

    it('should remove complex ANSI sequences', () => {
        // 256-color mode
        expect(stripAnsiCodes('\x1B[38;5;196mRed\x1B[0m')).toBe('Red');
        // RGB color mode
        expect(stripAnsiCodes('\x1B[38;2;255;0;0mRed\x1B[0m')).toBe('Red');
    });

    it('should handle multiple ANSI codes in one string', () => {
        const input = '\x1B[31mError:\x1B[0m \x1B[33mWarning\x1B[0m message';
        expect(stripAnsiCodes(input)).toBe('Error: Warning message');
    });

    it('should handle empty string', () => {
        expect(stripAnsiCodes('')).toBe('');
    });
});

describe('matchesFilePattern', () => {
    describe('single pattern', () => {
        it('should match *.log pattern', () => {
            expect(matchesFilePattern('app.log', '*.log')).toBe(true);
            expect(matchesFilePattern('error.log', '*.log')).toBe(true);
        });

        it('should not match non-matching extensions', () => {
            expect(matchesFilePattern('app.txt', '*.log')).toBe(false);
            expect(matchesFilePattern('app.log.bak', '*.log')).toBe(false);
        });

        it('should be case-insensitive', () => {
            expect(matchesFilePattern('APP.LOG', '*.log')).toBe(true);
            expect(matchesFilePattern('app.LOG', '*.log')).toBe(true);
        });

        it('should match exact filename', () => {
            expect(matchesFilePattern('debug.log', 'debug.log')).toBe(true);
            expect(matchesFilePattern('error.log', 'debug.log')).toBe(false);
        });

        it('should support ? wildcard for single character', () => {
            expect(matchesFilePattern('app1.log', 'app?.log')).toBe(true);
            expect(matchesFilePattern('app2.log', 'app?.log')).toBe(true);
            expect(matchesFilePattern('app12.log', 'app?.log')).toBe(false);
        });
    });

    describe('multiple patterns', () => {
        it('should match any pattern separated by comma', () => {
            const patterns = '*.log, *.txt';
            expect(matchesFilePattern('app.log', patterns)).toBe(true);
            expect(matchesFilePattern('readme.txt', patterns)).toBe(true);
            expect(matchesFilePattern('app.json', patterns)).toBe(false);
        });

        it('should handle patterns with extra spaces', () => {
            const patterns = '  *.log  ,  *.txt  ';
            expect(matchesFilePattern('app.log', patterns)).toBe(true);
            expect(matchesFilePattern('readme.txt', patterns)).toBe(true);
        });

        it('should ignore empty patterns', () => {
            const patterns = '*.log,, *.txt, ';
            expect(matchesFilePattern('app.log', patterns)).toBe(true);
            expect(matchesFilePattern('readme.txt', patterns)).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('should return false for empty pattern', () => {
            expect(matchesFilePattern('app.log', '')).toBe(false);
        });

        it('should handle filenames with special regex characters', () => {
            expect(matchesFilePattern('app.2024.log', '*.log')).toBe(true);
        });
    });
});

describe('getSeverityClass', () => {
    describe('bracket format [LEVEL]', () => {
        it('should detect ERROR level', () => {
            expect(getSeverityClass('[ERROR] Something failed')).toBe('log-error');
            expect(getSeverityClass('[ERR] Something failed')).toBe('log-error');
            expect(getSeverityClass('[FATAL] Critical failure')).toBe('log-error');
            expect(getSeverityClass('[CRITICAL] System down')).toBe('log-error');
            expect(getSeverityClass('[EXCEPTION] Uncaught error')).toBe('log-error');
        });

        it('should detect WARN level', () => {
            expect(getSeverityClass('[WARN] Disk space low')).toBe('log-warn');
            expect(getSeverityClass('[WARNING] Memory usage high')).toBe('log-warn');
        });

        it('should detect INFO level', () => {
            expect(getSeverityClass('[INFO] Server started')).toBe('log-info');
        });

        it('should detect DEBUG level', () => {
            expect(getSeverityClass('[DEBUG] Variable value: 42')).toBe('log-debug');
            expect(getSeverityClass('[DBG] Entering function')).toBe('log-debug');
        });

        it('should detect TRACE level', () => {
            expect(getSeverityClass('[TRACE] Call stack entry')).toBe('log-trace');
            expect(getSeverityClass('[TRC] Detailed trace')).toBe('log-trace');
        });

        it('should detect VERBOSE level', () => {
            expect(getSeverityClass('[VERBOSE] Detailed info')).toBe('log-verbose');
            expect(getSeverityClass('[VERB] Very detailed')).toBe('log-verbose');
            expect(getSeverityClass('[VRB] Verbose output')).toBe('log-verbose');
        });

        it('should handle spaces inside brackets', () => {
            expect(getSeverityClass('[ ERROR ] Something failed')).toBe('log-error');
            expect(getSeverityClass('[  INFO  ] Message')).toBe('log-info');
        });

        it('should be case-insensitive', () => {
            expect(getSeverityClass('[error] lowercase')).toBe('log-error');
            expect(getSeverityClass('[Error] mixed case')).toBe('log-error');
            expect(getSeverityClass('[INFO] uppercase')).toBe('log-info');
        });
    });

    describe('pipe format |LEVEL|', () => {
        it('should detect ERROR level', () => {
            expect(getSeverityClass('2024-01-01|ERROR|message')).toBe('log-error');
            expect(getSeverityClass('timestamp |ERR| message')).toBe('log-error');
        });

        it('should detect INFO level', () => {
            expect(getSeverityClass('2024-01-01|INFO |message')).toBe('log-info');
            expect(getSeverityClass('2024-01-01| INFO|message')).toBe('log-info');
        });

        it('should detect all severity levels', () => {
            expect(getSeverityClass('|WARN|')).toBe('log-warn');
            expect(getSeverityClass('|DEBUG|')).toBe('log-debug');
            expect(getSeverityClass('|TRACE|')).toBe('log-trace');
            expect(getSeverityClass('|VERBOSE|')).toBe('log-verbose');
        });
    });

    describe('key-value format level=LEVEL', () => {
        it('should detect ERROR level', () => {
            expect(getSeverityClass('time=... level=ERROR msg=...')).toBe('log-error');
            expect(getSeverityClass('level=ERR msg=...')).toBe('log-error');
        });

        it('should detect INFO level', () => {
            expect(getSeverityClass('time=... level=INFO msg=...')).toBe('log-info');
        });

        it('should detect DEBUG level', () => {
            expect(getSeverityClass('time=... level=DEBUG msg=...')).toBe('log-debug');
        });
        
        it('should detect WARN level', () => {
            expect(getSeverityClass('time=... level=WARN msg=...')).toBe('log-warn');
        });
    });

    describe('no severity', () => {
        it('should return empty string for plain text', () => {
            expect(getSeverityClass('Just a regular line')).toBe('');
            expect(getSeverityClass('')).toBe('');
        });

        it('should not match level keywords without brackets or pipes', () => {
            expect(getSeverityClass('ERROR occurred')).toBe('');
            expect(getSeverityClass('This is an INFO message')).toBe('');
        });

        it('should not match partial brackets', () => {
            expect(getSeverityClass('[ERROR without closing')).toBe('');
            expect(getSeverityClass('ERROR] without opening')).toBe('');
        });
    });
});

describe('escapeHtml', () => {
    it('should escape ampersand', () => {
        expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('should escape less than and greater than', () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    it('should escape quotes', () => {
        expect(escapeHtml('"Hello"')).toBe('&quot;Hello&quot;');
        expect(escapeHtml("'World'")).toBe('&#39;World&#39;');
    });

    it('should handle multiple special characters', () => {
        expect(escapeHtml('<a href="test">Link & Text</a>')).toBe('&lt;a href=&quot;test&quot;&gt;Link &amp; Text&lt;/a&gt;');
    });

    it('should return plain text unchanged', () => {
        expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
    });

    it('should handle empty string', () => {
        expect(escapeHtml('')).toBe('');
    });
});
