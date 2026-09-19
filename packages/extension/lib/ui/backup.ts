// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import type { WalletInfo } from '@shieldedtech/moth-browser';

/**
 * Whether this account has no recovery phrase, and so cannot be offered one.
 *
 * An account restored from a hex seed has none and never will: BIP-39's
 * phrase-to-seed step is a one-way KDF, so a phrase cannot be worked back out.
 * Reveal offered the phrase option for every account and then answered with the
 * seed for these, which read as the selection being ignored.
 *
 * `backupKind` is absent on accounts written before it was recorded. Unknown is
 * NOT treated as seed-only: greying out a phrase that does exist is worse than
 * asking for the password and letting the revealed value explain itself, which
 * is what happened before. Unlock backfills the field, so an account the user
 * actually opens stops being unknown after one unlock.
 *
 * Kept out of the component because the dialog body renders through a Radix
 * portal, which `renderToStaticMarkup` does not reach — this repo's component
 * tests cannot assert on it, so the decision lives somewhere they can.
 */
export function hasNoRecoveryPhrase(wallet: Pick<WalletInfo, 'backupKind'>): boolean {
  return wallet.backupKind === 'seed';
}
