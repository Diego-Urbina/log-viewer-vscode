/**
 * Utility functions for log processing
 * These are pure functions that can be easily unit tested
 */

/**
 * Remove ANSI escape codes (colors, formatting, cursor control, etc.) from text
 */
export function stripAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Check if a filename matches a glob-like file pattern
 * Supports multiple patterns separated by comma
 * Supports * (any characters) and ? (single character) wildcards
 */
export function matchesFilePattern(filename: string, patterns: string): boolean {
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

/**
 * Severity levels for log lines
 */
export type SeverityClass = 'log-error' | 'log-warn' | 'log-info' | 'log-debug' | 'log-trace' | 'log-verbose' | '';

/**
 * Determine the severity class of a log line based on common log patterns
 * Supports:
 * - Pipe-delimited format: |INFO |, |ERROR|
 * - Bracket format: [INFO], [ERROR]
 */
export function getSeverityClass(line: string): SeverityClass {
    const upperLine = line.toUpperCase();
    
    // Check for pipe-delimited format first (e.g., "|INFO |" or "|ERROR|")
    const pipeMatch = upperLine.match(/\|\s*(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|INFO|DEBUG|DBG|TRACE|TRC|VERBOSE|VERB|VRB)\s*\|/);
    if (pipeMatch) {
        return mapLevelToClass(pipeMatch[1]);
    }
    
    // Check for bracket format (e.g., "[INFO]", "[ERROR]")
    const bracketMatch = upperLine.match(/\[\s*(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|INFO|DEBUG|DBG|TRACE|TRC|VERBOSE|VERB|VRB)\s*\]/);
    if (bracketMatch) {
        return mapLevelToClass(bracketMatch[1]);
    }
    
    return '';
}

/**
 * Map a log level string to a CSS class
 */
function mapLevelToClass(level: string): SeverityClass {
    if (/ERROR|ERR|FATAL|CRITICAL|EXCEPTION/.test(level)) {
        return 'log-error';
    }
    if (/WARN|WARNING/.test(level)) {
        return 'log-warn';
    }
    if (level === 'INFO') {
        return 'log-info';
    }
    if (/DEBUG|DBG/.test(level)) {
        return 'log-debug';
    }
    if (/TRACE|TRC/.test(level)) {
        return 'log-trace';
    }
    if (/VERBOSE|VERB|VRB/.test(level)) {
        return 'log-verbose';
    }
    return '';
}

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(text: string): string {
    const htmlEntities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, char => htmlEntities[char]);
}
