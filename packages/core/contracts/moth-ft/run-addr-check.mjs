// Verify (by execution) how to turn a bech32m address into the recipient arg
// for each mint circuit. Derives real addresses from a random seed, then
// decodes them back and extracts the 32-byte key the circuit expects.
import { randomBytes } from 'node:crypto';
import {
  MidnightBech32m,
  ShieldedAddress,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk/address-format';
import { deriveAllAddressesFromSeed } from '../../src/wallet/address.ts';

const seedHex = randomBytes(32).toString('hex');
const network = 'undeployed';
const addrs = deriveAllAddressesFromSeed(seedHex);
const shieldAddr = addrs.zswap.bech32m[network];      // mn_shield-addr...
const userAddr = addrs.nightExternal.bech32m[network]; // mn_addr...
console.log('shielded addr:', shieldAddr);
console.log('unshielded addr:', userAddr);

const hx = (b) => Buffer.from(b).toString('hex');
let fail = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? '  :: ' + d : ''}`); if (!c) fail++; };

// --- shielded -> ZswapCoinPublicKey recipient arg ({ bytes: Uint8Array(32) })
const sa = MidnightBech32m.parse(shieldAddr).decode(ShieldedAddress, network);
const shieldRecipient = { bytes: new Uint8Array(sa.coinPublicKey.data) };
console.log('shielded recipient.bytes:', hx(shieldRecipient.bytes));
check('shielded prefix is mn_shield-addr', shieldAddr.startsWith('mn_shield-addr'));
check('decoded coin PK is 32 bytes', shieldRecipient.bytes.length === 32);
check('coinPublicKey.toHexString matches .data bytes',
  sa.coinPublicKey.toHexString().replace(/^0x/, '') === hx(shieldRecipient.bytes));

// --- unshielded -> UserAddress recipient arg ({ bytes: Uint8Array(32) })
const ua = MidnightBech32m.parse(userAddr).decode(UnshieldedAddress, network);
const userRecipient = { bytes: new Uint8Array(ua.data) };
console.log('unshielded recipient.bytes:', hx(userRecipient.bytes));
check('unshielded prefix is mn_addr', userAddr.startsWith('mn_addr'));
check('decoded user addr is 32 bytes', userRecipient.bytes.length === 32);

console.log(`\n==== ${fail === 0 ? 'ADDRESS DECODE VERIFIED' : fail + ' FAIL'} ====`);
process.exit(fail === 0 ? 0 : 1);
