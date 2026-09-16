// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0
//
// Validation for hex seeds supplied by a user.
//
// A hex seed has no checksum. That is the whole reason this file exists. A
// 24-word phrase carries a BIP-39 checksum, so one wrong word is *detected*:
// `validateMnemonic` returns false and the import is refused. Change one
// character of a hex seed and nothing is detected — the seed still derives, to
// a different, perfectly valid, empty wallet. Truncate a paste and the same is
// true, because the SDK accepts a wide range of lengths and each one is a
// different wallet.
//
// So the only errors catchable here are shape errors, and they are worth
// catching precisely because they are all we get.

import {WalletError} from '../types/errors.js';

/**
 * Seed sizes the wallet SDK's `HDWallet.fromSeed` accepts. Outside this range
 * it returns a non-`seedOk` result and `deriveRawKeys` throws 'Invalid seed'.
 * Measured against `@midnight-ntwrk/wallet-sdk-hd` by sweeping 8..72 bytes:
 * 16..64 inclusive derive, everything either side is refused.
 */
export const MIN_SEED_BYTES = 16;
export const MAX_SEED_BYTES = 64;

/**
 * The two sizes real tooling actually emits:
 *
 * - **32 bytes / 64 hex chars** — what the Midnight node toolkit and
 *   `moth wallet import --seed-hex` deal in.
 * - **64 bytes / 128 hex chars** — the BIP-39 seed a 24-word phrase expands to
 *   via PBKDF2, and what `exportSeedHex` returns for a phrase-backed wallet.
 *
 * Anything else in the accepted range derives a *different* wallet, so a length
 * that is neither is far likelier a truncated paste than a deliberate choice.
 * Worth a warning; not worth a refusal, since we cannot prove intent.
 */
export const CANONICAL_SEED_BYTES: readonly number[] = [32, 64];

export type HexSeedProblem = 'empty' | 'not-hex' | 'odd-length' | 'too-short' | 'too-long';

export interface HexSeedCheck {
  readonly ok: boolean;
  readonly problem?: HexSeedProblem;
  /** Byte length, when the string is well-formed hex of even length. */
  readonly bytes?: number;
  /**
   * Set when the seed derives but its length is not one any tool produces.
   * The caller should warn and carry on — refusing would lock out a wallet
   * that genuinely was created at that length.
   */
  readonly unusualLength?: boolean;
}

/** Shape-check a user-supplied hex seed. Never throws; see `assertHexSeed`. */
export function checkHexSeed(hex: string): HexSeedCheck {
  const trimmed = hex.trim();
  if (trimmed.length === 0) return {ok: false, problem: 'empty'};
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return {ok: false, problem: 'not-hex'};
  if (trimmed.length % 2 !== 0) return {ok: false, problem: 'odd-length'};

  const bytes = trimmed.length / 2;
  if (bytes < MIN_SEED_BYTES) return {ok: false, problem: 'too-short', bytes};
  if (bytes > MAX_SEED_BYTES) return {ok: false, problem: 'too-long', bytes};

  return {ok: true, bytes, unusualLength: !CANONICAL_SEED_BYTES.includes(bytes)};
}

const HEX_RANGE = `${MIN_SEED_BYTES * 2}–${MAX_SEED_BYTES * 2}`;

/** Human-readable reason a seed was refused, for UI and CLI alike. */
export function describeHexSeedProblem(problem: HexSeedProblem, bytes?: number): string {
  switch (problem) {
    case 'empty':
      return 'No seed provided.';
    case 'not-hex':
      return 'Seed must be hexadecimal — digits 0-9 and letters a-f only.';
    case 'odd-length':
      return 'Seed has an odd number of characters, so it is missing one. Hex seeds have an even length.';
    case 'too-short':
      return `Seed is too short: ${bytes} bytes. Expected ${HEX_RANGE} hex characters — a 64-character seed, or 128 for one derived from a recovery phrase.`;
    case 'too-long':
      return `Seed is too long: ${bytes} bytes. Expected ${HEX_RANGE} hex characters — a 64-character seed, or 128 for one derived from a recovery phrase.`;
  }
}

/**
 * Throw unless `hex` is a seed the SDK will accept. Returns the trimmed seed.
 *
 * Callers get the shape guarantee only. Whether this is the *right* seed is not
 * knowable from the seed alone — see the note at the top of this file.
 */
export function assertHexSeed(hex: string): string {
  const check = checkHexSeed(hex);
  if (!check.ok) {
    throw new WalletError('INVALID_INPUT', describeHexSeedProblem(check.problem!, check.bytes));
  }
  return hex.trim();
}
