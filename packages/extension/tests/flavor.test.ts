import { describe, it, expect } from 'vitest';
import { flavorOf, flavored } from '../lib/flavor';

describe('build flavor', () => {
  it('unset keeps the regular identity', () => {
    expect(flavored(flavorOf(undefined))).toEqual({
      walletId: 'moth',
      rdns: 'io.shielded.moth',
      name: 'Moth Wallet',
      requestEvent: '__moth_connector_request__',
    });
  });

  it('a flavor changes every page-visible identifier, so two builds never collide', () => {
    const base = flavored('');
    const g = flavored(flavorOf(' Gloam '));
    expect(g).toEqual({
      walletId: 'mothGloam',
      rdns: 'io.shielded.moth.gloam',
      name: 'Moth Wallet (Gloam)',
      requestEvent: '__moth_gloam_connector_request__',
    });
    for (const k of Object.keys(base) as (keyof typeof base)[]) expect(g[k]).not.toBe(base[k]);
  });

  it('rejects flavors that are not a short lowercase word', () => {
    for (const bad of ['1x', 'a-b', 'a b', 'x'.repeat(17)]) expect(() => flavorOf(bad)).toThrow(/invalid/);
  });
});
