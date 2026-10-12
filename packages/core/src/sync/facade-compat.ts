// Facade calls that differ between the v8 and v9 wallet SDKs. The v8 facade
// takes secret keys on every call and trades in ledger transactions; the v9
// facade holds the keys it was started with and trades in WalletTransaction
// handles. Moth code keeps ledger transactions; handles exist only here.

import * as Rx from 'rxjs';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import {activeSdkVersion, sdk} from '../sdk/index.js';

type SecretKeys = {shieldedSecretKeys: unknown; dustSecretKey: unknown};
type Stage = 'Unproven' | 'Unbound' | 'Finalized';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFacade = any;

const isV9 = (): boolean => activeSdkVersion() === 'v9';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const v9Root = (): any => sdk().root;

/**
 * The v9 SDK runs only on networks detected as ledger v9, with single-variant wallets that stamp version 0,
 * so the whole chain is one v9 epoch. Undefined on the v8 SDK, which has no fork schedule.
 */
export function v9ForkSchedule(): {v9: bigint} | undefined {
  return isV9() ? {v9: v9Root().ProtocolVersion.MinSupportedVersion} : undefined;
}

async function activeProtocolVersion(facade: WalletFacade): Promise<bigint> {
  return (await Rx.firstValueFrom((facade as AnyFacade).state() as Rx.Observable<{activeProtocolVersion: bigint}>))
    .activeProtocolVersion;
}

/** Wrap a ledger transaction for the v9 facade; v8 takes it as is. */
async function toFacadeTx(facade: WalletFacade, stage: Stage, tx: unknown): Promise<unknown> {
  if (!isV9() || v9Root().WalletTransaction.is(tx)) return tx;
  return v9Root().WalletTransaction.adopt(stage, tx, await activeProtocolVersion(facade));
}

/** The ledger transaction behind a v9 handle, read in the epoch it was built for. */
export async function toLedgerTx<T>(_facade: WalletFacade, tx: unknown): Promise<T> {
  if (!isV9() || !v9Root().WalletTransaction.is(tx)) return tx as T;
  const {ProtocolVersion, WalletTransaction} = v9Root();
  const range = ProtocolVersion.epochOf((tx as {protocolVersion: bigint}).protocolVersion, v9ForkSchedule()!.v9);
  const result = WalletTransaction.unwrapWithin(tx, range) as {_tag: 'Left'; left: unknown} | {_tag: 'Right'; right: T};
  if (result._tag === 'Left') throw result.left;
  return result.right;
}

export function transferTransaction(facade: WalletFacade, outputs: unknown, keys: SecretKeys, options: object) {
  const f = facade as AnyFacade;
  return isV9() ? f.transferTransaction(outputs, options) : f.transferTransaction(outputs, keys, options);
}

export function initSwap(facade: WalletFacade, inputs: unknown, outputs: unknown, keys: SecretKeys, options: object) {
  const f = facade as AnyFacade;
  return isV9() ? f.initSwap(inputs, outputs, options) : f.initSwap(inputs, outputs, keys, options);
}

export function balanceUnprovenTransaction(facade: WalletFacade, tx: unknown, keys: SecretKeys, options: object) {
  const f = facade as AnyFacade;
  return isV9() ? f.balanceUnprovenTransaction(tx, options) : f.balanceUnprovenTransaction(tx, keys, options);
}

export async function balanceFinalizedTransaction(facade: WalletFacade, tx: unknown, keys: SecretKeys, options: object) {
  const f = facade as AnyFacade;
  return isV9()
    ? f.balanceFinalizedTransaction(await toFacadeTx(facade, 'Finalized', tx), options)
    : f.balanceFinalizedTransaction(tx, keys, options);
}

export async function balanceUnboundTransaction(facade: WalletFacade, tx: unknown, keys: SecretKeys, options: object) {
  const f = facade as AnyFacade;
  return isV9()
    ? f.balanceUnboundTransaction(await toFacadeTx(facade, 'Unbound', tx), options)
    : f.balanceUnboundTransaction(tx, keys, options);
}

export function estimateTransactionFee(facade: WalletFacade, tx: unknown, dustSecretKey: unknown, options: object) {
  const f = facade as AnyFacade;
  return isV9() ? f.estimateTransactionFee(tx, options) : f.estimateTransactionFee(tx, dustSecretKey, options);
}

/** Finalize a recipe and hand back the ledger transaction. */
export async function finalizeRecipe<T>(facade: WalletFacade, recipe: unknown): Promise<T> {
  return toLedgerTx<T>(facade, await (facade as AnyFacade).finalizeRecipe(recipe));
}

/** Submit a finalized ledger transaction. */
export async function submitTransaction(facade: WalletFacade, tx: unknown): Promise<unknown> {
  return (facade as AnyFacade).submitTransaction(await toFacadeTx(facade, 'Finalized', tx));
}
