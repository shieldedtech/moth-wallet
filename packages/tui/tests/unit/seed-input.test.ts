// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import {describe, it, expect} from 'vitest';
import {MIN_SEED_BYTES, MAX_SEED_BYTES} from '@shieldedtech/moth-wallet';
import {checkSeedInput} from '../../src/screens/onboarding/seed-input.js';

const hex = (bytes: number): string => 'ab'.repeat(bytes);

describe('checkSeedInput — hex', () => {
  // The regression this file exists for: the screen used to match {64} exactly,
  // so the 128-character seed the extension reveals for a phrase-backed account
  // was refused here while the CLI took it.
  it('accepts the 128-character seed a phrase-backed wallet exports', () => {
    const check = checkSeedInput('hex', hex(64));
    expect(check.ok).toBe(true);
    expect(check.value).toBe(hex(64));
    expect(check.warning).toBeUndefined();
  });

  it('accepts a 64-character toolkit seed', () => {
    expect(checkSeedInput('hex', hex(32))).toMatchObject({ok: true, value: hex(32)});
  });

  it('accepts every length the SDK derives from, so the TUI never gates tighter than core', () => {
    for (let bytes = MIN_SEED_BYTES; bytes <= MAX_SEED_BYTES; bytes++) {
      expect(checkSeedInput('hex', hex(bytes)).ok, `${bytes} bytes`).toBe(true);
    }
  });

  it('warns without refusing on a length no tool emits', () => {
    const check = checkSeedInput('hex', hex(31));
    expect(check.ok).toBe(true);
    expect(check.warning).toMatch(/31 bytes/);
  });

  it('normalises case and surrounding whitespace', () => {
    expect(checkSeedInput('hex', `  ${'AB'.repeat(32)}\n`).value).toBe(hex(32));
  });

  it('refuses input the SDK cannot derive from', () => {
    expect(checkSeedInput('hex', '')).toMatchObject({ok: false});
    expect(checkSeedInput('hex', 'zz'.repeat(32)).error).toMatch(/hexadecimal/i);
    expect(checkSeedInput('hex', 'a'.repeat(65)).error).toMatch(/odd number/i);
    expect(checkSeedInput('hex', hex(15)).error).toMatch(/too short/i);
    expect(checkSeedInput('hex', hex(65)).error).toMatch(/too long/i);
  });
});

describe('checkSeedInput — mnemonic', () => {
  const phrase = Array(23).fill('abandon').concat('art').join(' ');

  it('accepts a valid 24-word phrase and collapses separators', () => {
    expect(checkSeedInput('mnemonic', phrase.replace(/ /g, ',  ')).value).toBe(phrase);
  });

  it('refuses a phrase that fails the BIP-39 checksum', () => {
    const bad = Array(24).fill('abandon').join(' ');
    expect(checkSeedInput('mnemonic', bad)).toMatchObject({ok: false});
  });
});

describe('checkSeedInput — unknown source', () => {
  it('refuses rather than falling through to an importer', () => {
    expect(checkSeedInput(undefined, hex(32))).toMatchObject({ok: false});
  });
});
