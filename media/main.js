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

// Search elements
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const searchPrev = document.getElementById('search-prev');
const searchNext = document.getElementById('search-next');
const searchClose = document.getElementById('search-close');

// Quick Picker elements
const quickPickerOverlay = document.getElementById('quick-picker-overlay');
const quickPickerInput = document.getElementById('quick-picker-input');
const quickPickerList = document.getElementById('quick-picker-list');

// Help panel elements
const helpOverlay = document.getElementById('help-overlay');
const helpClose = document.getElementById('help-close');

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
let logLineCounts = {}; // Track line count per log for incremental updates

// Search state
let searchMatches = [];
let currentMatchIndex = -1;

// Quick Picker state
let pickerSelectedIndex = 0;
let pickerFilteredLogs = [];

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
    const lines = content.split('\n');
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

// Format only new lines for incremental append
function formatNewLines(content, startLineNum, inheritedSeverity) {
    const filter = getLogFilter(activeLog);
    const lines = content.split('\n');
    const searchText = filter.text.toLowerCase();
    let lastSeverityClass = inheritedSeverity || '';
    
    const filteredLines = lines.map((line, index) => {
        const lineNum = startLineNum + index;
        let severityClass = getSeverityClass(line);
        
        if (!severityClass && lastSeverityClass) {
            severityClass = lastSeverityClass;
        } else if (severityClass) {
            lastSeverityClass = severityClass;
        }
        
        if (severityClass && !filter.severities.includes(severityClass)) {
            return null;
        }
        
        if (searchText && !line.toLowerCase().includes(searchText)) {
            return null;
        }
        
        const escapedLine = escapeHtml(line);
        return '<span class="log-line ' + severityClass + '" data-line="' + lineNum + '"><span class="line-number">' + lineNum + '</span><span class="line-content">' + escapedLine + '</span></span>';
    }).filter(l => l !== null);
    
    return filteredLines.join('');
}

// Get the last severity class from displayed content
function getLastDisplayedSeverity() {
    const lastLine = logContent.querySelector('.log-line:last-child');
    if (lastLine) {
        const classes = lastLine.className.split(' ');
        for (const cls of classes) {
            if (cls.startsWith('log-')) return cls;
        }
    }
    return '';
}

// Search functions
function openSearch() {
    searchBar.classList.add('visible');
    searchInput.focus();
    searchInput.select();
}

function closeSearch() {
    searchBar.classList.remove('visible');
    clearSearchHighlights();
    searchInput.value = '';
    searchCount.textContent = '';
    searchMatches = [];
    currentMatchIndex = -1;
}

function clearSearchHighlights() {
    const highlights = logContent.querySelectorAll('.search-highlight');
    highlights.forEach(el => {
        const parent = el.parentNode;
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
    });
}

function performSearch() {
    const query = searchInput.value;
    clearSearchHighlights();
    searchMatches = [];
    currentMatchIndex = -1;

    if (!query) {
        searchCount.textContent = '';
        updateSearchNavButtons();
        return;
    }

    const lineContents = logContent.querySelectorAll('.line-content');
    const queryLower = query.toLowerCase();

    lineContents.forEach(lineEl => {
        const text = lineEl.textContent;
        const textLower = text.toLowerCase();
        let lastIndex = 0;
        let index;
        const fragments = [];
        
        while ((index = textLower.indexOf(queryLower, lastIndex)) !== -1) {
            // Add text before match
            if (index > lastIndex) {
                fragments.push(document.createTextNode(text.substring(lastIndex, index)));
            }
            // Add highlighted match
            const span = document.createElement('span');
            span.className = 'search-highlight';
            span.textContent = text.substring(index, index + query.length);
            fragments.push(span);
            searchMatches.push(span);
            lastIndex = index + query.length;
        }
        
        // Add remaining text
        if (fragments.length > 0) {
            if (lastIndex < text.length) {
                fragments.push(document.createTextNode(text.substring(lastIndex)));
            }
            lineEl.textContent = '';
            fragments.forEach(f => lineEl.appendChild(f));
        }
    });

    if (searchMatches.length > 0) {
        searchCount.textContent = searchMatches.length + ' matches';
        goToMatch(0);
    } else {
        searchCount.textContent = 'No results';
    }
    updateSearchNavButtons();
}

function goToMatch(index) {
    if (searchMatches.length === 0) return;
    
    // Remove current highlight
    if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
        searchMatches[currentMatchIndex].classList.remove('current');
    }
    
    currentMatchIndex = index;
    if (currentMatchIndex < 0) currentMatchIndex = searchMatches.length - 1;
    if (currentMatchIndex >= searchMatches.length) currentMatchIndex = 0;
    
    const match = searchMatches[currentMatchIndex];
    match.classList.add('current');
    match.scrollIntoView({ block: 'center', behavior: 'smooth' });
    
    searchCount.textContent = (currentMatchIndex + 1) + ' of ' + searchMatches.length;
    updateSearchNavButtons();
}

function goToNextMatch() {
    goToMatch(currentMatchIndex + 1);
}

function goToPrevMatch() {
    goToMatch(currentMatchIndex - 1);
}

function updateSearchNavButtons() {
    const hasMatches = searchMatches.length > 0;
    searchPrev.disabled = !hasMatches;
    searchNext.disabled = !hasMatches;
}

// Search event listeners
searchInput.addEventListener('input', () => {
    performSearch();
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
            goToPrevMatch();
        } else {
            goToNextMatch();
        }
    } else if (e.key === 'Escape') {
        closeSearch();
    }
});

searchNext.addEventListener('click', goToNextMatch);
searchPrev.addEventListener('click', goToPrevMatch);
searchClose.addEventListener('click', closeSearch);

// Quick Picker functions
function openQuickPicker() {
    pickerSelectedIndex = 0;
    quickPickerInput.value = '';
    updatePickerList();
    quickPickerOverlay.classList.add('visible');
    quickPickerInput.focus();
}

function closeQuickPicker() {
    quickPickerOverlay.classList.remove('visible');
}

function updatePickerList() {
    const query = quickPickerInput.value.toLowerCase();
    
    // Get all logs in visual order (pinned first)
    const sortedLogs = getLogsInVisualOrder();
    
    // Filter by query
    pickerFilteredLogs = query 
        ? sortedLogs.filter(log => log.toLowerCase().includes(query))
        : sortedLogs;
    
    // Clamp selected index
    if (pickerSelectedIndex >= pickerFilteredLogs.length) {
        pickerSelectedIndex = Math.max(0, pickerFilteredLogs.length - 1);
    }
    
    // Render list
    if (pickerFilteredLogs.length === 0) {
        quickPickerList.innerHTML = '<div class="quick-picker-empty">No matching logs</div>';
        return;
    }
    
    quickPickerList.innerHTML = pickerFilteredLogs.map((log, index) => {
        const isPinned = pinnedLogs.includes(log);
        const isActive = log === activeLog;
        const isSelected = index === pickerSelectedIndex;
        
        return '<div class="quick-picker-item' + (isSelected ? ' selected' : '') + '" data-index="' + index + '">' +
            (isPinned ? '<svg class="pin-icon" viewBox="0 0 16 16"><path d="M11.5 1.5L10.793 2.207L11.793 3.207L8.5 6.5L5 4.5L3.5 6L7.793 9.293L2.5 14.586V15.5H3.414L8.707 10.207L12 14.5L13.5 13L11.5 9.5L14.793 6.207L15.793 7.207L16.5 6.5L11.5 1.5Z"/></svg>' : '') +
            '<span class="log-name">' + log + '</span>' +
            (isActive ? '<span class="log-badge">active</span>' : '') +
            '</div>';
    }).join('');
    
    // Scroll selected into view
    const selectedEl = quickPickerList.querySelector('.selected');
    if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
    }
}

function pickerSelectCurrent() {
    if (pickerFilteredLogs.length > 0 && pickerSelectedIndex >= 0) {
        const log = pickerFilteredLogs[pickerSelectedIndex];
        selectLog(log);
        closeQuickPicker();
    }
}

// Quick Picker event listeners
quickPickerInput.addEventListener('input', () => {
    pickerSelectedIndex = 0;
    updatePickerList();
});

quickPickerInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        pickerSelectedIndex = Math.min(pickerSelectedIndex + 1, pickerFilteredLogs.length - 1);
        updatePickerList();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        pickerSelectedIndex = Math.max(pickerSelectedIndex - 1, 0);
        updatePickerList();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        pickerSelectCurrent();
    } else if (e.key === 'Escape') {
        closeQuickPicker();
    }
});

quickPickerList.addEventListener('click', (e) => {
    const item = e.target.closest('.quick-picker-item');
    if (item) {
        const index = parseInt(item.dataset.index);
        pickerSelectedIndex = index;
        pickerSelectCurrent();
    }
});

quickPickerOverlay.addEventListener('click', (e) => {
    if (e.target === quickPickerOverlay) {
        closeQuickPicker();
    }
});

// Help panel functions
function openHelp() {
    helpOverlay.classList.add('visible');
}

function closeHelp() {
    helpOverlay.classList.remove('visible');
}

helpClose.addEventListener('click', closeHelp);
helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) {
        closeHelp();
    }
});

// Get logs in visual order (pinned first, then rest)
function getLogsInVisualOrder() {
    const pinnedSet = new Set(pinnedLogs);
    return [
        ...pinnedLogs.filter(log => allLogs.includes(log)),
        ...allLogs.filter(log => !pinnedSet.has(log))
    ];
}

// Navigate to previous/next log
function goToPrevLog() {
    const visualLogs = getLogsInVisualOrder();
    if (visualLogs.length === 0) return;
    const currentIndex = visualLogs.indexOf(activeLog);
    const newIndex = currentIndex <= 0 ? visualLogs.length - 1 : currentIndex - 1;
    selectLog(visualLogs[newIndex]);
}

function goToNextLog() {
    const visualLogs = getLogsInVisualOrder();
    if (visualLogs.length === 0) return;
    const currentIndex = visualLogs.indexOf(activeLog);
    const newIndex = currentIndex >= visualLogs.length - 1 ? 0 : currentIndex + 1;
    selectLog(visualLogs[newIndex]);
}

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ctrl+F - Search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
        return;
    }
    
    // Ctrl+L - Focus filter bar
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        filterTextInput.focus();
        filterTextInput.select();
        return;
    }
    
    // Ctrl+P - Quick Picker
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        openQuickPicker();
        return;
    }
    
    // Alt+ArrowUp - Previous log
    if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        goToPrevLog();
        return;
    }
    
    // Alt+ArrowDown - Next log
    if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        goToNextLog();
        return;
    }
    
    // Alt+P - Toggle pin on current log
    if (e.altKey && e.key === 'p') {
        e.preventDefault();
        if (activeLog) {
            togglePin(activeLog);
        }
        return;
    }
    
    // Arrow keys and Page Up/Down for log content navigation
    const scrollAmount = 40; // pixels per arrow key
    const pageAmount = logContent.clientHeight - 50; // page scroll minus a bit for context
    
    // Skip navigation keys when focus is on an input element
    const isInputFocused = document.activeElement && 
        (document.activeElement.tagName === 'INPUT' || 
            document.activeElement.tagName === 'TEXTAREA');
    
    if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey && !isInputFocused) {
        e.preventDefault();
        logContent.scrollTop -= scrollAmount;
        return;
    }
    if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey && !isInputFocused) {
        e.preventDefault();
        logContent.scrollTop += scrollAmount;
        return;
    }
    if (e.key === 'PageUp' && !isInputFocused) {
        e.preventDefault();
        logContent.scrollTop -= pageAmount;
        return;
    }
    if (e.key === 'PageDown' && !isInputFocused) {
        e.preventDefault();
        logContent.scrollTop += pageAmount;
        return;
    }
    if (e.key === 'Home' && !e.ctrlKey && !isInputFocused) {
        e.preventDefault();
        logContent.scrollTop = 0;
        return;
    }
    if (e.key === 'End' && !e.ctrlKey && !isInputFocused) {
        e.preventDefault();
        logContent.scrollTop = logContent.scrollHeight;
        return;
    }
    
    // ? or F1 - Show help (only when not in input)
    if ((e.key === '?' || e.key === 'F1') && !isInputFocused) {
        e.preventDefault();
        openHelp();
        return;
    }
    
    // Escape - Close modals
    if (e.key === 'Escape') {
        if (helpOverlay.classList.contains('visible')) {
            closeHelp();
        } else if (quickPickerOverlay.classList.contains('visible')) {
            closeQuickPicker();
        } else if (searchBar.classList.contains('visible')) {
            closeSearch();
        }
    }
});

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getSeverityClass(line) {
    const upperLine = line.toUpperCase();
    
    // Check for pipe-delimited format first (e.g., "|INFO |" or "|ERROR|")
    const pipeMatch = upperLine.match(/\|\s*(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|INFO|DEBUG|DBG|TRACE|TRC|VERBOSE|VERB|VRB)\s*\|/);
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
    const bracketMatch = upperLine.match(/\[\s*(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|INFO|DEBUG|DBG|TRACE|TRC|VERBOSE|VERB|VRB)\s*\]/);
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
                vscode.postMessage({ command: 'getLogsForSession', session: currentSession });
            }
            break;
            
        case 'setSessionLogs':
            const previousLogs = allLogs;
            allLogs = message.logs;
            
            // Find new logs (not in previous list)
            const newLogs = allLogs.filter(log => !previousLogs.includes(log));
            
            // Remove content for logs that no longer exist
            const removedLogs = previousLogs.filter(log => !allLogs.includes(log));
            removedLogs.forEach(log => {
                delete logContents[log];
                delete logFilters[log];
                // Remove from pinned if it was pinned
                const pinIndex = pinnedLogs.indexOf(log);
                if (pinIndex > -1) {
                    pinnedLogs.splice(pinIndex, 1);
                }
            });
            
            // Request content only for new logs
            newLogs.forEach(logName => {
                vscode.postMessage({ command: 'getLogContent', session: currentSession, logName });
            });
            
            // Select first log if none selected or active log was removed
            if (allLogs.length > 0 && (!activeLog || !allLogs.includes(activeLog))) {
                selectLog(allLogs[0]);
            } else if (allLogs.length === 0) {
                activeLog = '';
                logContent.innerHTML = '<div class="empty-state">No logs in this session</div>';
            }
            
            renderSidebar();
            saveState();
            break;
            
        case 'setLogContent':
            const prevContent = logContents[message.logName] || '';
            const newContent = message.content;
            logContents[message.logName] = newContent;
            
            if (activeLog === message.logName) {
                const prevLineCount = logLineCounts[message.logName] || 0;
                const newLines = newContent.split('\n');
                const newLineCount = newLines.length;
                
                // Check if this is an append-only update (content starts with previous content)
                const isAppendOnly = prevContent && newContent.startsWith(prevContent) && newLineCount > prevLineCount;
                
                if (isAppendOnly && prevLineCount > 0) {
                    // Incremental update: only add new lines
                    const appendContent = newLines.slice(prevLineCount - 1).join('\n');
                    const inheritedSeverity = getLastDisplayedSeverity();
                    const newHtml = formatNewLines(appendContent, prevLineCount, inheritedSeverity);
                    
                    if (newHtml) {
                        // Remove the empty-state if present
                        const emptyState = logContent.querySelector('.empty-state');
                        if (emptyState) {
                            emptyState.remove();
                        }
                        
                        // Append new lines
                        logContent.insertAdjacentHTML('beforeend', newHtml);
                    }
                    
                    if (tailMode) {
                        logContent.scrollTop = logContent.scrollHeight;
                    }
                } else {
                    // Full refresh (new log, filter changed, or content was truncated)
                    const scrollTop = logContent.scrollTop;
                    logContent.innerHTML = formatLogContent(newContent);
                    
                    if (tailMode) {
                        logContent.scrollTop = logContent.scrollHeight;
                    } else {
                        logContent.scrollTop = scrollTop;
                    }
                }
                
                logLineCounts[message.logName] = newLineCount;
            }
            saveState();
            break;
            
        case 'filesChanged':
            // Auto-refresh changed logs (batch - debounced)
            if (message.filenames && Array.isArray(message.filenames)) {
                // Only refresh the active log to avoid overwhelming updates
                // Other logs will be refreshed when selected
                const changedFiles = message.filenames;
                if (activeLog && changedFiles.includes(activeLog)) {
                    vscode.postMessage({ command: 'getLogContent', session: currentSession, logName: activeLog });
                }
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
            
        case 'refreshCurrentSession':
            // Refresh the logs list for current session (detects new files)
            if (currentSession) {
                vscode.postMessage({ command: 'getLogsForSession', session: currentSession });
            }
            break;
    }
});

// Initial load
vscode.postMessage({ command: 'getSessions' });
renderSidebar();
if (activeLog) {
    updateFilterUI();
}

// Focus main area for keyboard shortcuts
document.getElementById('main-area').focus();
