import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

// The real module pulls the wallet SDK in; only the sender is under test here.
vi.mock('../../../src/sync/operations.js', () => ({
  sendTokensWithKeys: (...args: unknown[]) => send(...args),
}));
vi.mock('../../../src/sync/wallet-sync.js', () => ({
  NIGHT_TOKEN_ID: '0'.repeat(64),
}));

const { batchExitCode, executeBatchTransfer, loadBatchFile } = await import(
  '../../../src/wallet/batch-transfer.js'
);

const TO = 'mn_shield-addr_test1abcdef';
const keys = {} as never;

function batchFile(entries: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'moth-batch-'));
  const path = join(dir, 'batch.json');
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue('0xtxhash');
});

describe('executeBatchTransfer amounts', () => {
  it('converts decimal NIGHT to exact base units', async () => {
    const summary = await executeBatchTransfer({}, keys, 'preprod', [
      { to: TO, amount: '1' },
      { to: TO, amount: '1.5' },
      { to: TO, amount: '0.000001' },
    ]);

    expect(summary.succeeded).toBe(3);
    expect(send.mock.calls.map(c => (c[3] as {amount: bigint}[])[0].amount)).toEqual([
      1_000_000n,
      1_500_000n,
      1n,
    ]);
  });

  // #66 — every one of these was ACCEPTED by the parseFloat version, as a
  // different amount than the file asked for. The first two moved money: "1,5"
  // sent a third of the intended value, and "0.0000001" submitted a transfer of
  // nothing that still paid a fee.
  it.each([
    ['1,5', 'a comma decimal, normal across most of Europe, sent 1 NIGHT'],
    ['0.0000001', 'rounded to zero base units and was sent as a no-op transfer'],
    ['1e3', 'scientific notation sent 1000 NIGHT'],
    ['1abc', 'trailing text was discarded and 1 NIGHT was sent'],
    ['1.2345678', 'a seventh decimal place was silently rounded away'],
    ['0', 'zero moves nothing and still pays a fee'],
    ['-1', 'negative'],
    ['', 'empty'],
    ['1.', 'trailing separator'],
    ['.5', 'no whole part'],
  ])('refuses %j and submits nothing', async (amount) => {
    const summary = await executeBatchTransfer({}, keys, 'preprod', [{ to: TO, amount }]);

    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.results[0].status).toBe('error');
    expect(summary.results[0].error).toContain('Invalid amount');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps going after a bad entry, and reports which one it was', async () => {
    const summary = await executeBatchTransfer({}, keys, 'preprod', [
      { to: TO, amount: '1' },
      { to: TO, amount: '1,5' },
      { to: TO, amount: '2' },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.results[1].index).toBe(1);
    expect(summary.results[1].amount).toBe('1,5');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('honours the shielded flag per entry', async () => {
    await executeBatchTransfer({}, keys, 'preprod', [
      { to: TO, amount: '1' },
      { to: TO, amount: '1', shielded: true },
    ]);

    expect(send.mock.calls.map(c => (c[3] as {type: string}[])[0].type)).toEqual([
      'unshielded',
      'shielded',
    ]);
  });

  it('records a sender failure as an error result rather than throwing', async () => {
    send.mockRejectedValueOnce(new Error('Transaction submission error'));
    const summary = await executeBatchTransfer({}, keys, 'preprod', [{ to: TO, amount: '1' }]);

    expect(summary.failed).toBe(1);
    expect(summary.results[0].error).toContain('Transaction submission error');
  });
});

describe('batchExitCode', () => {
  const summary = (succeeded: number, failed: number) =>
    ({ total: succeeded + failed, succeeded, failed, results: [] });

  // #67 — these two were the wrong way round: all-failed returned 1 and partial
  // returned 2. A caller treating 2 as "nothing was submitted, re-send the file"
  // would re-send a batch whose successful entries were already on chain.
  it('is 0 when everything succeeded', () => {
    expect(batchExitCode(summary(3, 0))).toBe(0);
  });

  it('is 1 when some entries failed', () => {
    expect(batchExitCode(summary(2, 1))).toBe(1);
  });

  it('is 2 when every entry failed', () => {
    expect(batchExitCode(summary(0, 3))).toBe(2);
  });
});

describe('loadBatchFile', () => {
  it('accepts a well-formed file', () => {
    expect(loadBatchFile(batchFile([{ to: TO, amount: '1.5' }]))).toEqual([
      { to: TO, amount: '1.5' },
    ]);
  });

  // Amount syntax is checkable before any money moves, so a file with a typo on
  // entry 3 is refused whole rather than after two transfers have gone out.
  it('refuses the whole file for a malformed amount, naming the entry', () => {
    const path = batchFile([
      { to: TO, amount: '1' },
      { to: TO, amount: '2' },
      { to: TO, amount: '3,5' },
    ]);
    expect(() => loadBatchFile(path)).toThrow(/Entry 2/);
    expect(() => loadBatchFile(path)).toThrow(/Invalid amount/);
  });

  it('still refuses missing fields', () => {
    expect(() => loadBatchFile(batchFile([{ amount: '1' }]))).toThrow(/"to" address/);
    expect(() => loadBatchFile(batchFile([{ to: TO }]))).toThrow(/"amount"/);
    expect(() => loadBatchFile(batchFile({ to: TO, amount: '1' }))).toThrow(/JSON array/);
  });
});
