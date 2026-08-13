import { useState, useCallback } from 'react';
import type { LogEntry } from '../types.js';
import { appendLog, readLogTail, clearLog as clearLogFile } from '../persistent-log.js';

const MAX_IN_MEMORY = 500;

export function useLogs() {
  // Load persisted entries on startup
  const [entries, setEntries] = useState<LogEntry[]>(() => {
    const lines = readLogTail(MAX_IN_MEMORY);
    return lines.map(line => {
      const match = line.match(/^(\S+)\s+\[(\w+)\s*\]\s+(.*)$/);
      if (match) {
        return {
          timestamp: match[1],
          level: match[2].toLowerCase() as LogEntry['level'],
          message: match[3],
        };
      }
      return { timestamp: new Date().toISOString(), level: 'info' as const, message: line };
    });
  });

  const log = useCallback((level: LogEntry['level'], message: string) => {
    // Persist to disk (with 1MB rotation)
    appendLog(level, message);

    // Update in-memory state
    setEntries(prev => {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
      };
      const next = [...prev, entry];
      return next.length > MAX_IN_MEMORY ? next.slice(-MAX_IN_MEMORY) : next;
    });
  }, []);

  const info = useCallback((msg: string) => log('info', msg), [log]);
  const warn = useCallback((msg: string) => log('warn', msg), [log]);
  const error = useCallback((msg: string) => log('error', msg), [log]);
  const debug = useCallback((msg: string) => log('debug', msg), [log]);

  const clear = useCallback(() => {
    clearLogFile();
    setEntries([]);
  }, []);

  return { entries, info, warn, error, debug, clear, count: entries.length };
}
