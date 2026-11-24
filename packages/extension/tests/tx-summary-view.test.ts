import { describe, expect, it } from 'vitest';
import { contractActionRows, txSummaryRows } from '../lib/ui/tx-summary-view';
import { TESTNET_NATIVE_ASSET_LABELS, MAINNET_NATIVE_ASSET_LABELS } from '../lib/ui/token-labels';
import type { TxSummaryDTO } from '../lib/offscreen/messaging';

const NIGHT = '0'.repeat(64);
const TOKEN = 'd'.repeat(64);

const empty: TxSummaryDTO = {
  spends: [],
  receives: [],
  contractActions: 0,
  contractCalls: 0,
  contractDeploys: 0,
  maintenanceUpdates: 0,
};

describe('txSummaryRows', () => {
  it('shows a NIGHT deficit as a payment in NIGHT units with the network label', () => {
    const rows = txSummaryRows(
      { ...empty, spends: [{ kind: 'unshielded', tokenId: NIGHT, amount: '1500000' }] },
      TESTNET_NATIVE_ASSET_LABELS,
    );
    expect(rows).toEqual([{ direction: 'pay', icon: 'night', amount: '1.5', symbol: 'tNIGHT', detail: null }]);
  });

  it('uses the mainnet label on mainnet', () => {
    const rows = txSummaryRows(
      { ...empty, spends: [{ kind: 'unshielded', tokenId: NIGHT, amount: '1000000' }] },
      MAINNET_NATIVE_ASSET_LABELS,
    );
    expect(rows[0]).toMatchObject({ amount: '1', symbol: 'NIGHT' });
  });

  it('lists spends before change, and keeps direction on each row', () => {
    const rows = txSummaryRows(
      {
        ...empty,
        spends: [{ kind: 'shielded', tokenId: TOKEN, amount: '7' }],
        receives: [{ kind: 'unshielded', tokenId: NIGHT, amount: '2000000' }],
        contractActions: 1,
        contractCalls: 1,
      },
      TESTNET_NATIVE_ASSET_LABELS,
    );
    expect(rows.map((r) => r.direction)).toEqual(['pay', 'receive']);
    expect(rows[0]).toMatchObject({ icon: 'shielded', amount: '7', symbol: 'dddddddd…' });
    expect(rows[1]).toMatchObject({ icon: 'night', amount: '2', symbol: 'tNIGHT' });
  });

  it('treats non-NIGHT tokens as whole units, never dividing by a million', () => {
    const rows = txSummaryRows(
      { ...empty, spends: [{ kind: 'unshielded', tokenId: TOKEN, amount: '1234567' }] },
      TESTNET_NATIVE_ASSET_LABELS,
    );
    expect(rows[0]).toMatchObject({ icon: 'unshielded', amount: '1,234,567' });
  });

  it('prefers the user-assigned token name and keeps the id as detail', () => {
    const rows = txSummaryRows(
      { ...empty, spends: [{ kind: 'shielded', tokenId: TOKEN, amount: '3' }] },
      TESTNET_NATIVE_ASSET_LABELS,
      { [TOKEN]: 'Loyalty points' },
    );
    expect(rows[0]).toMatchObject({ symbol: 'Loyalty points', detail: 'dddddddd…' });
  });

  it('renders DUST in its own denomination, not NIGHT decimals', () => {
    const rows = txSummaryRows(
      { ...empty, spends: [{ kind: 'dust', tokenId: '', amount: String(10n ** 15n / 2n) }] },
      TESTNET_NATIVE_ASSET_LABELS,
    );
    expect(rows[0]).toMatchObject({ icon: 'dust', amount: '0.5', symbol: 'tDUST' });
  });

  it('returns no rows for a balanced transaction', () => {
    expect(txSummaryRows(empty, TESTNET_NATIVE_ASSET_LABELS)).toEqual([]);
  });
});

describe('contractActionRows', () => {
  it('names a deploy as a deploy, so it cannot pass for a call', () => {
    expect(contractActionRows({ ...empty, contractActions: 1, contractDeploys: 1 })).toEqual([
      { label: 'Contract deploys', value: '1' },
    ]);
  });

  it('lists each kind present, deploys first, and nothing for kinds that are absent', () => {
    expect(
      contractActionRows({ ...empty, contractActions: 4, contractDeploys: 1, contractCalls: 2, maintenanceUpdates: 1 }),
    ).toEqual([
      { label: 'Contract deploys', value: '1' },
      { label: 'Contract calls', value: '2' },
      { label: 'Contract maintenance updates', value: '1' },
    ]);
    expect(contractActionRows({ ...empty, contractActions: 1, contractCalls: 1 })).toEqual([
      { label: 'Contract calls', value: '1' },
    ]);
  });

  it('adds no rows for a transfer or a prompt without a summary', () => {
    expect(contractActionRows(empty)).toEqual([]);
    expect(contractActionRows(undefined)).toEqual([]);
  });
});
