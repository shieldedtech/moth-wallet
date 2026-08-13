import { readFile } from 'node:fs/promises';
import { InvalidInputError } from '../types/errors.js';

// Matches a JSON string value representing a hex-encoded byte string, e.g. "0x1a2b3c...".
// Used to let circuit/constructor arguments express Compact `Bytes<N>` values in JSON.
const HEX_BYTES_PATTERN = /^0x[0-9a-fA-F]+$/;

// Matches a JSON string value representing a bigint literal, e.g. "5000000n" or "-1n".
// Used to let circuit/constructor arguments express Compact `Uint<..>`/`Field` values in JSON.
// JSON has no native integer-vs-bigint distinction (JSON.parse always produces `number` for
// numeric literals), but the compact-runtime JS boundary requires an exact `bigint` for these
// parameter types — passing a `number` (even one that looks like the right value) is a type
// error at proving time, not merely a range check. A bare JSON number (e.g. `5000000`) is left
// as a JS `number`, preserving existing behavior; only a quoted string with a trailing "n"
// (mirroring the JS bigint-literal suffix) is converted to `bigint`.
const BIGINT_PATTERN = /^-?\d+n$/;

/**
 * Parse circuit or constructor arguments from a string.
 * Supports:
 * - Inline JSON: '{"amount": 100}' or '[100, "0x1a2b..."]'
 * - File reference: '@path/to/args.json' (prefix with @)
 *
 * Bytes<N> convention: any JSON string matching /^0x[0-9a-fA-F]+$/ is converted to a
 * `Uint8Array` of the decoded bytes (e.g. "0x00112233" -> Uint8Array[0x00,0x11,0x22,0x33]).
 * This applies recursively to strings found anywhere in the parsed structure (object
 * values, array elements, nested objects). Strings that don't match the pattern —
 * including plain "0x" with no digits — are left untouched as ordinary strings.
 *
 * Uint/Field bigint convention: any JSON string matching /^-?\d+n$/ (e.g. "5000000n") is
 * converted to a `bigint` (e.g. 5000000n). This is required for any numeric constructor or
 * circuit argument whose Compact type is `Uint<..>` or `Field` — the compact-runtime JS
 * boundary expects `bigint`, not `number`, for these. Plain JSON numbers (no quotes, no "n"
 * suffix) are left as JS `number` for backward compatibility.
 */
export async function parseArgs(input: string): Promise<unknown> {
  if (!input || input.trim() === '') {
    return {};
  }

  const trimmed = input.trim();

  // File reference: starts with @
  if (trimmed.startsWith('@')) {
    const filePath = trimmed.slice(1);
    try {
      const content = await readFile(filePath, 'utf-8');
      return parseJsonSafe(content, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new InvalidInputError(`Arguments file not found: ${filePath}`);
      }
      throw err;
    }
  }

  // Inline JSON
  return parseJsonSafe(trimmed, 'inline');
}

function parseJsonSafe(content: string, source: string): unknown {
  try {
    return reviveTypedValues(JSON.parse(content));
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    // SECURITY: Do not include file content in error messages (CWE-209).
    throw new InvalidInputError(
      `Invalid JSON in arguments (source: ${source}). Check syntax and try again.`,
    );
  }
}

/**
 * Recursively convert typed-string values into their richer JS representations:
 * - hex strings (/^0x[0-9a-fA-F]+$/) -> Uint8Array (Bytes<N> convention)
 * - bigint-literal strings (/^-?\d+n$/) -> bigint (Uint<..>/Field convention)
 * Other strings, and all non-string values, are left untouched.
 */
function reviveTypedValues(value: unknown): unknown {
  if (typeof value === 'string') {
    if (HEX_BYTES_PATTERN.test(value)) {
      return hexToBytes(value);
    }
    if (BIGINT_PATTERN.test(value)) {
      return BigInt(value.slice(0, -1));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(reviveTypedValues);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = reviveTypedValues(val);
    }
    return out;
  }
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  const digits = hex.slice(2);
  if (digits.length % 2 !== 0) {
    throw new InvalidInputError(
      `Invalid hex byte string "${hex}": must have an even number of hex digits.`,
    );
  }
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(digits.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Normalize a parsed `parseArgs()` result into a positional argument array, the shape
 * expected by both `submitCallTx`'s `args` and `deployContract`'s `args` (constructor
 * arguments). Mirrors the convention already used by the `call` command:
 * - `undefined` / `{}` (no args given) -> `[]`
 * - an array -> used as-is (already positional)
 * - any other single value -> wrapped in a one-element array
 */
export function toPositionalArgs(parsed: unknown): unknown[] {
  if (parsed === undefined) return [];
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 0) {
    return [];
  }
  return [parsed];
}
