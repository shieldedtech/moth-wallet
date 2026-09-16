// The warm-wallet capacity is a memory knob, so the resolution rules matter:
// off unless asked for, env beats the settings file, and anything nonsensical
// resolves to off rather than to something unbounded.

import { describe, expect, it } from 'vitest';
import { resolveWarmWallets } from '../../src/settings.js';

describe('resolveWarmWallets', () => {
  it('is off by default', () => {
    expect(resolveWarmWallets({ warmWallets: 0 }, {})).toBe(0);
  });

  it('reads the settings value', () => {
    expect(resolveWarmWallets({ warmWallets: 2 }, {})).toBe(2);
  });

  it('lets the environment override the settings file', () => {
    expect(resolveWarmWallets({ warmWallets: 3 }, { MOTH_WARM_WALLETS: '1' })).toBe(1);
    expect(resolveWarmWallets({ warmWallets: 3 }, { MOTH_WARM_WALLETS: '0' })).toBe(0);
  });

  it('ignores an empty or unparseable env value', () => {
    expect(resolveWarmWallets({ warmWallets: 2 }, { MOTH_WARM_WALLETS: '' })).toBe(2);
    expect(resolveWarmWallets({ warmWallets: 2 }, { MOTH_WARM_WALLETS: 'yes' })).toBe(2);
  });

  it('resolves nonsense to off rather than to unbounded', () => {
    expect(resolveWarmWallets({ warmWallets: -1 }, {})).toBe(0);
    expect(resolveWarmWallets({ warmWallets: Number.NaN }, {})).toBe(0);
    expect(resolveWarmWallets({ warmWallets: undefined as unknown as number }, {})).toBe(0);
  });

  it('caps the value and takes whole wallets only', () => {
    expect(resolveWarmWallets({ warmWallets: 99 }, {})).toBe(5);
    expect(resolveWarmWallets({ warmWallets: 2.7 }, {})).toBe(2);
  });
});
