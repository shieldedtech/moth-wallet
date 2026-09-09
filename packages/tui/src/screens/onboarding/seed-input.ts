// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0
//
// Validation for the onboarding seed field, kept out of the screen so it can be
// tested without rendering ink.
//
// The hex arm delegates to core's `checkHexSeed` rather than matching a length
// itself. The old local `/^[0-9a-fA-F]{64}$/` refused every seed the SDK accepts
// bar one length — including the 128-character seed a phrase-backed wallet
// exports, which the CLI and the extension both take. It also ran *before*
// `importFromSeed`, so core's validation never got the chance to speak.
//
// A hex seed has no checksum, so an unusual-but-derivable length is reported as
// a warning and not a refusal: a truncated paste and a wallet genuinely created
// at that length are indistinguishable here, and refusing would lock the latter
// out. See `core/src/wallet/hex-seed.ts`.

import { checkHexSeed, describeHexSeedProblem, validateMnemonic } from '@shieldedtech/moth-wallet';
import type { SeedSource } from '../../navigation/index.js';

export interface SeedInputCheck {
  /** False only for input that cannot be imported at all. */
  readonly ok: boolean;
  /** The normalised value to hand to the importer, when `ok`. */
  readonly value?: string;
  /** Why the input was refused. Set whenever `ok` is false. */
  readonly error?: string;
  /** Advisory shown alongside an accepted value; never blocks submission. */
  readonly warning?: string;
}

/** Standing note for the hex field: the only warning a seed can ever give. */
export const HEX_SEED_NO_CHECKSUM_NOTE =
  'A seed has no built-in check, unlike a recovery phrase. One wrong character imports a different, empty wallet and reports no error — compare it against your backup.';

export function checkSeedInput(source: SeedSource | undefined, raw: string): SeedInputCheck {
  const trimmed = raw.trim();

  if (source === 'mnemonic') {
    const normalized = trimmed.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!validateMnemonic(normalized)) {
      return { ok: false, error: 'Invalid mnemonic. Must be 24 valid BIP-39 words (space or comma separated).' };
    }
    return { ok: true, value: normalized };
  }

  if (source === 'hex') {
    const check = checkHexSeed(trimmed);
    if (!check.ok) {
      return { ok: false, error: describeHexSeedProblem(check.problem!, check.bytes) };
    }
    return {
      ok: true,
      value: trimmed.toLowerCase(),
      warning: check.unusualLength
        ? `This seed is ${check.bytes} bytes. Tools produce 32 or 64, so check the paste is complete — an incomplete seed imports a different wallet.`
        : undefined,
    };
  }

  return { ok: false, error: `Unexpected seed source: ${String(source)}` };
}
