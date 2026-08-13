import type { WalletErrorCategory } from '@shieldedtech/moth-wallet';

export type OutputFormat = 'text' | 'json';

/**
 * Strip ANSI escape sequences and terminal control characters from a string.
 * Prevents malicious/misconfigured remote endpoints from injecting terminal commands.
 * CWE-117 mitigation.
 */
function sanitizeTerminal(str: string): string {
  // Strip ANSI CSI sequences (ESC[...X), OSC sequences (ESC]...ST), and raw control chars
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // Control chars (keep \t \n \r)
}

export function formatOutput(data: unknown, format: OutputFormat): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }
  // Text mode: sanitize terminal control characters from all output
  return sanitizeTerminal(formatText(data));
}

function formatText(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);

  if (Array.isArray(data)) {
    if (data.length === 0) return '(empty)';
    // Table format for arrays of objects
    if (typeof data[0] === 'object' && data[0] !== null) {
      return formatTable(data as Record<string, unknown>[]);
    }
    return data.map(String).join('\n');
  }

  if (typeof data === 'object') {
    return formatKeyValue(data as Record<string, unknown>);
  }

  return String(data);
}

function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length)),
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const separator = widths.map(w => '-'.repeat(w)).join('  ');
  const body = rows.map(row =>
    keys.map((k, i) => String(row[k] ?? '').padEnd(widths[i])).join('  '),
  );

  return [header, separator, ...body].join('\n');
}

function formatKeyValue(obj: Record<string, unknown>): string {
  const maxKeyLen = Math.max(...Object.keys(obj).map(k => k.length));
  return Object.entries(obj)
    .map(([key, value]) => `${key.padEnd(maxKeyLen)}  ${String(value)}`)
    .join('\n');
}

export function formatError(
  category: WalletErrorCategory,
  message: string,
  format: OutputFormat,
  hint?: string,
): string {
  if (format === 'json') {
    return JSON.stringify({
      error: { category, message, code: 1 },
    });
  }

  let output = `Error [${category}]: ${sanitizeTerminal(message)}`;
  if (hint) output += `\n  Hint: ${sanitizeTerminal(hint)}`;
  return output;
}
