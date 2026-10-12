import { describe, it, expect } from 'vitest';
import { flavorLabelOf, flavorOf, flavored, flavoredOutDir } from '../lib/flavor';

describe('build flavor', () => {
  it('unset keeps the regular identity', () => {
    expect(flavored(flavorOf(undefined))).toEqual({
      walletId: 'moth',
      cardanoId: 'moth',
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
      cardanoId: 'mothGloam',
      rdns: 'io.shielded.moth.gloam',
      name: 'Moth Wallet (Gloam)',
      requestEvent: '__moth_gloam_connector_request__',
    });
    for (const k of Object.keys(base) as (keyof typeof base)[]) expect(g[k]).not.toBe(base[k]);
  });

  it('rejects flavors that are not a short lowercase word', () => {
    for (const bad of ['1x', 'a-b', 'a b', 'x'.repeat(17)]) expect(() => flavorOf(bad)).toThrow(/invalid/);
  });

  it('puts a flavored CIP-30 provider beside the regular one under window.cardano', () => {
    // A Gloam build installed next to a regular Moth must not shadow its Cardano
    // wallet: the injected script defines window.cardano.<cardanoId> non-configurably.
    expect(flavored('').cardanoId).toBe('moth');
    expect(flavored(flavorOf('gloam')).cardanoId).toBe('mothGloam');
    expect(flavored(flavorOf('gloam')).name).toBe('Moth Wallet (Gloam)');
  });

  it('gives a flavored build its own output directory, fixed or default', () => {
    expect(flavoredOutDir(undefined, '')).toBe('.output');
    expect(flavoredOutDir(undefined, 'gloam')).toBe('.output-gloam');
    expect(flavoredOutDir('', 'gloam')).toBe('.output-gloam');
    expect(flavoredOutDir('/tmp/moth-ext', '')).toBe('/tmp/moth-ext');
    expect(flavoredOutDir('/tmp/moth-ext/', 'gloam')).toBe('/tmp/moth-ext-gloam');
  });
});

describe('flavor display label', () => {
  it('renames only the display name; ids, rdns and events keep the flavor id', () => {
    const f = flavored('gloam', 'Glowworm');
    expect(f.name).toBe('Moth Wallet (Glowworm)');
    expect(f.walletId).toBe('mothGloam');
    expect(f.cardanoId).toBe('mothGloam');
    expect(f.rdns).toBe('io.shielded.moth.gloam');
    expect(f.requestEvent).toBe('__moth_gloam_connector_request__');
    expect(flavored('gloam').name).toBe('Moth Wallet (Gloam)');
  });
  it('validates the label', () => {
    expect(flavorLabelOf(undefined)).toBeUndefined();
    expect(flavorLabelOf(' Glowworm ')).toBe('Glowworm');
    expect(() => flavorLabelOf('<script>')).toThrow(/WXT_MOTH_FLAVOR_LABEL/);
  });
});

