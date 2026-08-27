// Transaction-input resolution for the MCP tools that accept a
// serialized transaction (balance_transaction, submit_transaction).
// Callers pass the transaction inline as hex (txHex) or as a path to a
// file on the machine running `moth mcp` (txFile) — serialized
// transactions with proofs run to hundreds of KB, too large to shuttle
// through an agent's context as a tool argument.
//
// A transaction file may hold either hex text (whitespace and an
// optional 0x prefix tolerated — the shape a dApp endpoint or
// balance_transaction's finalizedHex output produces) or the raw
// transaction bytes.

import {readFile, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

/** Serialized transactions are well under this even with proofs; a
 *  larger file is a wrong path, not a transaction. */
export const MAX_TX_FILE_BYTES = 16 * 1024 * 1024;

const HEX_RE = /^([0-9a-fA-F]{2})+$/;

/**
 * Interpret the content of a transaction file. Printable-ASCII content
 * must be valid hex (never silently hex-encode text garbage — the
 * daemon's deserialize probe would then fail with a misleading stage
 * error); anything with non-printable bytes is treated as the raw
 * transaction and hex-encoded. Pure — unit-tested directly.
 */
export function parseTxFileContent(buf: Buffer): {hex: string} | {error: string} {
  if (buf.length === 0) return {error: 'the transaction file is empty'};
  let isText = true;
  for (const byte of buf) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue; // tab/LF/CR
    if (byte < 0x20 || byte > 0x7e) {
      isText = false;
      break;
    }
  }
  if (!isText) return {hex: buf.toString('hex')};
  let text = buf.toString('utf8').replace(/\s+/g, '');
  if (text.startsWith('0x') || text.startsWith('0X')) text = text.slice(2);
  if (text.length === 0) return {error: 'the transaction file is empty'};
  if (text.length % 2 !== 0) {
    return {error: 'the transaction file holds hex text with an odd number of hex digits'};
  }
  if (!HEX_RE.test(text)) {
    return {error: 'the transaction file holds text that is not valid hex (expected hex text or raw transaction bytes)'};
  }
  return {hex: text.toLowerCase()};
}

/**
 * Resolve the transaction input of a tool call to hex: exactly one of
 * txHex / txFile must be given. txFile is read from the filesystem of
 * the machine running the server (`~/` expands to the server user's
 * home). Never throws — filesystem failures come back as {error}.
 */
export async function resolveTxInput(input: {
  txHex?: string;
  txFile?: string;
}): Promise<{hex: string} | {error: string}> {
  const hasHex = input.txHex !== undefined;
  const hasFile = input.txFile !== undefined;
  if (hasHex === hasFile) {
    return {error: 'provide exactly one of txHex or txFile'};
  }
  if (hasHex) return {hex: input.txHex!};

  const raw = input.txFile!.trim();
  if (raw.length === 0) return {error: 'txFile must not be empty'};
  const path = resolve(
    raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw,
  );
  let size: number;
  try {
    const st = await stat(path);
    if (st.isDirectory()) return {error: `txFile is a directory: ${path}`};
    size = st.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {error: `txFile not found: ${path} (the path is read on the machine running the moth mcp server)`};
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {error: `cannot read txFile ${path}: ${msg}`};
  }
  if (size > MAX_TX_FILE_BYTES) {
    return {
      error: `txFile ${path} is ${size} bytes — larger than any serialized transaction (limit ${MAX_TX_FILE_BYTES})`,
    };
  }
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {error: `cannot read txFile ${path}: ${msg}`};
  }
  return parseTxFileContent(buf);
}
