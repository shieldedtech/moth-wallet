// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

// Regenerate packages/core/src/cardano/blueprint-data.ts from a compiled
// `cnight_generates_dust` validator.
//
// moth inlines the script rather than reading it at runtime: it takes no
// parameters, so its hash is fixed, and a validator loaded from disk is one
// more thing that can be wrong in the field. The cost is that a redeploy needs
// this script.
//
//   node scripts/sync-cnight-blueprint.mjs <path>
//
// <path> is either a cardano-cli `.plutus` envelope or an Aiken `plutus.json`
// blueprint.
//
// THE HASH IS THE POINT. moth once synced from a blueprint that compiled
// cleanly, hashed consistently, produced well-formed transactions — and was a
// different deployment from the one the Midnight bridge watches. Registrations
// landed on chain, confirmed, and generated nothing, with no error anywhere to
// read. Nothing caught it because every check was self-consistent: the bytes
// agreed with the hash in the same file they came from.
//
// So the expected hash is pinned HERE, against the contract observed to be
// live, and a sync that produces anything else fails. Changing DEPLOYED_HASH
// is a deliberate act that should come with evidence the new one is in use —
// `node scripts/sync-cnight-blueprint.mjs <path> --verify-on-chain` checks a
// Koios UTXO query for registrations at the derived address.

import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {validatorToScriptHash, validatorToAddress} from '@lucid-evolution/lucid';

/**
 * The deployed `cnight_generates_dust` the Midnight bridge reads.
 *
 * Preprod, confirmed by observation rather than by paperwork: registrations at
 * this script address are reported `registered: true` with live generation
 * rates by the Midnight indexer. The other compilation in the tree — the
 * dApp's `contracts-new-aiken/plutus.json`, hash 5027bb76… — has no
 * registrations the bridge has ever acknowledged.
 */
const DEPLOYED_HASH = '7e69087d98fac5869eac14e13dfb6f98228c41e638aa2a59d1f85e9c';

const VALIDATOR_TITLE = 'cnight_generates_dust.cnight_generates_dust.else';
const OUTPUT = resolve(import.meta.dirname, '../packages/core/src/cardano/blueprint-data.ts');

const args = process.argv.slice(2);
const sourcePath = args.find((a) => !a.startsWith('--'));
const verifyOnChain = args.includes('--verify-on-chain');
if (!sourcePath) {
  console.error('usage: node scripts/sync-cnight-blueprint.mjs <path-to-.plutus-or-plutus.json> [--verify-on-chain]');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(resolve(sourcePath), 'utf-8'));

/** Both source shapes, reduced to {cborHex, description, version}. */
function readSource(doc) {
  if (typeof doc.cborHex === 'string') {
    return {cborHex: doc.cborHex, description: doc.description ?? '', version: doc.type};
  }
  const validator = doc.validators?.find((v) => v.title === VALIDATOR_TITLE);
  if (!validator) {
    const titles = (doc.validators ?? []).map((v) => v.title).join('\n  ');
    throw new Error(`no validator titled "${VALIDATOR_TITLE}". Found:\n  ${titles}`);
  }
  const v = doc.preamble?.plutusVersion;
  return {
    cborHex: validator.compiledCode,
    description: validator.title,
    version: v === 'v3' ? 'PlutusScriptV3' : String(v),
  };
}

const {cborHex, description, version} = readSource(raw);

if (version !== 'PlutusScriptV3') {
  // blueprint.ts hardcodes PlutusV3 when it builds the Script. A version bump
  // needs a matching edit there, so fail rather than emit mislabelled bytes.
  console.error(`source declares "${version}", but cardano/blueprint.ts attaches PlutusV3.`);
  process.exit(1);
}

const script = {type: 'PlutusV3', script: cborHex};
const hash = validatorToScriptHash(script);

if (hash !== DEPLOYED_HASH) {
  console.error(`refusing to sync: ${sourcePath}`);
  console.error(`  hashes to  ${hash}`);
  console.error(`  deployed   ${DEPLOYED_HASH}`);
  console.error('');
  console.error('These bytes compile and would build valid transactions — against a');
  console.error('contract nothing is watching. If this source really is the new');
  console.error('deployment, update DEPLOYED_HASH in this script, with evidence.');
  process.exit(1);
}

if (verifyOnChain) {
  const address = validatorToAddress('Preprod', script);
  const res = await fetch('https://preprod.koios.rest/api/v1/address_utxos', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({_addresses: [address]}),
  });
  const utxos = await res.json();
  console.log(`  on-chain   ${address}`);
  console.log(`             ${Array.isArray(utxos) ? utxos.length : '?'} live registrations`);
  if (!Array.isArray(utxos) || utxos.length === 0) {
    console.error('no registrations at that address — this is not a contract in use.');
    process.exit(1);
  }
}

const wrapped = (cborHex.match(/.{1,100}/g) ?? [])
  .map((chunk) => `  ${JSON.stringify(chunk)}`)
  .join(' +\n');

writeFileSync(
  OUTPUT,
  `/**
 * Compiled \\\`cnight_generates_dust\\\` validator — the deployment the Midnight
 * bridge reads, lifted verbatim from \\\`${sourcePath}\\\`.
 *
 * It takes no compile-time parameters, so its hash is fixed and the address it
 * guards is a pure function of the network id — there is nothing to apply and
 * nothing to configure.
 *
 * One script plays three roles in the registration flow, which is why the same
 * bytes get attached as a minting policy, a spending validator and a
 * withdrawal validator in different transactions.
 *
 * There is a SECOND compilation of this contract in the ecosystem — the dApp's
 * \\\`contracts-new-aiken/plutus.json\\\`, hash 5027bb76… — which is newer, builds
 * fine, and is not what the bridge watches. Syncing from it produced
 * registrations that confirmed on Cardano and generated nothing, silently.
 * scripts/sync-cnight-blueprint.mjs pins the deployed hash for that reason.
 *
 * DO NOT hand-edit. Regenerate with scripts/sync-cnight-blueprint.mjs.
 */

/** PlutusV3, CBOR-encoded, as the source stores it. */
export const CNIGHT_GENERATES_DUST_CBOR =
${wrapped};

/** Script hash, recomputed from the bytes above. Doubles as the minting policy id. */
export const CNIGHT_GENERATES_DUST_HASH =
  '${hash}';

export const CNIGHT_GENERATES_DUST_TITLE =
  '${description}';
`,
);

console.log(`wrote ${OUTPUT}`);
console.log(`  source    ${sourcePath}`);
console.log(`  hash      ${hash}  (matches deployed)`);
