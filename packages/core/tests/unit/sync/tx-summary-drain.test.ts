// PROBE: does an unfunded dApp output ALWAYS surface as a spend?
//
// The connector's balance approval is the only control between a hostile dApp
// and the user's funds (operations.ts balanceTransaction applies no cap, no
// recipient check). If summarizeConnectorTransaction returns empty spends for
// any transaction shape that still balances, the approval screen renders
// "This transaction takes nothing from your wallet apart from the network fee."
// while the wallet funds the outputs. Each case below asserts the invariant.

import {describe, expect, it} from 'vitest';
import {
  CostModel,
  Intent,
  Transaction,
  UnshieldedOffer,
  nativeToken,
  type ProvingProvider,
  type SegmentSpecifier,
  type UtxoOutput,
} from '@midnight-ntwrk/ledger-v8';
import {summarizeConnectorTransaction} from '../../../src/sync/tx-summary.js';

const OWNER = 'be5eb2579464f606ed883d18831617302f484e6ce3602b0e2725801b653cd19d';
const DRAIN = 3_000_000_000n;

const noProofs: ProvingProvider = {
  async check() { throw new Error('unexpected proof check'); },
  async prove() { throw new Error('unexpected proving'); },
};

const out = (value: bigint): UtxoOutput => ({owner: OWNER, type: nativeToken().raw, value});

function drainIntent(where: 'guaranteed' | 'fallible') {
  const intent = Intent.new(new Date(Date.now() + 60_000));
  const offer = UnshieldedOffer.new([], [out(DRAIN)], []);
  if (where === 'guaranteed') intent.guaranteedUnshieldedOffer = offer;
  else intent.fallibleUnshieldedOffer = offer;
  return intent;
}

async function ser(unproven: ReturnType<typeof Transaction.fromParts>): Promise<Uint8Array> {
  const unbound = await unproven.prove(noProofs, CostModel.initialCostModel());
  return unbound.serialize();
}

function report(label: string, bytes: Uint8Array) {
  const s = summarizeConnectorTransaction(bytes, false);
  const show = (a: typeof s.spends) => a.map((e) => `${e.kind}:${e.amount}`).join(',') || '(none)';
  // eslint-disable-next-line no-console
  console.log(`[${label}] spends=${show(s.spends)} receives=${show(s.receives)} actions=${s.contractActions}`);
  return s;
}

describe('drain-shape probe: an unfunded output must always show as a spend', () => {
  it('baseline — fallible unshielded offer via fromParts', async () => {
    const s = report('fallible/fromParts', await ser(Transaction.fromParts('preprod', undefined, undefined, drainIntent('fallible'))));
    expect(s.spends).not.toEqual([]);
  });

  it('guaranteed unshielded offer via fromParts', async () => {
    const s = report('guaranteed/fromParts', await ser(Transaction.fromParts('preprod', undefined, undefined, drainIntent('guaranteed'))));
    expect(s.spends).not.toEqual([]);
  });

  it('fallible unshielded offer via fromPartsRandomized', async () => {
    const s = report('fallible/randomized', await ser(Transaction.fromPartsRandomized('preprod', undefined, undefined, drainIntent('fallible'))));
    expect(s.spends).not.toEqual([]);
  });

  it('guaranteed unshielded offer via fromPartsRandomized', async () => {
    const s = report('guaranteed/randomized', await ser(Transaction.fromPartsRandomized('preprod', undefined, undefined, drainIntent('guaranteed'))));
    expect(s.spends).not.toEqual([]);
  });

  const segments: Array<[string, SegmentSpecifier]> = [
    ['first', {tag: 'first'}],
    ['guaranteedOnly', {tag: 'guaranteedOnly'}],
    ['random', {tag: 'random'}],
    ['specific:1', {tag: 'specific', value: 1}],
    ['specific:7', {tag: 'specific', value: 7}],
    ['specific:65535', {tag: 'specific', value: 65535}],
  ];

  for (const [name, seg] of segments) {
    for (const where of ['guaranteed', 'fallible'] as const) {
      // The ledger itself refuses a fallible offer in the guaranteed-only
      // segment, so there is no transaction to summarize. Pinned so a ledger
      // release that starts ACCEPTING it fails here rather than silently
      // creating a shape the summary has never seen.
      const ledgerRejects = name === 'guaranteedOnly' && where === 'fallible';

      it(`addIntent(${name}) with ${where} offer`, async () => {
        const base = Transaction.fromParts('preprod');
        if (ledgerRejects) {
          expect(() => base.addIntent(seg, drainIntent(where) as never)).toThrow(
            /cannot use guaranteed segment/i
          );
          return;
        }
        const tx = base.addIntent(seg, drainIntent(where) as never);
        const s = report(`addIntent:${name}/${where}`, await ser(tx as never));
        expect(s.spends).not.toEqual([]);
      });
    }
  }

  it('renders the drain amount and token, not an empty summary', async () => {
    // CRIT-001 claims the approval shows "no recipient, no amount and no
    // token". This pins the amount + token that reach the UI for exactly the
    // reported drain (3000.000000 NIGHT); tx-summary-view then formats it.
    const s = report('reported-drain', await ser(
      Transaction.fromParts('preprod', undefined, undefined, drainIntent('fallible'))
    ));
    expect(s.spends).toEqual([
      {kind: 'unshielded', tokenId: nativeToken().raw, amount: DRAIN},
    ]);
  });
});
