import { appendFileSync, statSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mothHome } from '@shieldedtech/moth-wallet';

// Resolved per call, like the rest of moth's on-disk state, so MOTH_HOME applies.
const logDir = (): string => mothHome();
const logFile = (): string => join(logDir(), 'moth.log');
const MAX_SIZE = 1_048_576; // 1 MB

function ensureDir(): void {
  if (!existsSync(logDir())) {
    mkdirSync(logDir(), { recursive: true });
  }
}

function rotateIfNeeded(): void {
  try {
    const stat = statSync(logFile());
    if (stat.size >= MAX_SIZE) {
      // Keep the last half of the file
      const content = readFileSync(logFile(), 'utf-8');
      const lines = content.split('\n');
      const halfIndex = Math.floor(lines.length / 2);
      writeFileSync(logFile(), lines.slice(halfIndex).join('\n'));
    }
  } catch {
    // File doesn't exist yet — fine
  }
}

export function appendLog(level: string, message: string): void {
  ensureDir();
  rotateIfNeeded();
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${message}\n`;
  appendFileSync(logFile(), line);
}

export function readLogTail(lines = 200): string[] {
  try {
    const content = readFileSync(logFile(), 'utf-8');
    const allLines = content.split('\n').filter(l => l.length > 0);
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

export function clearLog(): void {
  try {
    writeFileSync(logFile(), '');
  } catch {
    // Ignore
  }
}

export function getLogPath(): string {
  return logFile();
}
