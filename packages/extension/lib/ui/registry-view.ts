// How a held shielded token is labelled on Home, given what the token registry
// (if configured) and the user's own names say about it. Pure and WASM-free —
// the registry entries arrive already verified from the offscreen document
// (see lib/offscreen/wallet-host.ts tokenRegistryResolve).
//
// Tickers are not unique and names are user-generated, so every registry label
// carries the colour's short hash and its verification level. An unverified
// entry shows only its ticker (no name) and raw units. Images are never shown.

import type { RegistryToken } from '../messaging/protocol';
import { t } from '../i18n';
import { shortTokenId, tokenDisplayName } from './token-labels';

export { shortTokenId };

export interface ShieldedRowView {
  /** Headline: the user's own name, else the registry ticker, else the short id. */
  name: string;
  sub: string;
  /** Base-unit exponent for formatTokenBalance. */
  decimals: number;
  level: RegistryToken['level'] | null;
}

export function shieldedRowView(
  id: string,
  registry: Record<string, RegistryToken>,
  tokenNames: Record<string, string>,
): ShieldedRowView {
  const custom = tokenNames[id];
  const short = shortTokenId(id);
  const entry = registry[id];
  if (!entry) {
    return {
      name: tokenDisplayName(id, tokenNames),
      sub: custom ? t('home_shieldedTokenWithId', [short]) : t('home_shieldedToken'),
      decimals: 0,
      level: null,
    };
  }
  const label = entry.name ?? entry.ticker;
  const sub =
    entry.level === 'chain-verified'
      ? t('home_registryChainVerified', [label, short])
      : entry.level === 'colour-verified'
        ? t('home_registryColourVerified', [label, short])
        : t('home_registryUnverified', [short]);
  return { name: custom ?? entry.ticker, sub, decimals: entry.decimals, level: entry.level };
}
