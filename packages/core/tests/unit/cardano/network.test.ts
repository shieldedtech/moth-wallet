import { describe, expect, it } from 'vitest';
import {
  CARDANO_NETWORKS,
  CardanoNetworkUnavailableError,
  cardanoNetworkFor,
  cnightUnit,
  explorerTxUrl,
  resolveCardanoNetwork,
} from '../../../src/cardano/network.js';

describe('cardanoNetworkFor', () => {
  it('pairs each Midnight network with the Cardano network of the same name', () => {
    expect(cardanoNetworkFor('mainnet')).toBe('Mainnet');
    expect(cardanoNetworkFor('preprod')).toBe('Preprod');
    expect(cardanoNetworkFor('preview')).toBe('Preview');
  });

  it('has no counterpart for networks Cardano does not mirror', () => {
    // Previously these fell back to Preview, which is how cNIGHT ended up
    // registered on Cardano Preview against a Midnight preprod wallet: valid
    // on Cardano, invisible to Midnight, no feedback for twelve hours.
    for (const id of ['devnet', 'qanet', 'undeployed', 'something-new']) {
      expect(cardanoNetworkFor(id), id).toBeNull();
    }
  });
});

describe('resolveCardanoNetwork', () => {
  it('follows the Midnight network', () => {
    expect(resolveCardanoNetwork('preprod').network).toBe('Preprod');
    expect(resolveCardanoNetwork('preview').network).toBe('Preview');
  });

  it('refuses a Midnight network with no Cardano counterpart', () => {
    // The alternative is silently resolving to some testnet and letting the
    // user register against a chain nothing will read.
    expect(() => resolveCardanoNetwork('devnet')).toThrow(CardanoNetworkUnavailableError);
    expect(() => resolveCardanoNetwork('undeployed')).toThrow(/no Cardano network paired/);
  });

  it('uses Cardano network ids, not Midnight ones', () => {
    expect(resolveCardanoNetwork('mainnet').networkId).toBe(1);
    expect(resolveCardanoNetwork('preprod').networkId).toBe(0);
    expect(resolveCardanoNetwork('preview').networkId).toBe(0);
  });

  it('has no way to ask for a mismatched pair', () => {
    // The override does not exist: a Cardano network cannot be requested
    // independently of the Midnight one. This is the guard, stated as a test.
    const overrideKeys = Object.keys(
      resolveCardanoNetwork('preprod') as unknown as Record<string, unknown>,
    );
    expect(overrideKeys).toContain('network');
    expect(resolveCardanoNetwork('preprod').network).toBe('Preprod');
  });

  it('applies token overrides so a redeploy needs no release', () => {
    const policyId = 'a'.repeat(56);
    const config = resolveCardanoNetwork('preview', {
      cnightPolicyId: policyId,
      cnightAssetName: 'deadbeef',
    });
    expect(cnightUnit(config)).toBe(`${policyId}deadbeef`);
  });

  it('treats an empty asset name as a real value, not as unset', () => {
    // The testnet cNIGHT token genuinely has no asset name, so its unit is the
    // bare policy id — an override of '' has to survive.
    const config = resolveCardanoNetwork('mainnet', { cnightAssetName: '' });
    expect(config.cnightAssetName).toBe('');
    expect(cnightUnit(config)).toBe(config.cnightPolicyId);
  });

  it('rejects a policy id that is not 28 bytes of hex', () => {
    expect(() => resolveCardanoNetwork('preview', { cnightPolicyId: 'nothex' })).toThrow(/hex/);
    expect(() => resolveCardanoNetwork('preview', { cnightPolicyId: 'ab' })).toThrow(/28 bytes/);
  });

  it('rejects an odd-length asset name', () => {
    expect(() => resolveCardanoNetwork('preview', { cnightAssetName: 'abc' })).toThrow(/even number/);
  });

  it('rejects a Blockfrost URL that is not http(s) — CWE-918', () => {
    expect(() => resolveCardanoNetwork('preview', { blockfrostUrl: 'file:///etc/passwd' })).toThrow();
  });

  it('omits the project id entirely rather than storing an empty one', () => {
    expect(resolveCardanoNetwork('preview').blockfrostProjectId).toBeUndefined();
    expect(resolveCardanoNetwork('preview', { blockfrostProjectId: '' }).blockfrostProjectId)
      .toBeUndefined();
  });
});

describe('explorer links', () => {
  it('points at the explorer for the resolved network', () => {
    expect(explorerTxUrl(resolveCardanoNetwork('preview'), 'abc')).toBe(
      'https://preview.cexplorer.io/tx/abc',
    );
    expect(explorerTxUrl(resolveCardanoNetwork('mainnet'), 'abc')).toBe(
      'https://cexplorer.io/tx/abc',
    );
  });
});
