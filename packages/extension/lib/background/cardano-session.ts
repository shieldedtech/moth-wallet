// Resolving "which Cardano account signs, with which phrase, on which network"
// — shared by the side panel's Cardano screen and the CIP-30 connector, which
// must not answer that question two different ways.

import { t } from '../i18n';
import { cardanoNetworkFor, resolveCardanoNetwork } from '@shieldedtech/moth-wallet/cardano/network';
import type { CardanoNetworkConfig } from '@shieldedtech/moth-wallet/cardano/network';
import { getSession, type Session } from './session';
import { getSettings } from './settings';
import { offscreen } from './offscreen-client';

export interface CardanoContext {
  readonly session: Session;
  readonly config: CardanoNetworkConfig;
  readonly mnemonic: string;
  readonly accountIndex: number;
  readonly account: { id: string; label: string; kind: 'derived' | 'imported' };
}

/**
 * The active Cardano account and the key that signs for it.
 *
 * `needsBlockfrost` separates the calls that only derive (an address) from the
 * ones that read or write the chain. Demanding a project id for the former
 * would hide the address behind a setting you need the address to complete.
 */
export async function requireCardano(needsBlockfrost: boolean): Promise<CardanoContext> {
  const session = await getSession();
  if (!session) throw new Error(t('cardano_errorLocked'));
  const settings = await getSettings();
  const { accounts, activeId } = await offscreen.cardanoAccountList({
    network: session.network,
    walletName: session.walletName,
  });
  const account = accounts.find((a) => a.id === activeId) ?? accounts[0]!;

  // Which phrase signs for this account, and at which CIP-1852 index. A derived
  // account needs the wallet's own phrase — which a hex-seed account does not
  // have — while an imported one carries its own.
  let mnemonic: string | undefined;
  if (account.kind === 'imported') {
    mnemonic = session.cardanoImported?.[account.id];
    if (!mnemonic) throw new Error(t('cardano_errorImportedLocked'));
  } else {
    mnemonic = session.cardanoMnemonic;
    if (!mnemonic) throw new Error(t('cardano_errorNoMnemonic'));
  }

  const cardanoNetworkName = cardanoNetworkFor(session.network) ?? '';
  const projectId =
    settings.blockfrostProjectIds[cardanoNetworkName] ?? settings.blockfrostProjectId ?? undefined;
  if (needsBlockfrost && !projectId) throw new Error(t('cardano_errorNoBlockfrostKey'));

  // The Cardano network is derived from the Midnight one and cannot be set
  // independently — a mismatched pair registers on a chain the other side
  // never reads, and says nothing for twelve hours.
  const config = resolveCardanoNetwork(session.network, {
    ...(settings.blockfrostUrl ? { blockfrostUrl: settings.blockfrostUrl } : {}),
    ...(projectId ? { blockfrostProjectId: projectId } : {}),
    ...(settings.cnightPolicyId ? { cnightPolicyId: settings.cnightPolicyId } : {}),
    ...(settings.cnightAssetName !== null ? { cnightAssetName: settings.cnightAssetName } : {}),
  });

  return { session, config, mnemonic, accountIndex: account.accountIndex, account };
}
