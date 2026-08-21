// Wallet operations via WalletFacade — send, designate, dedesignate.
// Architecture follows mn-tui's wallet.ts pattern. See NOTICE for attribution.

import * as Rx from 'rxjs';
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import {ledger as activeLedger} from '../ledger/index.js';
import {
  MidnightBech32m,
  ShieldedAddress,
  UnshieldedAddress,
  DustAddress,
} from '@midnightntwrk/wallet-sdk/address-format';
import {createKeystoreFor, signSegmentFor} from '../sdk/index.js';
import type {
  WalletFacade,
  UtxoWithMeta,
  CombinedTokenTransfer,
  TokenTransfer,
  CombinedSwapInputs,
  CombinedSwapOutputs,
} from '@midnightntwrk/wallet-sdk/facade';
import {HDWallet, Roles} from '@midnightntwrk/wallet-sdk/hd';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import type {NetworkConfig} from '../types/network.js';
import {NIGHT_TOKEN_ID} from './wallet-sync.js';
import {
  estimateRegistrationAffordability,
  DustRegistrationNotYetError,
  type DustRegistrationEstimate,
} from './dust-registration-estimate.js';

// Re-exported from the module that throws it, so a consumer importing the
// registration API by subpath (packages/browser does) gets the error type it has
// to catch from the same place — without also reaching for the estimate module.
export {DustRegistrationNotYetError, type DustRegistrationEstimate};

/** The proven, signed, ready-to-submit transaction produced by the facade. */
export type FinalizedTransaction = ledger.FinalizedTransaction;

export type TxStage = 'building' | 'proving' | 'submitting';

export interface SendRequest {
  type: 'shielded' | 'unshielded';
  tokenId: string;
  amount: bigint;
  to: string;
}

// Multi-output transfer builder (kept from main): groups requests by kind so a
// single transaction can carry several tokens/recipients — the extension's
// batch send and the CLI both rely on it.
function combinedTransfers(
  networkId: string,
  requests: SendRequest[]
): CombinedTokenTransfer[] {
  const grouped = new Map<'shielded' | 'unshielded', TokenTransfer<ShieldedAddress | UnshieldedAddress>[]>();
  for (const req of requests) {
    const parsed = MidnightBech32m.parse(req.to);
    const receiverAddress =
      req.type === 'unshielded'
        ? parsed.decode(UnshieldedAddress, networkId)
        : parsed.decode(ShieldedAddress, networkId);
    const outputs = grouped.get(req.type) ?? [];
    outputs.push({type: req.tokenId, amount: req.amount, receiverAddress});
    grouped.set(req.type, outputs);
  }

  // The map already pairs each kind with same-kind outputs; the cast collapses
  // the inferred shape onto the SDK's discriminated CombinedTokenTransfer union.
  return [...grouped.entries()].map(([type, outputs]) => ({type, outputs})) as CombinedTokenTransfer[];
}

/** An input the wallet offers into a swap intent (no recipient — it's spent). */
export interface SwapInput {
  type: 'shielded' | 'unshielded';
  tokenId: string;
  amount: bigint;
}

// WalletKeys lives in types/wallet.ts so UnlockedWallet can reference it without
// a cross-module import. Re-exported here for paths that historically imported
// it from sync/operations.
export type {WalletKeys} from '../types/wallet.js';
import type {WalletKeys} from '../types/wallet.js';

/**
 * Derive the typed key bundle from a 64-char BIP-39 hex seed. Option A key
 * model (v8's D-KM-3): callers derive once at unlock and discard the raw seed
 * immediately — the bundle holds everything the write paths need, so the seed
 * is never threaded through the daemon or the extension messaging layers.
 */
export function deriveWalletKeys(
  seedHex: string,
  signatureKind: 'schnorr' | 'ecdsa' = 'schnorr',
): WalletKeys {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();

  return {
    shieldedSecretKeys: activeLedger().ZswapSecretKeys.fromSeed(result.keys[Roles.Zswap]),
    dustSecretKey: activeLedger().DustSecretKey.fromSeed(result.keys[Roles.Dust]),
    nightExternalKey: result.keys[Roles.NightExternal],
    signatureKind,
  };
}

// Legacy private alias — internal callers that predate deriveWalletKeys.
function deriveKeysFromSeed(seedHex: string): WalletKeys {
  return deriveWalletKeys(seedHex);
}

/**
 * Substrate tx-pool rejects a transaction whose hash is already in the pool
 * with error 1013 "Transaction Already Imported". Because a finalized tx has a
 * fixed hash, this fires whenever we resubmit identical bytes — which means the
 * transaction already reached the node, so it should be treated as success.
 */
function isAlreadyImported(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('1013') || /already imported/i.test(msg);
}

/**
 * A connection-level failure where the transaction likely never reached the
 * node — the only case worth resending. A node that evaluated the transaction
 * and rejected it (bad proof, insufficient funds, low priority, …) returns a
 * deterministic verdict; resending the identical bytes only makes the user
 * wait for the same answer, so those rejections must surface immediately.
 */
function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /disconnect|not connected|connection|websocket|socket hang up|time\s?d?\s?out|timeout|ECONN|ENOTFOUND|network|fetch failed|1006/i.test(
    msg
  );
}

/**
 * Submit an already-finalized transaction, classifying failures so the user
 * only waits through a retry when one could actually help:
 *
 * - "Already Imported" (1013): a prior attempt's identical bytes already reached
 *   the pool — that IS submitted, so report success with the tx's own hash.
 * - Transient connection failure: resend (the tx may never have arrived).
 * - Any other error is the node's deterministic rejection: surface it at once,
 *   without burning retries the user has to wait through.
 */
async function submitWithRetry(
  facade: WalletFacade,
  finalized: FinalizedTransaction,
  attempts = 3,
  delayMs = 5_000
): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // The facade resolves to an intent identifier (`identifiers().at(-1)`),
      // but everything downstream — indexer status queries, tx-history entries
      // (WalletEntry.hash), explorers, and the activity feed's pending-row
      // reconciliation — is keyed by the transaction hash. Return that.
      await facade.submitTransaction(finalized);
      return finalized.transactionHash();
    } catch (e) {
      if (isAlreadyImported(e)) return finalized.transactionHash();
      if (attempt === attempts || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

/**
 * Build, prove and sign a transfer, stopping short of submission.
 * The dApp connector's makeTransfer/submitTransaction split needs the
 * finalized transaction as a standalone artifact; sendTokens composes this
 * with submission.
 */
export async function buildTransferTransaction(
  facade: WalletFacade,
  keys: WalletKeys,
  networkId: string,
  requests: SendRequest[],
  onProgress?: (stage: TxStage) => void
): Promise<FinalizedTransaction> {
  setNetworkId(networkId);
  const ks = createKeystoreFor(keys.nightExternalKey, networkId, keys.signatureKind);
  const transfers = combinedTransfers(networkId, requests);
  const ttl = new Date(Date.now() + 30 * 60_000);

  onProgress?.('building');
  const recipe = await facade.transferTransaction(
    transfers,
    {shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey},
    {ttl}
  );

  onProgress?.('proving');
  const signed = await facade.signRecipe(recipe, signSegmentFor(ks) as never);

  return facade.finalizeRecipe(signed);
}

/**
 * Estimate the complete DUST fee for a transfer, including the balancing
 * transaction that pays it. The facade's transfer builder books selected
 * inputs even when fee payment is disabled, so the temporary base transaction
 * is always reverted before returning.
 */
export async function estimateTransferFee(
  facade: WalletFacade,
  keys: WalletKeys,
  networkId: string,
  requests: SendRequest[]
): Promise<bigint> {
  setNetworkId(networkId);
  const transfers = combinedTransfers(networkId, requests);
  const ttl = new Date(Date.now() + 30 * 60_000);
  const recipe = await facade.transferTransaction(
    transfers,
    {shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey},
    {ttl, payFees: false}
  );

  try {
    return await facade.estimateTransactionFee(recipe.transaction, keys.dustSecretKey, {ttl});
  } finally {
    await facade.revertTransaction(recipe.transaction);
  }
}

/**
 * Submit a previously built transfer with retries.
 */
export async function submitFinalizedTransaction(
  facade: WalletFacade,
  finalized: FinalizedTransaction
): Promise<string> {
  return submitWithRetry(facade, finalized);
}

/**
 * Send tokens via the wallet facade using a pre-derived key bundle. Prefer this
 * over {@link sendTokens} when the caller already holds WalletKeys (the daemon
 * and the extension, which derive once at unlock and drop the seed — Option A /
 * D-KM-3, docs/spec/wallet-service/05-key-management.md).
 */
export async function sendTokensWithKeys(
  facade: WalletFacade,
  keys: WalletKeys,
  networkId: string,
  requests: SendRequest[],
  onProgress?: (stage: TxStage) => void
): Promise<string> {
  const finalized = await buildTransferTransaction(facade, keys, networkId, requests, onProgress);
  onProgress?.('submitting');
  return submitFinalizedTransaction(facade, finalized);
}

/**
 * Balance a dApp-supplied transaction (connector `balanceSealedTransaction` /
 * `balanceUnsealedTransaction`): pay fees and add wallet inputs/outputs to
 * remove imbalances, then prove + bind into a submit-ready FinalizedTransaction.
 *
 * `sealed` selects the input stage:
 * - sealed   → Transaction<SignatureEnabled, Proof, Binding>    (FinalizedTransaction)
 * - unsealed → Transaction<SignatureEnabled, Proof, PreBinding> (UnboundTransaction)
 *
 * The prove/finalize tail is the same as {@link buildTransferTransaction}.
 */
export async function balanceTransaction(
  facade: WalletFacade,
  keys: WalletKeys,
  networkId: string,
  txBytes: Uint8Array,
  sealed: boolean,
  onProgress?: (stage: TxStage) => void
): Promise<FinalizedTransaction> {
  setNetworkId(networkId);
  const ks = createKeystoreFor(keys.nightExternalKey, networkId, keys.signatureKind);
  const secretKeys = {shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey};
  const ttl = new Date(Date.now() + 30 * 60_000);

  onProgress?.('building');
  const recipe = sealed
    ? await facade.balanceFinalizedTransaction(
        activeLedger().Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>(
          'signature',
          'proof',
          'binding',
          txBytes
        ),
        secretKeys,
        {ttl}
      )
    : await facade.balanceUnboundTransaction(
        activeLedger().Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>(
          'signature',
          'proof',
          'pre-binding',
          txBytes
        ),
        secretKeys,
        {ttl}
      );

  onProgress?.('proving');
  const signed = await facade.signRecipe(recipe, signSegmentFor(ks) as never);
  return facade.finalizeRecipe(signed);
}

/**
 * Build a swap intent (connector `makeIntent`): the wallet's half of a swap,
 * providing `inputs` (spent) and `outputs` (sent to recipients). Returns the
 * raw unproven, unbound transaction from the SDK's `initSwap` — deliberately
 * NOT proven or bound, so the dApp can combine it with the counterparty's half
 * before the combined transaction is proven, balanced, and submitted.
 *
 * NOTE: the connector's `intentId` option is not honored — the SDK's `initSwap`
 * exposes no segment-id control, so callers cannot pin the intent's id or opt
 * out of transaction merging.
 */
export async function buildSwapIntent(
  facade: WalletFacade,
  keys: WalletKeys,
  networkId: string,
  inputs: SwapInput[],
  outputs: SendRequest[],
  payFees: boolean,
  onProgress?: (stage: TxStage) => void
): Promise<ledger.UnprovenTransaction> {
  setNetworkId(networkId);

  const swapInputs: CombinedSwapInputs = {};
  for (const input of inputs) {
    const bucket = (swapInputs[input.type] ??= {});
    bucket[input.tokenId] = (bucket[input.tokenId] ?? 0n) + input.amount;
  }

  const grouped = new Map<'shielded' | 'unshielded', TokenTransfer<ShieldedAddress | UnshieldedAddress>[]>();
  for (const out of outputs) {
    const parsed = MidnightBech32m.parse(out.to);
    const receiverAddress =
      out.type === 'unshielded'
        ? parsed.decode(UnshieldedAddress, networkId)
        : parsed.decode(ShieldedAddress, networkId);
    const list = grouped.get(out.type) ?? [];
    list.push({type: out.tokenId, amount: out.amount, receiverAddress});
    grouped.set(out.type, list);
  }
  const swapOutputs = [...grouped.entries()].map(([type, outs]) => ({type, outputs: outs})) as CombinedSwapOutputs[];

  const ttl = new Date(Date.now() + 30 * 60_000);
  onProgress?.('building');
  const recipe = await facade.initSwap(
    swapInputs,
    swapOutputs,
    {shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey},
    {ttl, payFees}
  );
  return recipe.transaction;
}

/**
 * Send tokens via the wallet facade. Convenience wrapper that derives a
 * WalletKeys bundle from the seed and delegates to
 * {@link sendTokensWithKeys}. Holds the seed in memory only for the
 * duration of derivation — used by paths like the in-process `moth
 * transfer` CLI command that already work in terms of seedHex.
 */
export async function sendTokens(
  facade: WalletFacade,
  seedHex: string,
  networkId: string,
  requests: SendRequest[],
  onProgress?: (stage: TxStage) => void,
): Promise<string> {
  return sendTokensWithKeys(facade, deriveWalletKeys(seedHex), networkId, requests, onProgress);
}

/**
 * A NIGHT UTXO with its dust-registration status.
 * `raw` is the underlying SDK object; pass it back to designate/dedesignate.
 */
export interface NightUtxo {
  raw: UtxoWithMeta;
  value: bigint;
  registered: boolean;
}

/**
 * List the active wallet's NIGHT UTXOs (registered + unregistered).
 * Waits for the unshielded sub-wallet to be strict-complete — does NOT gate on
 * aggregate `isSynced`, which never becomes true for a fresh wallet whose only
 * activity is unshielded (e.g. a faucet-funded test wallet pre-dust-register).
 */
export async function listNightUtxos(facade: WalletFacade): Promise<NightUtxo[]> {
  const state = await Rx.firstValueFrom(
    facade.state().pipe(Rx.filter((s) => s.unshielded?.progress?.isStrictlyComplete?.() === true)),
  );
  const coins = (state.unshielded.availableCoins as readonly UtxoWithMeta[]).filter(
    (c) => c.utxo.type === NIGHT_TOKEN_ID,
  );
  return coins.map((c) => ({
    raw: c,
    value: BigInt(c.utxo.value),
    registered: c.meta.registeredForDustGeneration,
  }));
}

/**
 * Register NIGHT UTXOs for DUST generation, using a pre-derived
 * WalletKeys bundle (D-KM-3 path — preferred over the seedHex variant
 * for daemon callers).
 */
export async function designateForDustWithKeys(
  facade: WalletFacade,
  keys: WalletKeys,
  networkId: string,
  receiver?: string,
  onProgress?: (stage: TxStage) => void,
  selectedUtxos?: NightUtxo[],
): Promise<string | null> {
  setNetworkId(networkId);
  const ks = createKeystoreFor(keys.nightExternalKey, networkId, keys.signatureKind);

  return designateForDustImpl(facade, ks, networkId, receiver, onProgress, selectedUtxos);
}

/**
 * Register NIGHT UTXOs for DUST generation.
 * If `selectedUtxos` is provided, registers exactly those; otherwise auto-selects
 * all currently unregistered NIGHT UTXOs.
 */
export async function designateForDust(
  facade: WalletFacade,
  seedHex: string,
  networkId: string,
  receiver?: string,
  onProgress?: (stage: TxStage) => void,
  selectedUtxos?: NightUtxo[]
): Promise<string | null> {
  setNetworkId(networkId);
  const keys = deriveKeysFromSeed(seedHex);
  const ks = createKeystoreFor(keys.nightExternalKey, networkId, keys.signatureKind);
  return designateForDustImpl(facade, ks, networkId, receiver, onProgress, selectedUtxos);
}

/**
 * Whether registration can pay its own fee yet, and if not, how long until it
 * can. Reads state and builds a throwaway transaction for costing; books
 * nothing and spends nothing.
 *
 * Registration is self-funding — it draws on the DUST its NIGHT would have
 * generated had it been registered all along — but that backdated amount starts
 * at zero and grows with the NIGHT's age, so a freshly funded wallet cannot
 * cover the fee yet. Without asking first, the wallet builds, proves, fails on
 * the SDK's guard, and reports a defect where the honest answer is "not yet, try
 * in about six minutes". See sync/dust-registration-estimate.ts.
 */
export async function estimateDustRegistration(
  facade: WalletFacade,
  selectedUtxos?: NightUtxo[],
): Promise<DustRegistrationEstimate> {
  const utxos = selectedUtxos?.length
    ? selectedUtxos.map((u) => u.raw)
    : await unregisteredNightUtxos(facade);

  // Nothing to register: no fee, and no accrual to wait for. The caller
  // distinguishes this from "not yet" via its own no-night handling.
  if (utxos.length === 0) {
    return {fee: 0n, available: 0n, rate: 0n, maxAvailable: 0n, affordable: true, secondsUntilAffordable: 0};
  }

  const {fee, dustGenerationEstimations} = await facade.estimateRegistration(utxos);
  return estimateRegistrationAffordability(
    fee,
    dustGenerationEstimations.map((e) => ({
      generatedNow: e.dust.generatedNow,
      rate: e.dust.rate,
      maxCap: e.dust.maxCap,
      registeredForDustGeneration: e.utxo.registeredForDustGeneration,
    })),
  );
}

/** Unshielded NIGHT not yet backing DUST — the set a registration would use.
 *  Gates on unshielded strict-complete only; see designateForDustImpl. */
async function unregisteredNightUtxos(facade: WalletFacade): Promise<UtxoWithMeta[]> {
  const state = await Rx.firstValueFrom(
    facade.state().pipe(Rx.filter((s) => s.unshielded?.progress?.isStrictlyComplete?.() === true)),
  );
  return (state.unshielded.availableCoins as readonly UtxoWithMeta[]).filter(
    (c) => c.utxo.type === NIGHT_TOKEN_ID && !c.meta.registeredForDustGeneration,
  );
}

// Shared body used by both designateForDust(seedHex) and
// designateForDustWithKeys(walletKeys).
async function designateForDustImpl(
  facade: WalletFacade,
  ks: ReturnType<typeof createKeystoreFor>,
  networkId: string,
  receiver: string | undefined,
  onProgress: ((stage: TxStage) => void) | undefined,
  selectedUtxos: NightUtxo[] | undefined,
): Promise<string | null> {
  let utxos: UtxoWithMeta[];
  if (selectedUtxos && selectedUtxos.length > 0) {
    utxos = selectedUtxos.map((u) => u.raw);
  } else {
    // Registration only reads unshielded NIGHT UTXOs; gating on aggregate
    // `isSynced` deadlocks a fresh wallet whose shielded/DUST streams have no
    // events yet (registration itself creates the first DUST event). Shared with
    // estimateDustRegistration so the pre-flight cannot cost a different set
    // from the one the registration actually uses.
    utxos = await unregisteredNightUtxos(facade);
  }

  if (utxos.length === 0) return null;

  onProgress?.('building');

  let dustReceiver: DustAddress | undefined;
  if (receiver) {
    try {
      dustReceiver = MidnightBech32m.parse(receiver).decode(DustAddress, networkId);
    } catch (e) {
      // Never fall back silently: the caller explicitly chose a receiver, and
      // defaulting would quietly send their DUST somewhere they didn't pick.
      throw new Error(
        `Invalid DUST address "${receiver}" for network "${networkId}": ${e instanceof Error ? e.message : e}`
      );
    }
  }

  let recipe;
  try {
    recipe = await facade.registerNightUtxosForDustGeneration(
      utxos,
      ks.getPublicKey(),
      signSegmentFor(ks) as never,
      dustReceiver
    );
  } catch (e) {
    // Registration self-funds from the DUST its NIGHT would already have
    // generated, and that amount starts at zero — so on a freshly funded wallet
    // the SDK refuses before proving. Re-costing tells us whether that is what
    // happened, and by how much: the affordability figures are the ground truth
    // here, not the SDK's message text, which we would otherwise have to match
    // by string and re-match on every SDK release.
    //
    // Only on the failure path, so a registration that was always going to
    // succeed pays nothing for this.
    const estimate = await estimateDustRegistration(facade, selectedUtxos).catch(() => null);
    if (estimate && !estimate.affordable) throw new DustRegistrationNotYetError(estimate, e);
    throw e;
  }

  onProgress?.('proving');
  const finalized = await facade.finalizeRecipe(recipe);

  onProgress?.('submitting');
  return submitWithRetry(facade, finalized);
}

/**
 * Deregister NIGHT UTXOs from DUST generation, using a pre-derived
 * WalletKeys bundle (D-KM-3 path).
 */
export async function dedesignateFromDustWithKeys(
  facade: WalletFacade,
  keys: WalletKeys,
  networkId: string,
  onProgress?: (stage: TxStage) => void,
  selectedUtxos?: NightUtxo[],
): Promise<string> {
  setNetworkId(networkId);
  const ks = createKeystoreFor(keys.nightExternalKey, networkId, keys.signatureKind);
  return dedesignateFromDustImpl(facade, ks, keys, onProgress, selectedUtxos);
}

/**
 * Deregister NIGHT UTXOs from DUST generation.
 * If `selectedUtxos` is provided, deregisters exactly those; otherwise auto-selects
 * all currently registered NIGHT UTXOs.
 */
export async function dedesignateFromDust(
  facade: WalletFacade,
  seedHex: string,
  networkId: string,
  onProgress?: (stage: TxStage) => void,
  selectedUtxos?: NightUtxo[]
): Promise<string> {
  setNetworkId(networkId);
  const keys = deriveKeysFromSeed(seedHex);
  const ks = createKeystoreFor(keys.nightExternalKey, networkId, keys.signatureKind);
  return dedesignateFromDustImpl(facade, ks, keys, onProgress, selectedUtxos);
}

async function dedesignateFromDustImpl(
  facade: WalletFacade,
  ks: ReturnType<typeof createKeystoreFor>,
  keys: WalletKeys,
  onProgress: ((stage: TxStage) => void) | undefined,
  selectedUtxos: NightUtxo[] | undefined,
): Promise<string> {
  let utxos: UtxoWithMeta[];
  if (selectedUtxos && selectedUtxos.length > 0) {
    utxos = selectedUtxos.map((u) => u.raw);
  } else {
    // Gate on unshielded strict-complete only — see designateForDustImpl
    // above for why `s.isSynced` is the wrong predicate here.
    const state = await Rx.firstValueFrom(
      facade.state().pipe(Rx.filter((s) => s.unshielded?.progress?.isStrictlyComplete?.() === true)),
    );
    utxos = (state.unshielded.availableCoins as readonly UtxoWithMeta[]).filter(
      (c) => c.meta.registeredForDustGeneration === true,
    );
  }

  if (utxos.length === 0) throw new Error('No registered NIGHT UTXOs to deregister');

  onProgress?.('building');
  const recipe = await facade.deregisterFromDustGeneration(
    utxos,
    ks.getPublicKey(),
    signSegmentFor(ks) as never,
  );

  const balancedRecipe = await facade.balanceUnprovenTransaction(
    recipe.transaction,
    {shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey},
    {ttl: new Date(Date.now() + 30 * 60_000)}
  );

  onProgress?.('submitting');
  const finalized = await facade.finalizeRecipe(balancedRecipe);
  return submitWithRetry(facade, finalized);
}
