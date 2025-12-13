import { LogDataProvider } from './LogDataProvider';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    readdirSync: jest.fn(),
    statSync: jest.fn(),
    readFileSync: jest.fn()
}));

describe('LogDataProvider', () => {
    let provider: LogDataProvider;
    const mockLogDir = '/logs';
    const mockFilePattern = '*.log';

    beforeEach(() => {
        provider = new LogDataProvider();
        jest.clearAllMocks();
    });

    describe('getSessions', () => {
        test('should return empty sessions if log directory does not exist', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);
            
            const result = provider.getSessions(mockLogDir, mockFilePattern);
            
            expect(result).toEqual({ sessions: [], hasRootLogs: false });
        });

        test('should return sessions and root logs status', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readdirSync as jest.Mock).mockReturnValue([
                { name: 'session1', isDirectory: () => true, isFile: () => false },
                { name: 'session2', isDirectory: () => true, isFile: () => false },
                { name: 'root.log', isDirectory: () => false, isFile: () => true },
                { name: 'other.txt', isDirectory: () => false, isFile: () => true }
            ]);

            const result = provider.getSessions(mockLogDir, mockFilePattern);

            expect(result.sessions).toEqual(['session2', 'session1']); // Sorted newest first (descending)
            expect(result.hasRootLogs).toBe(true);
        });

        test('should handle errors gracefully', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readdirSync as jest.Mock).mockImplementation(() => {
                throw new Error('Access denied');
            });

            const result = provider.getSessions(mockLogDir, mockFilePattern);

            expect(result).toEqual({ sessions: [], hasRootLogs: false });
        });
    });

    describe('getLogs', () => {
        test('should return empty list if session directory does not exist', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);
            
            const result = provider.getLogs(mockLogDir, mockFilePattern);
            
            expect(result).toEqual([]);
        });

        test('should return sorted log files matching pattern', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readdirSync as jest.Mock).mockReturnValue(['b.log', 'a.log', 'c.txt']);
            (fs.statSync as jest.Mock).mockReturnValue({ isFile: () => true });

            const result = provider.getLogs(mockLogDir, mockFilePattern);

            expect(result).toEqual(['a.log', 'b.log']);
        });

        test('should filter out directories', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readdirSync as jest.Mock).mockReturnValue(['a.log', 'subdir']);
            (fs.statSync as jest.Mock).mockImplementation((path) => ({
                isFile: () => !path.includes('subdir')
            }));

            const result = provider.getLogs(mockLogDir, mockFilePattern);

            expect(result).toEqual(['a.log']);
        });

        test('should handle stat errors gracefully during filtering', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readdirSync as jest.Mock).mockReturnValue(['a.log', 'error.log']);
            (fs.statSync as jest.Mock).mockImplementation((filePath) => {
                if (filePath.includes('error.log')) {
                    throw new Error('Access denied');
                }
                return { isFile: () => true };
            });

            const result = provider.getLogs(mockLogDir, mockFilePattern);

            expect(result).toEqual(['a.log']);
        });

        test('should handle readdir errors gracefully', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readdirSync as jest.Mock).mockImplementation(() => {
                throw new Error('Access denied');
            });

            const result = provider.getLogs(mockLogDir, mockFilePattern);

            expect(result).toEqual([]);
        });
    });

    describe('getLogContent', () => {
        test('should return null if file does not exist', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);
            
            const result = provider.getLogContent('test.log', false);
            
            expect(result).toBeNull();
        });

        test('should return content unchanged if stripAnsi is false', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readFileSync as jest.Mock).mockReturnValue('content');
            
            const result = provider.getLogContent('test.log', false);
            
            expect(result).toBe('content');
        });

        test('should strip ansi codes if stripAnsi is true', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readFileSync as jest.Mock).mockReturnValue('\x1B[31mError\x1B[0m');
            
            const result = provider.getLogContent('test.log', true);
            
            expect(result).toBe('Error');
        });

        test('should handle read errors gracefully', () => {
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readFileSync as jest.Mock).mockImplementation(() => {
                throw new Error('Read error');
            });
            
            const result = provider.getLogContent('test.log', false);
            
            expect(result).toBeNull();
        });
    });
});
