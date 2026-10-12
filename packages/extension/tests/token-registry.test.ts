import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { DEFAULT_NETWORKS, type NetworkConfig } from '@shieldedtech/moth-wallet/types/network';
import type { ExtensionSettings, RegistryToken } from '../lib/messaging/protocol';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../lib/background/settings';
import { tokenRegistryGet, type TokenRegistryDeps } from '../lib/background/token-registry';
import { shieldedRowView } from '../lib/ui/registry-view';
import { sendableTokens } from '../lib/ui/token-list';
import { nativeAssetLabelsForNetwork } from '../lib/ui/token-labels';
import { formatTokenBalance } from '../lib/ui/format';

const GLOW = '227df138951ebd0a632ea5bf0f4c1ae64bf6e3771549562410b2204369e67b24';
const QUOTE = '25af894fbe86fa5d65af67c93b2f3fede7484bb0d1d2faeced5fb96b2422c588';
const FORGED = 'f'.repeat(64);
const UNKNOWN = 'a'.repeat(64);

const registry: Record<string, RegistryToken> = {
  [GLOW]: { color: GLOW, kind: 'launch', ticker: 'GLOW', name: 'Glow Worm', decimals: 6, level: 'colour-verified' },
  [QUOTE]: { color: QUOTE, kind: 'quote', ticker: 'sNIGHT', name: 'Shielded NIGHT', decimals: 0, level: 'chain-verified' },
  [FORGED]: { color: FORGED, kind: 'launch', ticker: 'GLOW', decimals: 0, level: 'unverified', reason: 'colour does not derive from (launch, contract)' },
};

describe('token registry settings', () => {
  beforeEach(() => fakeBrowser.reset());

  it('is off by default', async () => {
    expect(DEFAULT_SETTINGS.tokenRegistryUrl).toBeNull();
    expect(DEFAULT_SETTINGS.tokenRegistryBuckets).toBe(false);
    expect((await getSettings()).tokenRegistryUrl).toBeNull();
  });

  it('stores a valid http(s) URL without trailing slash and rejects others', async () => {
    await updateSettings({ tokenRegistryUrl: 'http://localhost:8790/' });
    expect((await getSettings()).tokenRegistryUrl).toBe('http://localhost:8790');
    await updateSettings({ tokenRegistryUrl: 'javascript:alert(1)' });
    expect((await getSettings()).tokenRegistryUrl).toBeNull();
  });
});

describe('tokenRegistryGet (background)', () => {
  const network = DEFAULT_NETWORKS.undeployed as NetworkConfig;
  const deps = (settings: Partial<ExtensionSettings>, resolve = vi.fn<TokenRegistryDeps['resolve']>(async () => registry)) => ({
    resolve,
    deps: {
      getSettings: async () => ({ ...DEFAULT_SETTINGS, ...settings }),
      getNetworkConfig: async () => network,
      resolve,
    } satisfies TokenRegistryDeps,
  });

  it('does nothing when no registry is configured', async () => {
    const { resolve, deps: d } = deps({});
    expect(await tokenRegistryGet([GLOW], d)).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
  });

  it('forwards only valid, deduplicated colours with the bucket option', async () => {
    const { resolve, deps: d } = deps({ tokenRegistryUrl: 'http://localhost:8790', tokenRegistryBuckets: true });
    await tokenRegistryGet([GLOW, GLOW.toUpperCase(), 'not-a-colour', QUOTE], d);
    expect(resolve).toHaveBeenCalledWith({ network, baseUrl: 'http://localhost:8790', useBuckets: true, colors: [GLOW, QUOTE] });
  });

  it('swallows registry failures', async () => {
    const { deps: d } = deps({ tokenRegistryUrl: 'http://localhost:8790' }, vi.fn(async () => { throw new Error('503'); }));
    expect(await tokenRegistryGet([GLOW], d)).toEqual({});
  });
});

describe('shielded row view', () => {
  it('shows ticker, name, short colour and level for a verified entry', () => {
    expect(shieldedRowView(GLOW, registry, {})).toEqual({
      name: 'GLOW',
      sub: 'Glow Worm · 227df138… · Colour verified',
      decimals: 6,
      level: 'colour-verified',
    });
    expect(shieldedRowView(QUOTE, registry, {}).sub).toBe('Shielded NIGHT · 25af894f… · Verified on chain');
  });

  it('flags an unverified entry and keeps raw units', () => {
    expect(shieldedRowView(FORGED, registry, {})).toEqual({
      name: 'GLOW',
      sub: 'ffffffff… · Unverified registry entry',
      decimals: 0,
      level: 'unverified',
    });
  });

  it('falls back to the truncated id without a registry entry, and honours user names', () => {
    expect(shieldedRowView(UNKNOWN, registry, {})).toMatchObject({ name: 'aaaaaaaa…', decimals: 0, level: null });
    expect(shieldedRowView(GLOW, registry, { [GLOW]: 'My glow' }).name).toBe('My glow');
  });

  it('formats balances with the registry decimals', () => {
    expect(formatTokenBalance(1_234_500n, shieldedRowView(GLOW, registry, {}).decimals)).toBe('1.2345');
    expect(formatTokenBalance(42n, shieldedRowView(QUOTE, registry, {}).decimals)).toBe('42');
    expect(formatTokenBalance(1_234_500n, shieldedRowView(FORGED, registry, {}).decimals)).toBe('1,234,500');
  });
});

describe('sendableTokens with registry', () => {
  it('uses the ticker and decimals for shielded registry tokens', () => {
    const balances = { shielded: { [GLOW]: 5_000_000n, [UNKNOWN]: 7n }, unshielded: {} } as unknown as WalletBalances;
    const tokens = sendableTokens(balances, nativeAssetLabelsForNetwork('undeployed'), {}, registry);
    expect(tokens.find((t) => t.id === GLOW)).toMatchObject({ symbol: 'GLOW', decimals: 6, name: '227df138… · Shielded token' });
    expect(tokens.find((t) => t.id === UNKNOWN)).toMatchObject({ symbol: 'aaaaaaaa…', decimals: 0 });
  });
});
