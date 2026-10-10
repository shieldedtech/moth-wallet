import {describe, expect, it} from 'vitest';
import {isCardanoRewardAddress} from '../../src/commands/dust/status.js';

// `dustGenerationStatus` takes CARDANO reward addresses — DUST generation tracks
// NIGHT held on Cardano. The command used to forward the wallet's Midnight
// address instead, with a comment admitting it was a placeholder, so the
// diagnostic came from the indexer's Cardano parser:
//
//   invalid Cardano reward address: invalid HRP for Cardano reward address:
//   mn_addr_devnet
//
// Devnet's indexer tolerated it; preprod's did not (#107).
describe('isCardanoRewardAddress', () => {
  it('accepts mainnet and test reward addresses', () => {
    expect(isCardanoRewardAddress('stake1u9abcdef')).toBe(true);
    expect(isCardanoRewardAddress('stake_test1uqabcdef')).toBe(true);
  });

  it('rejects Midnight addresses, whichever network they are tagged with', () => {
    // The exact value that produced the reported failure, and its preprod
    // re-encoding — same key material, so neither is a reward address.
    expect(
      isCardanoRewardAddress('mn_addr_devnet18ph9d9mn7teq2qvanjgp4l9u0kqyl4vxwlnhjxc3nhj3mnmf03eskkpdrr'),
    ).toBe(false);
    expect(
      isCardanoRewardAddress('mn_addr_preprod18ph9d9mn7teq2qvanjgp4l9u0kqyl4vxwlnhjxc3nhj3mnmf03esngsypp'),
    ).toBe(false);
    expect(isCardanoRewardAddress('mn_shield-addr_preprod1pr6rvjzteqzu2xehfqgr9xx7tntxqws5uut4tqcgmr3')).toBe(false);
    expect(isCardanoRewardAddress('mn_dust_preprod1wwv7zzwu8nyej0cktwepegfejuc342pgj7nu4uymq0tarsunqh9n6cygeqp')).toBe(
      false,
    );
  });

  it('rejects a Cardano PAYMENT address, which is not a reward address', () => {
    expect(isCardanoRewardAddress('addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3')).toBe(false);
  });

  it('rejects empty and near-miss input', () => {
    expect(isCardanoRewardAddress('')).toBe(false);
    expect(isCardanoRewardAddress('stake')).toBe(false);
    expect(isCardanoRewardAddress('STAKE1U9ABC')).toBe(false);
  });
});
