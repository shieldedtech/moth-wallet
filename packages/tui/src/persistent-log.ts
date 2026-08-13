import { appendFileSync, statSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.moth');
const LOG_FILE = join(LOG_DIR, 'moth.log');
const MAX_SIZE = 1_048_576; // 1 MB

function ensureDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size >= MAX_SIZE) {
      // Keep the last half of the file
      const content = readFileSync(LOG_FILE, 'utf-8');
      const lines = content.split('\n');
      const halfIndex = Math.floor(lines.length / 2);
      writeFileSync(LOG_FILE, lines.slice(halfIndex).join('\n'));
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
  appendFileSync(LOG_FILE, line);
}

export function readLogTail(lines = 200): string[] {
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const allLines = content.split('\n').filter(l => l.length > 0);
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

export function clearLog(): void {
  try {
    writeFileSync(LOG_FILE, '');
  } catch {
    // Ignore
  }
}

export function getLogPath(): string {
  return LOG_FILE;
}
