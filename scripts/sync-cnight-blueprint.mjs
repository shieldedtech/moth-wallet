// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

// Regenerate packages/core/src/cardano/blueprint-data.ts from an Aiken
// blueprint (plutus.json).
//
// moth inlines the compiled `cnight_generates_dust` validator rather than
// reading a blueprint at runtime: the script takes no parameters, so its hash
// is fixed, and a validator loaded from disk is one more thing that can be
// wrong in the field. The cost is that a redeploy needs this script.
//
//   node scripts/sync-cnight-blueprint.mjs <path-to-plutus.json>
//
// After running it, `yarn workspace @shieldedtech/moth-wallet test` is what
// checks the result: tests/unit/cardano/contract.test.ts recomputes the script
// hash from the new bytes and compares it to the blueprint's own.

import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const VALIDATOR_TITLE = 'cnight_generates_dust.cnight_generates_dust.else';
const OUTPUT = resolve(
  import.meta.dirname,
  '../packages/core/src/cardano/blueprint-data.ts',
);

const blueprintPath = process.argv[2];
if (!blueprintPath) {
  console.error('usage: node scripts/sync-cnight-blueprint.mjs <path-to-plutus.json>');
  process.exit(2);
}

const blueprint = JSON.parse(readFileSync(resolve(blueprintPath), 'utf-8'));
const validator = blueprint.validators?.find((v) => v.title === VALIDATOR_TITLE);

if (!validator) {
  const titles = (blueprint.validators ?? []).map((v) => v.title).join('\n  ');
  console.error(`no validator titled "${VALIDATOR_TITLE}" in ${blueprintPath}. Found:\n  ${titles}`);
  process.exit(1);
}

const plutusVersion = blueprint.preamble?.plutusVersion;
if (plutusVersion !== 'v3') {
  // blueprint.ts hardcodes PlutusV3 when it builds the Script. A version bump
  // needs a matching edit there, so fail rather than emit bytes the attach
  // calls would mislabel.
  console.error(
    `blueprint declares plutusVersion "${plutusVersion}", but cardano/blueprint.ts ` +
      'attaches the script as PlutusV3. Update it before syncing.',
  );
  process.exit(1);
}

const compiler = blueprint.preamble?.compiler;
const wrapped = (validator.compiledCode.match(/.{1,100}/g) ?? [])
  .map((chunk) => `  ${JSON.stringify(chunk)}`)
  .join(' +\n');

writeFileSync(
  OUTPUT,
  `/**
 * Compiled \\\`cnight_generates_dust\\\` validator, lifted verbatim from the Aiken
 * blueprint that the cNIGHT-to-DUST dApp ships
 * (\\\`public/contracts-new-aiken/plutus.json\\\`, ${compiler?.name ?? 'aiken'} ${compiler?.version ?? '?'}).
 *
 * The blueprint declares ${blueprint.validators.length} validators; this is the only one moth needs.
 * It takes no compile-time parameters, so its hash is fixed and the address it
 * guards is a pure function of the network id — there is nothing to apply and
 * nothing to configure.
 *
 * One script plays three roles in the registration flow, which is why the same
 * bytes get attached as a minting policy, a spending validator and a
 * withdrawal validator in different transactions.
 *
 * DO NOT hand-edit. Regenerate with scripts/sync-cnight-blueprint.mjs when the
 * contract is redeployed, and re-check the hash against the dApp.
 */

/** PlutusV3, double-CBOR-encoded, as the blueprint stores it. */
export const CNIGHT_GENERATES_DUST_CBOR =
${wrapped};

/** Blueprint-declared script hash. Doubles as the minting policy id. */
export const CNIGHT_GENERATES_DUST_HASH =
  '${validator.hash}';

export const CNIGHT_GENERATES_DUST_TITLE =
  '${validator.title}';
`,
);

console.log(`wrote ${OUTPUT}`);
console.log(`  validator ${validator.title}`);
console.log(`  hash      ${validator.hash}`);
console.log('Run the core tests to confirm the bytes hash to that value.');
