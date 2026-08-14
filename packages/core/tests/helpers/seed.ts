import { mnemonicToSeed } from '../../src/wallet/mnemonic.js';

/**
 * The one mnemonic the core test suite derives from. Every test that needs a
 * seed uses this one so that new tests inherit the addresses already pinned by
 * unit/wallet/address-parity.test.ts against the official Midnight wallet SDK —
 * a second mnemonic would need its own independently verified reference values
 * before any derived assertion meant anything.
 *
 * It holds no funds on any network and is safe to commit.
 */
export const TEST_MNEMONIC =
  'tribe eternal ritual flush hold victory effort monkey bounce sure bounce output burger broccoli wedding warrior salad hurt focus service claw glide sell eye';

/**
 * The unshielded preprod address TEST_MNEMONIC derives at role 0, verified
 * against the official wallet SDK on 2026-05-11. Defined once here because both
 * the parity test that pins it and the operations tests that transact with it
 * need the same value — two copies is one copy that can be quietly corrected.
 */
export const VERIFIED_PREPROD_ADDRESS =
  'mn_addr_preprod1qw986g7d2hx35u237672j0fr38eacad9ns6uf5ewrphmgptda6zq2ssx95';

/** TEST_MNEMONIC as the lowercase hex seed the derivation functions take. */
export async function testSeedHex(): Promise<string> {
  const seed = await mnemonicToSeed(TEST_MNEMONIC);
  return Array.from(seed, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
