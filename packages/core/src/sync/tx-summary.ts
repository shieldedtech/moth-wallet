// What a dApp-supplied transaction asks of the wallet, read off the transaction
// itself before the wallet balances it.
//
// The connector's balance{Sealed,Unsealed}Transaction hands the wallet a
// transaction the dApp built. The wallet then covers whatever the transaction
// is short of — inputs for every deficit, plus fees — so the deficit IS the
// amount that leaves the wallet, and the user needs to see it before approving.
// The ledger reports it directly: `Transaction.imbalances(segment)` is the
// surplus or deficit per token type for one segment, no key material needed.
//
// Sign convention (verified against ledger-v8 in tests/unit/sync/tx-summary.test.ts):
// negative means the segment spends more than it provides — the wallet must
// supply that much — and positive means the segment provides more than it
// spends, which the wallet collects as change. Segments are summed, because the
// approval question is "what does this cost me overall": segment 0 is the
// guaranteed section; every intent (and every fallible Zswap offer) occupies its
// own numbered segment.

import * as ledger from '@midnight-ntwrk/ledger-v8';
import {MidnightBech32m, UnshieldedAddress} from '@midnightntwrk/wallet-sdk/address-format';

/** One token amount the balancing step moves in or out of the wallet. */
export interface TxTokenAmount {
  kind: 'shielded' | 'unshielded' | 'dust';
  /** Raw token type as hex; empty for DUST, which has a single type. */
  tokenId: string;
  /** Always positive; direction is given by which list it sits in. */
  amount: bigint;
}

export interface TransactionSummary {
  /** Deficits: what the wallet must put in, and so what leaves it. */
  spends: TxTokenAmount[];
  /** Surpluses: what the wallet receives back as change. */
  receives: TxTokenAmount[];
  /** Contract calls, deploys and maintenance updates across all intents. */
  contractActions: number;
  /**
   * Every destination the transaction pays, with what each one receives.
   *
   * Amounts alone cannot distinguish a legitimate transaction from a drain:
   * "You pay 3000 NIGHT" reads identically whether the tokens go to a contract
   * the user meant to call or to an attacker's address. The destination is the
   * only field that separates them, so the approval must show it.
   *
   * In first-seen order. This module holds no keys, so it cannot tell the
   * wallet's own change output from a third party's — the caller, which does
   * know the session's addresses, marks that.
   */
  recipients: TxRecipient[];
}

/** One destination a transaction pays, and what it receives. */
export interface TxRecipient {
  /**
   * bech32m address for a user destination, the raw contract address for a
   * contract action. Falls back to the raw hex owner when encoding fails.
   */
  address: string;
  /** Which kind of destination this is; they need different words on screen. */
  kind: 'user' | 'contract';
  /**
   * What this destination receives, totalled per token across every intent.
   *
   * Per destination rather than per transaction, because a net total cannot say
   * which share goes where: outputs of 2999 to one address and 1 to another
   * render as a single "you pay 3000" beside two addresses, and the larger of
   * the two is exactly what a drain hides behind.
   *
   * Empty for a contract action, whose value moves through its transcripts
   * rather than a UTXO output, so there is no per-destination amount to read.
   */
  amounts: TxTokenAmount[];
}

type AnyTransaction = ledger.Transaction<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>;

/**
 * Deserialize a transaction at the stage the connector accepts for balancing:
 * signed and proven, sealed (bound) or unsealed (pre-binding). Same markers the
 * balancing path in operations.ts uses, so what is summarized is exactly what
 * will be balanced.
 */
export function decodeConnectorTransaction(txBytes: Uint8Array, sealed: boolean): AnyTransaction {
  const Transaction = ledger.Transaction;
  return sealed
    ? Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>(
        'signature',
        'proof',
        'binding',
        txBytes
      )
    : Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>(
        'signature',
        'proof',
        'pre-binding',
        txBytes
      );
}

/** Every segment id the transaction carries: the guaranteed section plus one per intent / fallible offer. */
function segmentIds(tx: AnyTransaction): number[] {
  const ids = new Set<number>([0]);
  for (const id of tx.intents?.keys() ?? []) ids.add(id);
  for (const id of tx.fallibleOffer?.keys() ?? []) ids.add(id);
  return [...ids].sort((a, b) => a - b);
}

function tokenKey(type: ledger.TokenType): string {
  return type.tag === 'dust' ? 'dust' : `${type.tag}:${type.raw}`;
}

/**
 * Bech32m-encode a raw unshielded owner. Falls back to the raw hex rather than
 * throwing: an address the encoder does not recognise is still worth showing,
 * and this runs inside the approval path where an exception would blank the
 * screen the user is relying on.
 */
function encodeOwner(owner: string, networkId: string): string {
  try {
    return MidnightBech32m.encode(networkId, new UnshieldedAddress(Buffer.from(owner, 'hex'))).toString();
  } catch {
    return owner;
  }
}

/** Destinations across every intent, guaranteed and fallible. */
function transactionRecipients(tx: AnyTransaction, networkId: string): TxRecipient[] {
  const byOwner = new Map<string, Map<string, {type: ledger.TokenType; amount: bigint}>>();
  for (const intent of tx.intents?.values() ?? []) {
    for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
      for (const output of offer?.outputs ?? []) {
        const address = encodeOwner(output.owner, networkId);
        let totals = byOwner.get(address);
        if (!totals) byOwner.set(address, (totals = new Map()));
        const type: ledger.TokenType = {tag: 'unshielded', raw: output.type};
        const key = tokenKey(type);
        totals.set(key, {type, amount: (totals.get(key)?.amount ?? 0n) + output.value});
      }
    }
  }
  const recipients: TxRecipient[] = [...byOwner].map(([address, totals]) => ({
    address,
    kind: 'user' as const,
    amounts: [...totals.values()].map(({type, amount}) => toTokenAmount(type, amount)),
  }));

  // Contract actions produce no UTXO output, so without this a transaction
  // whose only destination is a contract shows an amount leaving the wallet and
  // no destination at all — the screen then has nothing to point the user at.
  for (const intent of tx.intents?.values() ?? []) {
    for (const action of intent.actions) {
      const address = (action as {address?: string}).address;
      if (address && !recipients.some((existing) => existing.address === address)) {
        recipients.push({address, kind: 'contract', amounts: []});
      }
    }
  }
  return recipients;
}

function toTokenAmount(type: ledger.TokenType, amount: bigint): TxTokenAmount {
  return type.tag === 'dust'
    ? {kind: 'dust', tokenId: '', amount}
    : {kind: type.tag, tokenId: type.raw, amount};
}

/**
 * Sum the per-segment imbalances into what the wallet pays and what it gets
 * back. Fees are not included: they are computed only once the wallet has
 * balanced and proven its own segment, and they are always paid in DUST.
 */
export function summarizeTransaction(tx: AnyTransaction, networkId: string): TransactionSummary {
  const totals = new Map<string, {type: ledger.TokenType; amount: bigint}>();
  for (const segment of segmentIds(tx)) {
    for (const [type, delta] of tx.imbalances(segment)) {
      const key = tokenKey(type);
      const entry = totals.get(key) ?? {type, amount: 0n};
      entry.amount += delta;
      totals.set(key, entry);
    }
  }

  const spends: TxTokenAmount[] = [];
  const receives: TxTokenAmount[] = [];
  for (const {type, amount} of totals.values()) {
    if (amount < 0n) spends.push(toTokenAmount(type, -amount));
    else if (amount > 0n) receives.push(toTokenAmount(type, amount));
  }

  let contractActions = 0;
  for (const intent of tx.intents?.values() ?? []) contractActions += intent.actions.length;

  return {spends, receives, contractActions, recipients: transactionRecipients(tx, networkId)};
}

/** Decode + summarize in one step, for the connector's approval prompt. */
export function summarizeConnectorTransaction(
  txBytes: Uint8Array,
  sealed: boolean,
  networkId: string
): TransactionSummary {
  return summarizeTransaction(decodeConnectorTransaction(txBytes, sealed), networkId);
}
