// Coverage for the hex-or-file transaction input shared by the MCP's
// balance_transaction and submit_transaction tools: content detection
// (hex text vs raw binary), the exactly-one-of rule, and friendly
// filesystem errors — a tool call must never surface a raw ENOENT or a
// silently hex-encoded garbage file.

import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {MAX_TX_FILE_BYTES, parseTxFileContent, resolveTxInput} from '../../src/mcp/tx-input.js';

const HEX = 'deadbeef0102';

function expectHex(result: {hex: string} | {error: string}): string {
  expect(result).not.toHaveProperty('error');
  return (result as {hex: string}).hex;
}

function expectError(result: {hex: string} | {error: string}): string {
  expect(result).toHaveProperty('error');
  return (result as {error: string}).error;
}

describe('parseTxFileContent', () => {
  it('accepts plain hex text', () => {
    expect(expectHex(parseTxFileContent(Buffer.from(HEX)))).toBe(HEX);
  });

  it('lowercases and tolerates whitespace, newlines, and a 0x prefix', () => {
    const content = ` 0xDEAD\nBEEF\t01 02\r\n`;
    expect(expectHex(parseTxFileContent(Buffer.from(content)))).toBe(HEX);
  });

  it('treats content with non-printable bytes as raw transaction bytes', () => {
    const raw = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x0a, 0x41]);
    expect(expectHex(parseTxFileContent(raw))).toBe(raw.toString('hex'));
  });

  it('rejects printable text that is not hex instead of hex-encoding it', () => {
    expect(expectError(parseTxFileContent(Buffer.from('zzzzzzzz')))).toContain('not valid hex');
  });

  it('rejects hex text with an odd digit count', () => {
    expect(expectError(parseTxFileContent(Buffer.from('abc')))).toContain('odd number');
  });

  it('rejects an empty file, including one that is only whitespace or a bare 0x', () => {
    expect(expectError(parseTxFileContent(Buffer.alloc(0)))).toContain('empty');
    expect(expectError(parseTxFileContent(Buffer.from('  \n\t')))).toContain('empty');
    expect(expectError(parseTxFileContent(Buffer.from('0x')))).toContain('empty');
  });
});

describe('resolveTxInput', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'moth-mcp-tx-'));
  });

  afterAll(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('requires exactly one of txHex / txFile', async () => {
    expect(expectError(await resolveTxInput({}))).toContain('exactly one');
    expect(expectError(await resolveTxInput({txHex: HEX, txFile: 'x'}))).toContain('exactly one');
  });

  it('passes txHex through untouched', async () => {
    expect(expectHex(await resolveTxInput({txHex: HEX}))).toBe(HEX);
  });

  it('reads a hex-text file', async () => {
    const path = join(dir, 'tx.hex');
    await writeFile(path, `${HEX}\n`);
    expect(expectHex(await resolveTxInput({txFile: path}))).toBe(HEX);
  });

  it('reads a raw-binary file', async () => {
    const raw = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    const path = join(dir, 'tx.bin');
    await writeFile(path, raw);
    expect(expectHex(await resolveTxInput({txFile: path}))).toBe(raw.toString('hex'));
  });

  it('reports a missing file as a friendly error naming the server host', async () => {
    const err = expectError(await resolveTxInput({txFile: join(dir, 'nope.hex')}));
    expect(err).toContain('not found');
    expect(err).toContain('machine running the moth mcp server');
  });

  it('rejects a directory path', async () => {
    expect(expectError(await resolveTxInput({txFile: dir}))).toContain('directory');
  });

  it('rejects an empty txFile path', async () => {
    expect(expectError(await resolveTxInput({txFile: '   '}))).toContain('must not be empty');
  });

  it('rejects a file larger than the size cap without reading it', async () => {
    const path = join(dir, 'huge.bin');
    // Sparse-ish: a single write of cap+1 bytes is fine at 16MiB.
    await writeFile(path, Buffer.alloc(MAX_TX_FILE_BYTES + 1));
    const err = expectError(await resolveTxInput({txFile: path}));
    expect(err).toContain('larger than any serialized transaction');
  });
});
