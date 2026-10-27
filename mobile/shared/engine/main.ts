// Moth engine: the API the Swift app calls through `window.moth.<fn>(...)`.
//
// The wallet is moth's extension worker, unmodified (see host.ts); events reach Swift on the
// `moth` script message handler.
import { deserializeActivity } from 'moth-ext/messaging/activity-json';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import { parseNightAmount } from '@shieldedtech/moth-wallet/wallet/night-amount';
import { resolveCardanoNetwork } from '@shieldedtech/moth-wallet/cardano/network';
import { LOVELACE_FOR_REGISTRATION } from '@shieldedtech/moth-wallet/cardano/blueprint';
import { deserializeBalances } from 'moth-ext/messaging/balances-json';
import { addressOn, call, emit, networkConfig, plainBalances, seedOf, sessionOf, sessions, tipHeight } from './host';
import { connector } from './connector';

declare global {
  interface Window {
    moth: typeof api;
  }
}

interface Transfer {
  type: 'shielded' | 'unshielded';
  tokenId: string;
  /** Base units, decimal string. */
  amount: string;
  to: string;
}

const scope = (name: string, network: string) => ({ seedHex: seedOf(name), walletName: name, network: networkConfig(network) });

function cardanoConfig(network: string, blockfrostProjectId?: string) {
  return resolveCardanoNetwork(network, blockfrostProjectId ? { blockfrostProjectId } : {});
}

function mnemonicOf(name: string): string {
  const { mnemonic } = sessionOf(name);
  if (!mnemonic) throw new Error('This wallet was imported from a seed, so it has no Cardano keys.');
  return mnemonic;
}

const api = {
  async list() {
    const wallets = await call('os/walletList', { network: 'preprod' });
    return wallets.map((w) => ({ name: w.name, label: w.label ?? null, network: w.network }));
  },

  /** Creates a wallet with a fresh recovery phrase, which is returned once for backup. */
  async create(name: string, passphrase: string, network: string) {
    const birthday = await tipHeight(network);
    const { info, mnemonic } = await call('os/walletCreate', { name, passphrase, network, birthday });
    return { name: info.name, mnemonic };
  },

  async importPhrase(name: string, mnemonic: string, passphrase: string, network: string) {
    const info = await call('os/walletImport', { name, mnemonic, passphrase, network });
    return { name: info.name };
  },

  setLabel: (name: string, label: string, network: string) => call('os/walletSetLabel', { name, label, network }),

  async remove(name: string, network: string) {
    sessions.delete(name);
    await call('os/walletRemove', { name, network });
  },

  async unlock(name: string, passphrase: string, network: string) {
    const unlocked = await call('os/walletUnlock', { name, passphrase, network });
    const backup = await call('os/walletExportPhrase', { name, passphrase, network, as: 'backup' });
    sessions.set(name, { unlocked, mnemonic: backup.kind === 'mnemonic' ? backup.value : undefined });
    return api.addresses(name, network);
  },

  addresses(name: string, network: string) {
    const { unlocked } = sessionOf(name);
    return {
      name: unlocked.name,
      unshielded: addressOn(unlocked.addresses.nightExternal, network),
      shielded: addressOn(unlocked.addresses.zswap, network),
      dust: addressOn(unlocked.addresses.dust, network),
      nightTokenId: NIGHT_TOKEN_ID,
    };
  },

  /** The recovery phrase (or hex seed, for seed-imported wallets), decrypted with the keystore passphrase. */
  exportPhrase: (name: string, passphrase: string, network: string) =>
    call('os/walletExportPhrase', { name, passphrase, network, as: 'backup' }),

  async lock(name: string) {
    sessions.delete(name);
    connector.rejectAll();
    if (sessions.size === 0) await call('os/syncStop', undefined);
  },

  /** Moves a wallet to another network; both networks' sync caches are kept. */
  async setNetwork(name: string, from: string, to: string) {
    await call('os/syncStop', undefined);
    await call('os/walletSetNetwork', { name, fromNetwork: from, network: to, seedHex: seedOf(name) });
    return api.addresses(name, to);
  },

  sync: (name: string, network: string) => call('os/syncEnsure', scope(name, network)),

  async balances(name: string, network: string) {
    return plainBalances(deserializeBalances(await call('os/balancesGet', scope(name, network))));
  },

  async activity(name: string, network: string) {
    const entries = deserializeActivity(await call('os/activityGet', scope(name, network)));
    return entries.map((e) => ({
      hash: e.hash,
      kind: e.kind,
      status: e.status,
      timestamp: e.timestamp ? e.timestamp.getTime() / 1000 : null,
      deltas: e.deltas.map((d) => ({ tokenType: d.tokenType, kind: d.kind, amount: String(d.amount) })),
      dustDelta: String(e.dustDelta),
      counterparty: e.counterparty,
      fees: e.fees === null ? null : String(e.fees),
      pending: e.pending,
    }));
  },

  estimateFee: (name: string, network: string, requests: Transfer[]) =>
    call('os/estimateTransferFee', { ...scope(name, network), requests }),

  send: (name: string, network: string, requests: Transfer[]) => call('os/sendTokens', { ...scope(name, network), requests }),

  /** `dustAddress` sends the DUST to another account; omitted, it goes to this one. */
  registerDust: (name: string, network: string, dustAddress?: string) =>
    call('os/registerDust', { ...scope(name, network), ...(dustAddress ? { dustAddress } : {}) }),

  deregisterDust: (name: string, network: string) => call('os/deregisterDust', scope(name, network)),

  /** Every account's DUST address on `network`, for choosing where DUST goes; works while they are locked. */
  receiverAccounts: (network: string) => call('os/cardanoReceiverAccounts', { network }),

  /** NIGHT typed by the user ("1.5") to STAR, as a decimal string. Throws on bad input. */
  parseNight: (text: string) => String(parseNightAmount(text)),

  // --- Cardano cNIGHT → DUST ---

  /** Lovelace a registration locks at the mapping validator; deregistering returns it. */
  cardanoRegistrationLovelace: () => String(LOVELACE_FOR_REGISTRATION),

  cardanoAddresses: (name: string, network: string) =>
    call('os/cardanoAddresses', { mnemonic: mnemonicOf(name), config: cardanoConfig(network) }),

  cardanoStatus: (name: string, network: string, projectId: string) =>
    call('os/cardanoStatus', {
      mnemonic: mnemonicOf(name),
      config: cardanoConfig(network, projectId),
      indexerUrl: networkConfig(network).indexerUrl,
    }),

  /** Registers the Cardano stake key's cNIGHT to generate DUST for `receiver`, or this wallet. */
  cardanoRegister: (name: string, network: string, projectId: string, receiver?: string) =>
    call('os/cardanoRegister', {
      mnemonic: mnemonicOf(name),
      config: cardanoConfig(network, projectId),
      receiver: receiver || api.addresses(name, network).dust,
    }),

  /** Points an existing registration's DUST at another DUST address, in one transaction. */
  cardanoUpdate: (name: string, network: string, projectId: string, receiver: string) =>
    call('os/cardanoUpdate', { mnemonic: mnemonicOf(name), config: cardanoConfig(network, projectId), receiver }),

  /** Sends ADA and/or cNIGHT (base units, decimal strings) on Cardano. */
  cardanoSend: (name: string, network: string, projectId: string, to: string, lovelace: string, cnight: string) =>
    call('os/cardanoSend', {
      mnemonic: mnemonicOf(name),
      config: cardanoConfig(network, projectId),
      request: { to, lovelace, cnight },
    }),

  cardanoDeregister: (name: string, network: string, projectId: string) =>
    call('os/cardanoDeregister', { mnemonic: mnemonicOf(name), config: cardanoConfig(network, projectId) }),

  connector,
};

window.moth = api;
// Module scripts can finish after the page's load event, so Swift waits for this instead.
emit({ event: 'ready', data: null });
