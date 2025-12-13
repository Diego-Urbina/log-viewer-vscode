import * as fs from 'fs';
import * as path from 'path';
import { stripAnsiCodes, matchesFilePattern } from './utils';

export interface SessionInfo {
    sessions: string[];
    hasRootLogs: boolean;
}

export class LogDataProvider {
    
    /**
     * Get list of sessions (subdirectories) and check for root logs
     */
    public getSessions(logDir: string, filePattern: string): SessionInfo {
        if (!fs.existsSync(logDir)) {
            return { sessions: [], hasRootLogs: false };
        }

        try {
            const entries = fs.readdirSync(logDir, { withFileTypes: true });
            
            // Check for subdirectories (sessions)
            const sessions = entries
                .filter(e => e.isDirectory())
                .map(e => e.name)
                .sort((a, b) => b.localeCompare(a)); // Newest first
            
            // Check if there are log files directly in log/
            const hasRootLogs = entries.some(e => 
                e.isFile() && matchesFilePattern(e.name, filePattern)
            );

            return { sessions, hasRootLogs };
        } catch (error) {
            console.error(`Error reading sessions from ${logDir}:`, error);
            return { sessions: [], hasRootLogs: false };
        }
    }

    /**
     * Get list of log files in a session directory
     */
    public getLogs(sessionDir: string, filePattern: string): string[] {
        if (!fs.existsSync(sessionDir)) {
            return [];
        }

        try {
            return fs.readdirSync(sessionDir)
                .filter(file => {
                    const filePath = path.join(sessionDir, file);
                    // Ensure it's a file and matches pattern
                    try {
                        return fs.statSync(filePath).isFile() && matchesFilePattern(file, filePattern);
                    } catch {
                        return false;
                    }
                })
                .sort((a, b) => a.localeCompare(b));
        } catch (error) {
            console.error(`Error reading logs from ${sessionDir}:`, error);
            return [];
        }
    }

    /**
     * Read content of a log file
     */
    public getLogContent(filePath: string, stripAnsi: boolean): string | null {
        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            let content = fs.readFileSync(filePath, 'utf8');
            if (stripAnsi) {
                content = stripAnsiCodes(content);
            }
            return content;
        } catch (error) {
            console.error(`Error reading log file ${filePath}:`, error);
            return null;
        }
    }
}
