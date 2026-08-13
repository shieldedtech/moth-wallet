// Execution harness for moth-ft: runs both mint circuits through
// @midnight-ntwrk/compact-runtime (no chain, no proof server) and observes
// the results. Verification-by-execution, not just compilation.

import { Contract, ledger, pureCircuits } from './managed/contract/index.js';
import {
  createConstructorContext,
  createCircuitContext,
  toHex,
} from '@midnight-ntwrk/compact-runtime';
import {
  sampleContractAddress,
  rawTokenType,
} from '@midnight-ntwrk/onchain-runtime-v3';

const hx = (u) => (u instanceof Uint8Array ? toHex(u) : String(u));
let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ::  ' + detail : ''}`);
  if (!cond) failures++;
}

// --- Setup -------------------------------------------------------------
const contract = new Contract({}); // Witnesses<PS> = {} -> no witnesses
const contractAddress = sampleContractAddress();
const coinPublicKey = '00'.repeat(32); // caller's zswap coin PK (hex)

const ctorCtx = createConstructorContext({}, coinPublicKey);
const initial = contract.initialState(ctorCtx);
let cState = initial.currentContractState;
const pState = initial.currentPrivateState;

const led0 = ledger(cState.data);
console.log('\n== initial ledger ==');
console.log('mintCount:', led0.mintCount, ' nonce:', hx(led0.nonce));
check('initial mintCount == 0', led0.mintCount === 0n);
check('initial nonce is 32 zero bytes', hx(led0.nonce) === '00'.repeat(32));

// domainSep pure circuit
const dsep = pureCircuits.domainSep();
console.log('\n== domainSep ==');
console.log('domainSep bytes:', hx(dsep));
const expectAscii = Buffer.from('moth:ft:').toString('hex') + '00'.repeat(32 - 8);
check('domainSep == pad(32,"moth:ft:")', hx(dsep) === expectAscii, `got ${hx(dsep)}`);

// Independently derive the expected token color for this contract
const expectedColor = rawTokenType(dsep, contractAddress);
console.log('expected color (rawTokenType):', expectedColor);

// --- mintShielded #1 ---------------------------------------------------
const recipientShield = { bytes: new Uint8Array(32).fill(0xab) };
let ctx = createCircuitContext(contractAddress, coinPublicKey, cState, pState);
const r1 = contract.circuits.mintShielded(ctx, recipientShield, 1000n);
console.log('\n== mintShielded #1 (value=1000) ==');
console.log('result:', { nonce: hx(r1.result.nonce), color: hx(r1.result.color), value: r1.result.value });
check('returned value == 1000', r1.result.value === 1000n);
check('returned color == expected token color', hx(r1.result.color) === expectedColor.replace(/^0x/, ''));
check('returned nonce != initial (fresh)', hx(r1.result.nonce) !== '00'.repeat(32));

const zs1 = r1.context.currentZswapLocalState;
console.log('zswap outputs count:', zs1.outputs.length);
const out1 = zs1.outputs[0];
check('one zswap output produced', zs1.outputs.length === 1);
if (out1) {
  console.log('output coinInfo keys:', Object.keys(out1.coinInfo));
  console.log('output coinInfo:', JSON.stringify(out1.coinInfo, (_k, v) => typeof v === "bigint" ? v.toString() : (v instanceof Uint8Array ? hx(v) : v)));
  console.log('output recipient:', JSON.stringify(out1.recipient, (_k, v) => typeof v === "bigint" ? v.toString() : (v instanceof Uint8Array ? hx(v) : v)));
  check('output coin value == 1000', out1.coinInfo.value === 1000n);
  const outColor = out1.coinInfo.type ?? out1.coinInfo.color;
  const outColorHex = (outColor instanceof Uint8Array ? hx(outColor) : String(outColor)).replace(/^0x/, '');
  check('output coin color == expected', outColorHex === expectedColor.replace(/^0x/, ''), `got ${outColorHex}`);
  check('output recipient == supplied shielded key (left)',
    out1.recipient.is_left === true && hx(out1.recipient.left.bytes) === 'ab'.repeat(32));
}

const ledA = ledger(r1.context.currentQueryContext.state);
console.log('ledger after #1 -> mintCount:', ledA.mintCount, ' nonce:', hx(ledA.nonce));
check('mintCount incremented to 1', ledA.mintCount === 1n);
check('ledger nonce updated', hx(ledA.nonce) !== '00'.repeat(32));
check('ledger nonce == returned coin nonce', hx(ledA.nonce) === hx(r1.result.nonce));

// --- mintShielded #2 (chained) : nonce must be fresh ------------------
const r2 = contract.circuits.mintShielded(r1.context, recipientShield, 500n);
console.log('\n== mintShielded #2 (value=500) ==');
console.log('result nonce:', hx(r2.result.nonce), ' value:', r2.result.value);
check('second value == 500', r2.result.value === 500n);
check('second nonce differs from first (no reuse)', hx(r2.result.nonce) !== hx(r1.result.nonce));
const ledB = ledger(r2.context.currentQueryContext.state);
check('mintCount incremented to 2', ledB.mintCount === 2n);

// --- mintUnshielded ----------------------------------------------------
const recipientUser = { bytes: new Uint8Array(32).fill(0xcd) };
const r3 = contract.circuits.mintUnshielded(r2.context, recipientUser, 2000n);
console.log('\n== mintUnshielded (value=2000) ==');
console.log('returned color:', hx(r3.result));
check('mintUnshielded returns 32-byte color', r3.result instanceof Uint8Array && r3.result.length === 32);
check('mintUnshielded color == expected token color', hx(r3.result) === expectedColor.replace(/^0x/, ''));

// mintCount must NOT change on unshielded (nonce logic is shielded-only)
const ledC = ledger(r3.context.currentQueryContext.state);
check('mintCount unchanged by unshielded mint (still 2)', ledC.mintCount === 2n);

console.log(`\n==== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ====`);
process.exit(failures === 0 ? 0 : 1);
