// Service-worker side of the offscreen bridge. Creates the offscreen document
// on demand, waits until its handlers are live, then forwards wallet/sync/tx
// work to it. Chrome-only: `chrome.offscreen` has no Firefox equivalent (see
// the README note on Firefox support).

import {
  offscreenSend,
  type TransferRequestDTO,
  type SwapInputDTO,
  type ProvingKeyMaterialDTO,
  type ProvingProviderCheckPayload,
  type ProvingProviderProvePayload,
} from '../offscreen/messaging';
import type { NetworkConfig, SignEncoding } from '@shieldedtech/moth-browser';
import { decodeBigintJson, encodeBigintJson } from '../messaging/bigint-json';

const OFFSCREEN_URL = 'offscreen.html';

// `chrome` is the only surface exposing the offscreen API (the webextension
// polyfill doesn't wrap it).
declare const chrome: {
  offscreen: {
    hasDocument(): Promise<boolean>;
    createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
    closeDocument(): Promise<void>;
    Reason: { WORKERS: string };
  };
};

// The document's lifecycle (create + readiness, and close) runs through ONE
// serialized queue, so an ensure and a close can never interleave: a close that
// lands mid-ensure runs strictly after it, and vice versa. Concurrent ensures
// dedupe naturally — the first creates, the rest see hasDocument() === true and
// just re-ping. Serializing all ensures is cheap because that's all a
// live-document ensure does.
let lifecycle: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn);
  // Keep the chain alive whatever this step's outcome.
  lifecycle = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureImpl(): Promise<void> {
  if (!(await chrome.offscreen.hasDocument())) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Run the wallet sync engine and cryptographic (WASM) operations off the service worker.',
      });
    } catch {
      // "A document already exists" from a race with another context — the
      // readiness ping below is the real gate, so fall through to it.
    }
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await offscreenSend('os/ping', undefined);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error('Offscreen document did not become ready');
}

async function closeImpl(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

/** Ensure the offscreen document exists and its message handlers are ready. */
export function ensureOffscreen(): Promise<void> {
  return enqueue(ensureImpl);
}

/** Close the offscreen document (and with it the worker + WASM heap). The next
 *  ensureOffscreen() recreates and re-pings from scratch. */
export function closeOffscreen(): Promise<void> {
  return enqueue(closeImpl);
}

interface SyncTarget {
  seedHex: string;
  walletName: string;
  network: NetworkConfig;
}

export const offscreen = {
  /** Whether the offscreen document currently exists (advisory — teardown skips
   *  the stop/close work when it's already gone). */
  exists(): Promise<boolean> {
    return chrome.offscreen.hasDocument();
  },
  /** Tear down the offscreen document (kills the worker + WASM heap). */
  close() {
    return closeOffscreen();
  },
  async walletList(network: string) {
    await ensureOffscreen();
    return offscreenSend('os/walletList', { network });
  },
  async walletCreate(data: { name: string; passphrase: string; network: string; birthday?: number; mnemonic?: string }) {
    await ensureOffscreen();
    return offscreenSend('os/walletCreate', data);
  },
  async walletImport(data: {
    name: string;
    mnemonic?: string;
    seed?: string;
    passphrase: string;
    network: string;
  }) {
    await ensureOffscreen();
    return offscreenSend('os/walletImport', data);
  },
  async walletRemove(name: string, network: string) {
    await ensureOffscreen();
    return offscreenSend('os/walletRemove', { name, network });
  },
  async walletSetActive(name: string, network: string) {
    await ensureOffscreen();
    return offscreenSend('os/walletSetActive', { name, network });
  },
  async walletSetLabel(name: string, label: string, network: string) {
    await ensureOffscreen();
    return offscreenSend('os/walletSetLabel', { name, label, network });
  },
  async walletExportPhrase(
    name: string,
    passphrase: string,
    network: string,
    as?: 'backup' | 'seed',
  ) {
    await ensureOffscreen();
    return offscreenSend('os/walletExportPhrase', { name, passphrase, network, as });
  },
  async walletSetNetwork(data: {
    name: string;
    fromNetwork: string;
    network: string;
    seedHex: string;
    /** Chain tip of the network being moved to; see os/walletSetNetwork. */
    birthday?: number;
  }) {
    await ensureOffscreen();
    return offscreenSend('os/walletSetNetwork', data);
  },
  async walletUnlock(name: string, passphrase: string, network: string) {
    await ensureOffscreen();
    return offscreenSend('os/walletUnlock', { name, passphrase, network });
  },
  async syncEnsure(data: SyncTarget) {
    await ensureOffscreen();
    return offscreenSend('os/syncEnsure', data);
  },
  async syncStop() {
    await ensureOffscreen();
    return offscreenSend('os/syncStop', undefined);
  },
  async syncCacheClear(data: { walletName: string; networkIds: string[] }) {
    await ensureOffscreen();
    return offscreenSend('os/syncCacheClear', data);
  },
  async syncCacheReset(data: { walletName: string; network: NetworkConfig }) {
    await ensureOffscreen();
    return offscreenSend('os/syncCacheReset', data);
  },
  async balancesGet(data: SyncTarget) {
    await ensureOffscreen();
    return offscreenSend('os/balancesGet', data);
  },
  async sendTokens(data: SyncTarget & { requests: TransferRequestDTO[] }) {
    await ensureOffscreen();
    return offscreenSend('os/sendTokens', data);
  },
  async estimateTransferFee(data: SyncTarget & { requests: TransferRequestDTO[] }) {
    await ensureOffscreen();
    return offscreenSend('os/estimateTransferFee', data);
  },
  async registerDust(data: SyncTarget & { dustAddress?: string }) {
    await ensureOffscreen();
    return offscreenSend('os/registerDust', data);
  },
  async deregisterDust(data: SyncTarget) {
    await ensureOffscreen();
    return offscreenSend('os/deregisterDust', data);
  },
  async preseedWarm(data: { network: NetworkConfig }) {
    await ensureOffscreen();
    return offscreenSend('os/preseedWarm', data);
  },
  async preseedStatus(data: { network: NetworkConfig }) {
    await ensureOffscreen();
    return offscreenSend('os/preseedStatus', data);
  },
  async nightCoins(data: { seedHex: string; walletName: string; network: NetworkConfig }) {
    await ensureOffscreen();
    return offscreenSend('os/nightCoins', data);
  },
  async requestStats() {
    await ensureOffscreen();
    return offscreenSend('os/requestStats', undefined);
  },
  async resetRequestStats() {
    await ensureOffscreen();
    return offscreenSend('os/requestStatsReset', undefined);
  },
  async relayRetry() {
    await ensureOffscreen();
    return offscreenSend('os/relayRetry', undefined);
  },
  async dustRebuild(data: SyncTarget) {
    await ensureOffscreen();
    return offscreenSend('os/dustRebuild', data);
  },
  async transferBuild(data: SyncTarget & { requests: TransferRequestDTO[] }) {
    await ensureOffscreen();
    return offscreenSend('os/transferBuild', data);
  },
  async transferSubmit(data: SyncTarget & { txHex: string }) {
    await ensureOffscreen();
    return offscreenSend('os/transferSubmit', data);
  },
  async txHistoryGet(data: SyncTarget & { pageNumber: number; pageSize: number }) {
    await ensureOffscreen();
    return offscreenSend('os/txHistoryGet', data);
  },
  async activityGet(data: SyncTarget) {
    await ensureOffscreen();
    return offscreenSend('os/activityGet', data);
  },
  async signData(data: { seedHex: string; network: NetworkConfig; data: string; encoding: SignEncoding }) {
    await ensureOffscreen();
    return offscreenSend('os/signData', data);
  },
  async deriveAppSecret(data: { seedHex: string; origin: string; domain: string }) {
    await ensureOffscreen();
    return offscreenSend('os/deriveAppSecret', data);
  },
  async provingProviderCheck(data: {
    network: NetworkConfig;
    serializedPreimage: Uint8Array;
    keyLocation: string;
    keyMaterial: ProvingKeyMaterialDTO;
  }) {
    await ensureOffscreen();
    const {network, ...payload} = data;
    const resultJson = await offscreenSend('os/provingProviderCheck', {
      network,
      payloadJson: encodeBigintJson(payload satisfies ProvingProviderCheckPayload),
    });
    return decodeBigintJson<(bigint | undefined)[]>(resultJson);
  },
  async provingProviderProve(data: {
    network: NetworkConfig;
    serializedPreimage: Uint8Array;
    keyLocation: string;
    keyMaterial: ProvingKeyMaterialDTO;
    overwriteBindingInput?: bigint;
  }) {
    await ensureOffscreen();
    const {network, ...payload} = data;
    const resultJson = await offscreenSend('os/provingProviderProve', {
      network,
      payloadJson: encodeBigintJson(payload satisfies ProvingProviderProvePayload),
    });
    return decodeBigintJson<Uint8Array>(resultJson);
  },
  async balanceTransaction(data: SyncTarget & { txHex: string; sealed: boolean }) {
    await ensureOffscreen();
    return offscreenSend('os/balanceTransaction', data);
  },
  async makeIntent(data: SyncTarget & { inputs: SwapInputDTO[]; outputs: TransferRequestDTO[]; payFees: boolean }) {
    await ensureOffscreen();
    return offscreenSend('os/makeIntent', data);
  },
};
