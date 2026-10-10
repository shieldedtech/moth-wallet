// Validating the DUST receiver a cNIGHT registration records.
//
// Kept apart from registration.ts, which loads Lucid, so the daemon's wire
// parsers and other surfaces can validate a receiver without that WASM.

import { DustAddress, MidnightBech32m } from '@midnightntwrk/wallet-sdk/address-format';
import { InvalidInputError } from '../types/errors.js';

/**
 * Serialized bytes of a Midnight DUST address — what a registration datum
 * records, 33 bytes.
 *
 * Not the shielded coin public key, which is 32 bytes and a different key
 * entirely. Both decode cleanly from their own address type, so nothing
 * downstream catches the swap: the registration is valid on Cardano and the
 * bridge simply never matches it.
 */
export function dustAddressBytes(address: string): string {
  const text = address.trim();
  let parsed;
  try {
    parsed = MidnightBech32m.parse(text);
  } catch {
    throw new InvalidInputError('That is not a valid Midnight address.');
  }
  if (parsed.type !== 'dust') {
    throw new InvalidInputError(
      `That is a ${parsed.type} address. A cNIGHT registration records a DUST `
        + 'address — paste your mn_dust_… address.',
    );
  }
  // Decoded against the address's own network: the payload is network-agnostic,
  // but parsing has to agree with the prefix it was written with.
  const decoded = parsed.decode(DustAddress, parsed.network);
  // The whole 33 bytes serialize() returns — a 0x73 type tag then the payload.
  // Every live registration at the deployed contract carries the tagged form
  // (CBOR header 5821, leading 0x73), and its datum bound is `<= 33`.
  return Buffer.from(decoded.serialize()).toString('hex').toLowerCase();
}

/** A serialized DUST address is 33 bytes; reject anything else before a datum. */
export function assertDustAddressBytes(value: string): string {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{66}$/.test(hex)) {
    throw new InvalidInputError(
      `A DUST address is 33 bytes of hex (66 characters), got ${hex.length} characters.`,
    );
  }
  return hex.toLowerCase();
}

/**
 * Turn whatever the user pasted into the bytes a registration datum takes.
 *
 * Accepts an `mn_dust_…` address or its raw 33-byte hex. A *shielded* address
 * is rejected by name: it is the other plausible thing to paste, it is what an
 * earlier version of the dApp used, and its coin public key is the wrong value.
 */
export function resolveDustReceiver(input: string): string {
  const text = input.trim();
  if (/^(0x)?[0-9a-fA-F]{66}$/.test(text)) return assertDustAddressBytes(text);
  if (text.startsWith('mn_')) return dustAddressBytes(text);
  throw new InvalidInputError(
    'Paste a Midnight DUST address (mn_dust_…) or its 66-character hex.',
  );
}
