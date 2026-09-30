// The single method → wallet-host mapping, shared by the production worker entry
// (wallet-worker.ts) and the dev inline fallback (worker-bridge.ts). Each entry
// mirrors the corresponding handler body that used to live in
// entrypoints/offscreen/main.ts.
//
// `wallet-host` is imported as a TYPE only — the concrete module (with its WASM)
// is passed in at call time, so this module carries no heavy runtime import and
// stays safe to load anywhere (including the vitest node env, for HOST_METHODS).
//
// The `Dispatch` mapped type is checked key-by-key against the protocol, so a
// method added to (or removed from) OffscreenProtocol fails compilation here.

import type { HostMethod, MethodData, MethodResult } from './worker-rpc';
import { decodeBigintJson, encodeBigintJson } from '../messaging/bigint-json';
import type {
  ProvingProviderCheckPayload,
  ProvingProviderProvePayload,
} from './messaging';
// Safe to import for real, unlike `wallet-host`: every Cardano entry point in
// there imports Lucid dynamically, so this module still loads no WASM.
import * as cardano from './cardano-host';

type Host = typeof import('./wallet-host');
type Dispatch = {
  [M in HostMethod]: (host: Host, data: MethodData<M>) => Promise<MethodResult<M>> | MethodResult<M>;
};

export const hostDispatch: Dispatch = {
  // walletList wraps an already-async wallets.list() — flatten the extra Promise.
  'os/walletList': async (host, d) => host.walletList(d.network),
  'os/walletCreate': (host, d) => host.walletCreate(d.name, d.passphrase, d.network, d.birthday, d.mnemonic),
  'os/walletImport': (host, d) => host.walletImport(d.name, {mnemonic: d.mnemonic, seed: d.seed}, d.passphrase, d.network),
  'os/walletRemove': (host, d) => host.walletRemove(d.name, d.network),
  'os/walletSetActive': (host, d) => host.walletSetActive(d.name, d.network),
  'os/walletSetLabel': (host, d) => host.walletSetLabel(d.name, d.label, d.network),
  'os/walletExportPhrase': (host, d) => host.walletExportPhrase(d.name, d.passphrase, d.network, d.as),
  'os/walletSetNetwork': (host, d) => host.walletSetNetwork(d.name, d.fromNetwork, d.network, d.seedHex),
  'os/cardanoAccountList': (host, d) => host.cardanoAccountList(d.network, d.walletName),
  'os/cardanoAccountAdd': (host, d) => host.cardanoAccountAdd(d.network, d.walletName, d.label),
  'os/cardanoAccountImport': (host, d) =>
    host.cardanoAccountImport(d.network, d.walletName, d.mnemonic, d.passphrase, d.label),
  'os/cardanoAccountSelect': (host, d) => host.cardanoAccountSelect(d.network, d.walletName, d.id),
  'os/cardanoAccountRemove': (host, d) => host.cardanoAccountRemove(d.network, d.walletName, d.id),
  'os/cardanoAccountRename': (host, d) =>
    host.cardanoAccountRename(d.network, d.walletName, d.id, d.label),
  'os/cardanoImportedPhrases': (host, d) =>
    host.cardanoImportedPhrases(d.network, d.walletName, d.passphrase),
  'os/cardanoResolveReceiver': (host, d) => host.cardanoResolveReceiver(d.input),
  'os/cardanoReceiverAccounts': (host, d) => host.cardanoReceiverAccounts(d.network),
  'os/cardanoAddresses': (_host, d) => cardano.cardanoAddresses(d.mnemonic, d.config, d.accountIndex),
  'os/cardanoStatus': (_host, d) => cardano.cardanoStatus(d.mnemonic, d.config, d.indexerUrl, d.accountIndex),
  'os/cardanoRegister': (_host, d) => cardano.cardanoRegister(d.mnemonic, d.config, d.receiver, d.accountIndex),
  'os/cardanoDeregister': (_host, d) => cardano.cardanoDeregister(d.mnemonic, d.config, d.accountIndex),
  'os/cardanoSend': (_host, d) => cardano.cardanoSend(d.mnemonic, d.config, d.request, d.accountIndex),
  'os/cardanoUpdate': (_host, d) => cardano.cardanoUpdate(d.mnemonic, d.config, d.receiver, d.accountIndex),
  'os/walletUnlock': (host, d) => host.walletUnlock(d.name, d.passphrase, d.network),
  // startWalletSync resolves a SyncedWallet, which isn't structured-cloneable —
  // await it and return void (the protocol result type).
  'os/syncEnsure': async (host, d) => {
    await host.syncEnsure(d.seedHex, d.walletName, d.network);
  },
  'os/syncStop': (host) => host.syncStop(),
  'os/syncCacheClear': (host, d) => host.syncCacheClear(d.walletName, d.networkIds),
  'os/syncCacheReset': (host, d) => host.syncCacheReset(d.walletName, d.network),
  'os/balancesGet': (host, d) => host.balancesGet(d.seedHex, d.walletName, d.network),
  'os/sendTokens': (host, d) => host.sendTokens(d.seedHex, d.walletName, d.network, d.requests),
  'os/estimateTransferFee': (host, d) =>
    host.estimateTransferFee(d.seedHex, d.walletName, d.network, d.requests),
  'os/registerDust': (host, d) => host.registerDust(d.seedHex, d.walletName, d.network, d.dustAddress),
  'os/deregisterDust': (host, d) => host.deregisterDust(d.seedHex, d.walletName, d.network),
  'os/preseedWarm': (host, d) => host.preseedWarm(d.network),
  'os/preseedStatus': (host, d) => host.preseedStatus(d.network),
  'os/relayRetry': (host) => host.relayRetry(),
  'os/nightCoins': (host, data) => host.nightCoins(data.seedHex, data.walletName, data.network),
  'os/requestStats': (host) => host.requestStats(),
  'os/requestStatsReset': (host) => host.resetRequestStats(),
  'os/dustRebuild': (host, d) => host.dustRebuild(d.seedHex, d.walletName, d.network),
  'os/transferBuild': (host, d) => host.transferBuild(d.seedHex, d.walletName, d.network, d.requests, d.payFees),
  'os/transferSubmit': (host, d) => host.transferSubmit(d.seedHex, d.walletName, d.network, d.txHex),
  'os/txHistoryGet': (host, d) => host.txHistoryGet(d.seedHex, d.walletName, d.network, d.pageNumber, d.pageSize),
  'os/activityGet': (host, d) => host.activityGet(d.seedHex, d.walletName, d.network),
  'os/signData': (host, d) => host.signData(d.seedHex, d.network, d.data, d.encoding),
  'os/deriveAppSecret': (host, d) => host.deriveAppSecret(d.seedHex, d.origin, d.domain),
  'os/provingProviderCheck': async (host, d) => {
    const payload = decodeBigintJson<ProvingProviderCheckPayload>(d.payloadJson);
    const result = await host.provingProviderCheck(
      d.network,
      payload.serializedPreimage,
      payload.keyLocation,
      payload.keyMaterial,
    );
    return encodeBigintJson(result);
  },
  'os/provingProviderProve': async (host, d) => {
    const payload = decodeBigintJson<ProvingProviderProvePayload>(d.payloadJson);
    const result = await host.provingProviderProve(
      d.network,
      payload.serializedPreimage,
      payload.keyLocation,
      payload.keyMaterial,
      payload.overwriteBindingInput,
    );
    return encodeBigintJson(result);
  },
  'os/balanceTransaction': (host, d) =>
    host.balanceTransaction(d.seedHex, d.walletName, d.network, d.txHex, d.sealed, d.payFees),
  'os/makeIntent': (host, d) =>
    host.makeIntent(d.seedHex, d.walletName, d.network, d.inputs, d.outputs, d.payFees),
  'os/txSummary': (host, d) => host.txSummary(d.network, d.txHex, d.sealed),
};

export const HOST_METHODS = Object.keys(hostDispatch) as HostMethod[];
