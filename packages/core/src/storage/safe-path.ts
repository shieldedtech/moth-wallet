import { resolve, relative, normalize } from 'node:path';

/**
 * Validate that a path segment is safe to join with a base directory.
 * Rejects: absolute paths, .., empty segments, path separators.
 * CWE-22 / CWE-73 mitigation.
 */
export function validatePathSegment(segment: string): void {
  if (!segment || segment.trim() === '') {
    throw new Error('Path segment cannot be empty');
  }
  if (segment.includes('..')) {
    throw new Error(`Path segment contains traversal: ${segment}`);
  }
  if (segment.startsWith('/') || segment.startsWith('\\')) {
    throw new Error(`Path segment is absolute: ${segment}`);
  }
  if (/[/\\]/.test(segment) && segment.includes('..')) {
    throw new Error(`Path segment contains traversal: ${segment}`);
  }
}

/**
 * Resolve a path relative to a base directory and verify containment.
 * Returns the resolved absolute path.
 * Throws if the resolved path escapes the base directory.
 */
export function safePath(baseDir: string, key: string): string {
  const absBase = resolve(baseDir);
  const absPath = resolve(absBase, normalize(key));
  const rel = relative(absBase, absPath);

  if (rel.startsWith('..') || resolve(absPath) !== absPath) {
    throw new Error(`Path escapes base directory: ${key}`);
  }

  return absPath;
}
