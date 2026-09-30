// Protocol message handlers — the bridge between UI surfaces and the
// wallet/session/sync services. Wallet CRUD, unlock and transfers are executed
// in the offscreen document (WASM); this layer owns the session and settings.

import { browser } from 'wxt/browser';
// Subpath import (like ./settings): the core barrel drags in WASM, which the
// service worker must not load. IndexerClient is plain fetch.
import { IndexerClient } from '@shieldedtech/moth-wallet/network/indexer-client';
import {
  SUPPORTED_NETWORKS,
  proverConfigsEqual,
  resolveProverConfig,
  serverProver,
  validateNetworkConfig,
} from '@shieldedtech/moth-wallet/types/network';
import { onMessage, type NetworkEndpoints, type SessionStatus } from '../messaging/protocol';
import { endpointOverridesFor, getSettings, updateSettings, getNetworkConfig, parseNodeAuthHeader } from './settings';
import { resolveName } from './name-resolve';
import { saveSession, getSession, clearSession, type Session } from './session';
import { getTokenNames, setTokenName } from './token-names';
import { getAddressBook, saveAddressEntry, removeAddressEntry } from './address-book';
import { offscreen } from './offscreen-client';
import { record as recordTiming, getTimings, clearTimings, setTimingsEnabled, timingsEnabled } from './timings';
import { applyNodeAuthHeader } from './node-auth-header';
import { requireCardano } from './cardano-session';
import { t } from '../i18n';
// Pure config resolution — no Lucid, so it is safe in the service worker.
import { cardanoNetworkFor, explorerTxUrl, resolveCardanoNetwork } from '@shieldedtech/moth-wallet/cardano/network';
import { registerTimingLabel } from '../ui/dust-register-outcome';
import {
  clear as clearStats,
  load as loadStats,
  present as presentStats,
  reconcile as reconcileStats,
  save as saveStats,
} from './retained-request-stats';
import {
  startSync,
  stopSync,
  clearSnapshot,
  getSnapshot,
  beginOp,
  endOp,
  hasOpenPorts,
  hasWorkInFlight,
  broadcastSessionLocked,
  getSetupTabIds,
  teardown,
} from './sync-service';
import {
  armAutoLock,
  clearAutoLock,
  getLastActivity,
  isAutoLockExpired,
  recordActivity,
} from './auto-lock';

function statusFromSession(session: Session): SessionStatus {
  return {
    locked: false,
    walletName: session.walletName,
    walletLabel: session.walletLabel,
    address: session.address,
    addresses: session.addresses,
    network: session.network,
  };
}

async function sessionStatus(): Promise<SessionStatus> {
  const [session, settings] = await Promise.all([getSession(), getSettings()]);
  if (!session) {
    return { locked: true, network: settings.network };
  }
  return {
    locked: false,
    walletName: session.walletName,
    walletLabel: session.walletLabel,
    address: session.address,
    addresses: session.addresses,
    network: settings.network,
  };
}

/**
 * Chain tip height for a network — stored as a new wallet's "birthday" so its
 * first sync can pre-seed at tip instead of scanning from genesis. Best
 * effort: an unreachable indexer must not block wallet creation (the wallet
 * then simply genesis-syncs).
 */
async function chainTip(networkId: string): Promise<number | undefined> {
  try {
    const config = await getNetworkConfig(networkId);
    const block = await new IndexerClient(config.indexerUrl).getBlock();
    return block?.height;
  } catch {
    return undefined;
  }
}

export async function lockNow(): Promise<void> {
  // Clear the session first so callers (and the panel) see the lock instantly.
  // Then tear the whole host down in the background: teardown() awaits the sync
  // engine's final cache write before closing the offscreen document, so the
  // process holding decrypted key material (the seed in worker memory) actually
  // exits rather than lingering. Fire-and-forget keeps locking instant for the
  // UI; the offscreen host serializes the stop against any subsequent start.
  clearAutoLock();
  await clearSnapshot();
  await clearSession();
  void teardown({ force: true });
}

/**
 * Auto-lock tick, invoked by the alarm. Locks the wallet once the configured
 * inactivity window has elapsed. Skips demo mode and defers whenever a
 * transaction op or pending approval is in flight — locking drops the seed and
 * must never interrupt one; the next tick (≤1 min later) retries.
 */
export async function enforceAutoLock(): Promise<void> {
  const session = await getSession();
  if (!session) {
    clearAutoLock();
    return;
  }
  const { autoLockMinutes } = await getSettings();
  if (autoLockMinutes === null) return; // demo mode — never expires
  if (hasWorkInFlight()) return; // don't lock mid-operation; wait for the next tick
  const lastActivityAt = await getLastActivity();
  if (!isAutoLockExpired(lastActivityAt, autoLockMinutes, Date.now())) return;
  await lockNow();
  broadcastSessionLocked();
}

/**
 * Apply network + endpoint edits to the unlocked account. Network and indexer
 * changes are destructive to local sync state and therefore require explicit
 * approval. Node or prover changes restart the engine against its existing
 * cache so the live clients/services use the new configuration.
 */
export async function saveNetworkConfig(data: {
  network: string;
  endpoints: NetworkEndpoints;
  resyncApproved: boolean;
}): Promise<SessionStatus> {
  const { network } = data;
  if (!(SUPPORTED_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`Unsupported network "${network}"`);
  }

  const session = await getSession();
  if (!session) throw new Error('Wallet is locked');

  const previousConfig = await getNetworkConfig(session.network);
  const nextConfig = {
    id: network,
    nodeUrl: data.endpoints.nodeUrl.trim(),
    indexerUrl: data.endpoints.indexerUrl.trim(),
    prover: data.endpoints.prover.type === 'server'
      ? serverProver(data.endpoints.prover.url.trim())
      : data.endpoints.prover,
    // Re-parsed rather than trusted: the value is a credential and reaches this
    // point from the panel, so a malformed name or a value carrying CR/LF is
    // dropped here rather than turned into a header rule.
    ...(parseNodeAuthHeader(data.endpoints.nodeAuthHeader)
      ? { nodeAuthHeader: parseNodeAuthHeader(data.endpoints.nodeAuthHeader) }
      : {}),
  };
  validateNetworkConfig(nextConfig);

  const networkChanged = session.network !== network;
  const indexerChanged = previousConfig.indexerUrl !== nextConfig.indexerUrl;
  const nodeChanged = previousConfig.nodeUrl !== nextConfig.nodeUrl;
  const proverChanged = !proverConfigsEqual(resolveProverConfig(previousConfig), nextConfig.prover);
  const resyncRequired = networkChanged || indexerChanged;
  const restartRequired = resyncRequired || nodeChanged || proverChanged;

  if (resyncRequired && !data.resyncApproved) {
    throw new Error('Resync confirmation required');
  }

  // Before anything reconnects: the rule has to be in place when the relay
  // dials, or the first attempt goes out unauthenticated and is rate-limited.
  await applyNodeAuthHeader(nextConfig.nodeUrl, nextConfig.nodeAuthHeader);

  // Persisted before the engine is touched, and rolled back below if the switch
  // fails: the edit must survive a restart that is slow or never completes.
  const previousSettings = await getSettings();
  await updateSettings({
    network,
    customEndpoints: endpointOverridesFor(network, data.endpoints),
  });

  if (restartRequired) await stopSync();

  try {
    let nextSession = session;
    if (networkChanged) {
      const switched = await offscreen.walletSetNetwork({
        name: session.walletName,
        fromNetwork: session.network,
        network,
        seedHex: session.seedHex,
        // Tip of the network being moved to. Recorded as this wallet's
        // first-existence height there, but only on first arrival and only for
        // wallets created here — see WalletManager.setNetwork for why an
        // imported wallet must never be given one.
        birthday: await chainTip(network),
      });
      nextSession = {
        ...session,
        network,
        address: switched.address,
        addresses: switched.addresses,
      };
    } else if (indexerChanged) {
      await offscreen.syncCacheClear({ walletName: session.walletName, networkIds: [network] });
    }

    if (networkChanged) await saveSession(nextSession);
    if (resyncRequired) await clearSnapshot();
    if (restartRequired) void startSync(nextSession, nextConfig).catch(() => {});
    return statusFromSession(nextSession);
  } catch (error) {
    // The account never moved, so the settings describing it must not claim
    // otherwise. Only the two keys the forward write touched are restored.
    await updateSettings({
      network: previousSettings.network,
      customEndpoints: previousSettings.customEndpoints,
    }).catch(() => {});
    if (restartRequired) void startSync(session, previousConfig).catch(() => {});
    throw error;
  }
}

/**
 * Drop everything cached for the unlocked account on its network and sync again
 * from genesis. The recovery for a local devnet that went down and came back as
 * a new chain: the cached sync state, pending submissions and the network's
 * pre-seed reference all describe the old chain, and the engine has no way to
 * notice on its own beyond failing in ways that name none of this.
 *
 * Same shape as the indexer-change branch of saveNetworkConfig — stop, clear,
 * drop the snapshot so the panel shows the loading screen, restart — and, like
 * it, bracketed as one op so idle teardown cannot close the offscreen document
 * between the clear and the restart. Nothing is spent and nothing on chain
 * changes.
 */
export async function resyncFromScratch(): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Wallet is locked');
  const network = await getNetworkConfig();

  beginOp();
  try {
    await stopSync();
    try {
      await offscreen.syncCacheReset({ walletName: session.walletName, network });
      await clearSnapshot();
    } finally {
      // Whether the clear succeeded or not, the engine must come back: a wallet
      // left stopped looks exactly like a wallet that is stuck.
      void startSync(session, network).catch(() => {});
    }
  } finally {
    endOp();
  }
}

/**
 * Close the transaction timeline.
 *
 * `tx: submitting` is emitted before submitWithRetry, and nothing was recorded
 * after it, so the submission phase had a start and no end: debug.html could
 * show when submission began and never how long it took. That is the phase most
 * worth measuring — submitWithRetry makes up to three attempts with 5s delays,
 * so a submission can silently absorb fifteen seconds or more.
 *
 * Recorded on failure too. A submission that ends in an error still ended, and
 * "when did it give up" is exactly what a timeline is for.
 *
 * The offscreen document emits the stage markers, but recordTiming lives here in
 * the service worker, so the terminal marker is taken where the call resolves.
 * It brackets the whole offscreen round-trip; subtracting the `tx: submitting`
 * marker gives the submission itself.
 */
/**
 * Time a transaction op and record how it ended.
 *
 * `describe` matters more than it looks. This used to log "complete" whenever the
 * call did not throw — but registerDust RESOLVES with `txHash: null` when it
 * finds nothing to register or cannot yet afford the fee. So a wallet that
 * submitted no transaction at all logged "tx: register complete", and a timings
 * log showing two of those was indistinguishable from two real registrations.
 * Anything that can succeed at doing nothing must say so.
 *
 * No transaction hash is recorded: the timings page promises labels and
 * durations only, and a hash is chain-linkable to the wallet.
 */
async function withTxTiming<T>(
  label: string,
  run: () => Promise<T>,
  describe?: (result: T) => string,
): Promise<T> {
  try {
    const result = await run();
    void recordTiming('tx', `tx: ${label} ${describe?.(result) ?? 'complete'}`);
    return result;
  } catch (error) {
    void recordTiming('tx', `tx: ${label} failed`);
    throw error;
  }
}

export function registerHandlers(): void {
  onMessage('walletList', async () => {
    const { network } = await getSettings();
    const [wallets, session] = await Promise.all([offscreen.walletList(network), getSession()]);
    return wallets.map((wallet) =>
      session?.walletName === wallet.name
        ? {
            ...wallet,
            network: session.network,
            address: session.address,
            addresses: session.addresses,
          }
        : wallet,
    );
  });

  onMessage('debugTimings', async () => ({
    enabled: await timingsEnabled(),
    entries: await getTimings(),
  }));

  onMessage('debugTimingsSetEnabled', async ({ data }) => {
    await setTimingsEnabled(data.enabled);
    return { enabled: data.enabled };
  });

  // Not bracketed in beginOp/endOp: it only reads counters.
  //
  // The live meter dies with the offscreen document, which every lock closes, so
  // what it reports is only ever "since the last unlock". The retained baseline
  // carries the rest, and the two are presented as one — otherwise the section
  // disappeared entirely the moment the wallet auto-locked, taking the 403s that
  // prompted the visit with it.
  onMessage('debugRequestStats', async () => {
    const live = await offscreen.requestStats().catch(() => null);
    const retained = reconcileStats(await loadStats(), live);
    await saveStats(retained);
    return presentStats(retained, live, Date.now());
  });

  // Clears the request counters too. They are retained across locks by design,
  // so nothing drops them implicitly — which makes an explicit "start from here"
  // necessary before reproducing a problem.
  // Why the balance and the registerable amount disagree. Answers it in the
  // panel rather than requiring the TUI, which was the only surface showing
  // booked and registered per coin.
  onMessage('dustNightCoins', async () => {
    const session = await getSession();
    if (!session) throw new Error('Wallet is locked');
    const network = await getNetworkConfig();
    return offscreen.nightCoins({ seedHex: session.seedHex, walletName: session.walletName, network });
  });

  onMessage('debugTimingsClear', async () => {
    await clearTimings();
    await clearStats();
    await offscreen.resetRequestStats().catch(() => {});
  });

  onMessage('walletCreate', async ({ data }) => {
    await recordTiming('marker', 'create: start (mnemonic + KDF ahead)');
    const { network } = await getSettings();
    const target = data.network ?? network;
    return offscreen.walletCreate({
      name: data.name,
      passphrase: data.passphrase,
      network: target,
      birthday: data.birthday ?? (await chainTip(target)),
      mnemonic: data.mnemonic,
    });
  });

  onMessage('walletImport', async ({ data }) => {
    const { network } = await getSettings();
    return offscreen.walletImport({
      name: data.name,
      mnemonic: data.mnemonic,
      seed: data.seed,
      passphrase: data.passphrase,
      network: data.network ?? network,
    });
  });

  onMessage('walletRemove', async ({ data }) => {
    const { network } = await getSettings();
    const session = await getSession();
    if (session?.walletName === data.name) await lockNow();
    await offscreen.walletRemove(data.name, network);
  });

  onMessage('walletSetActive', async ({ data }) => {
    const { network } = await getSettings();
    await offscreen.walletSetActive(data.name, network);
  });

  onMessage('walletRename', async ({ data }) => {
    const { network } = await getSettings();
    await offscreen.walletSetLabel(data.name, data.label, network);
    // The unlocked session mirrors the label so status calls stay offscreen-free.
    const session = await getSession();
    if (session?.walletName === data.name) {
      await saveSession({ ...session, walletLabel: data.label.trim() || undefined });
    }
  });

  onMessage('walletExportPhrase', async ({ data }) => {
    const { network } = await getSettings();
    return offscreen.walletExportPhrase(data.name, data.passphrase, network, data.as);
  });

  onMessage('networkConfigSave', ({ data }) => saveNetworkConfig(data));

  onMessage('sessionUnlock', async ({ data }) => {
    await recordTiming('marker', 'unlock: start (keystore decrypt + offscreen + WASM ahead)');
    let settings = await getSettings();
    const unlocked = await offscreen.walletUnlock(data.name, data.passphrase, settings.network);
    // Cardano's CIP-1852 derivation starts from BIP-39 entropy, which the seed
    // cannot be reversed into — so the mnemonic itself has to be captured here,
    // at the one moment the passphrase is in hand. Hex-seed accounts have none;
    // `kind` is what says so, and the Cardano verbs refuse with that reason.
    // Best-effort: a failure here must not cost the user their unlock.
    const backup = await offscreen
      .walletExportPhrase(data.name, data.passphrase, settings.network, 'backup')
      .catch(() => null);
    // Imported Cardano accounts are encrypted under this same passphrase, and
    // this is the only moment it is available. See Session.cardanoImported.
    const cardanoImported = await offscreen
      .cardanoImportedPhrases({
        network: settings.network,
        walletName: data.name,
        passphrase: data.passphrase,
      })
      .catch(() => ({}) as Record<string, string>);
    // Each account lives on its own network: the unlocked account's network
    // becomes the wallet-wide selection.
    if (unlocked.network !== settings.network) {
      settings = await updateSettings({ network: unlocked.network, customEndpoints: null });
    }
    const session: Session = {
      walletName: unlocked.name,
      walletLabel: unlocked.label,
      seedHex: unlocked.seedHex,
      ...(backup?.kind === 'mnemonic' ? { cardanoMnemonic: backup.value } : {}),
      ...(Object.keys(cardanoImported).length > 0 ? { cardanoImported } : {}),
      address: unlocked.address,
      addresses: unlocked.addresses,
      shieldedCoinPublicKey: unlocked.shieldedCoinPublicKey,
      shieldedEncryptionPublicKey: unlocked.shieldedEncryptionPublicKey,
      network: unlocked.network,
      unlockedAt: Date.now(),
    };
    await recordTiming('marker', 'unlock: keys ready (offscreen up, keystore decrypted)');
    await saveSession(session);
    // Fresh session: start the inactivity clock and arm the lock alarm.
    await recordActivity(Date.now());
    armAutoLock(settings.autoLockMinutes);
    await offscreen.walletSetActive(data.name, settings.network).catch(() => {});
    // A panel already has its port open: start syncing right away.
    if (hasOpenPorts()) {
      void getNetworkConfig()
        .then((network) => startSync(session, network))
        .catch(() => {});
    }
    // Resume an opted-in reference build. It takes ~an hour and is expected to be
    // interrupted by the idle teardown, so each unlock picks it up where the last
    // session left off. Fire-and-forget, and after the user's own sync above so it
    // never delays the wallet becoming usable.
    if (settings.preseedWarming) {
      void getNetworkConfig()
        .then((network) => offscreen.preseedWarm({ network }))
        .catch(() => {});
    }
    return sessionStatus();
  });

  onMessage('sessionLock', async () => {
    await lockNow();
  });

  onMessage('activityPing', async () => {
    // Only meaningful while unlocked; a ping from a locked panel is a no-op.
    if (await getSession()) await recordActivity(Date.now());
  });

  onMessage('sessionStatus', () => sessionStatus());

  onMessage('balancesSnapshot', () => getSnapshot());

  onMessage('setupTabFocus', async () => {
    const [tabId] = getSetupTabIds();
    if (tabId === undefined) return;
    const tab = await browser.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
  });

  onMessage('setupTabClose', async () => {
    const ids = getSetupTabIds();
    if (ids.length > 0) await browser.tabs.remove(ids);
  });

  onMessage('sendTokens', async ({ data }) => {
    const session = await getSession();
    if (!session) throw new Error('Wallet is locked');
    const network = await getNetworkConfig();
    beginOp();
    try {
      return await withTxTiming('send', () =>
        offscreen.sendTokens({
          seedHex: session.seedHex,
          walletName: session.walletName,
          network,
          requests: data.outputs,
        }),
      );
    } finally {
      endOp();
    }
  });

  onMessage('estimateTransferFee', async ({ data }) => {
    const session = await getSession();
    if (!session) throw new Error('Wallet is locked');
    const network = await getNetworkConfig();
    beginOp();
    try {
      return await offscreen.estimateTransferFee({
        seedHex: session.seedHex,
        walletName: session.walletName,
        network,
        requests: data.outputs,
      });
    } finally {
      endOp();
    }
  });

  onMessage('registerDust', async ({ data }) => {
    const session = await getSession();
    if (!session) throw new Error('Wallet is locked');
    const network = await getNetworkConfig();
    beginOp();
    try {
      return await withTxTiming(
        'register',
        () =>
          offscreen.registerDust({
            seedHex: session.seedHex,
            walletName: session.walletName,
            network,
            dustAddress: data?.dustAddress,
          }),
        registerTimingLabel,
      );
    } finally {
      endOp();
    }
  });

  onMessage('deregisterDust', async () => {
    const session = await getSession();
    if (!session) throw new Error('Wallet is locked');
    const network = await getNetworkConfig();
    beginOp();
    try {
      return await withTxTiming('deregister', () =>
        offscreen.deregisterDust({
          seedHex: session.seedHex,
          walletName: session.walletName,
          network,
        }),
      );
    } finally {
      endOp();
    }
  });

  // Reference building needs no wallet keys and no unlocked session — the
  // reference is an unfunded throwaway wallet. Deliberately NOT bracketed in
  // beginOp/endOp: it runs for tens of minutes, and holding the wallet open that
  // long would defeat the idle teardown that drops key material. It is expected
  // to be interrupted, and resumes on the next attempt.
  onMessage('preseedWarm', async () => {
    const network = await getNetworkConfig();
    return offscreen.preseedWarm({ network });
  });

  onMessage('preseedStatus', async () => {
    const network = await getNetworkConfig();
    return offscreen.preseedStatus({ network });
  });

  // Not bracketed in beginOp/endOp: it only resets a counter, and the actual
  // dial is made by the SDK's own retry loop on its next turn. Returns null
  // rather than throwing when the offscreen document is down — there is no
  // backoff to clear in that case, and a failed diagnostic button should not
  // surface an error dialog.
  onMessage('relayRetry', async () => {
    try {
      return await offscreen.relayRetry();
    } catch {
      return null;
    }
  });

  onMessage('resyncFromScratch', () => resyncFromScratch());

  // Spends nothing, but brackets the op anyway: it stops and restarts the sync
  // engine, and the service worker must not suspend underneath that.
  onMessage('dustRebuild', async () => {
    const session = await getSession();
    if (!session) throw new Error('Wallet is locked');
    const network = await getNetworkConfig();
    beginOp();
    try {
      return await offscreen.dustRebuild({
        seedHex: session.seedHex,
        walletName: session.walletName,
        network,
      });
    } finally {
      endOp();
    }
  });

  onMessage('activityGet', async () => {
    const session = await getSession();
    if (!session) throw new Error('Wallet is locked');
    const network = await getNetworkConfig();
    beginOp();
    try {
      return await offscreen.activityGet({
        seedHex: session.seedHex,
        walletName: session.walletName,
        network,
      });
    } finally {
      endOp();
    }
  });

  onMessage('tokenNamesGet', () => getTokenNames());

  onMessage('tokenNameSet', ({ data }) => setTokenName(data.tokenId, data.name));

  onMessage('addressBookGet', () => getAddressBook());

  onMessage('addressBookSave', ({ data }) => saveAddressEntry(data));

  onMessage('addressBookRemove', ({ data }) => removeAddressEntry(data.id));

  // ---------------------------------------------------------------------
  // Cardano / cNIGHT
  // ---------------------------------------------------------------------

  /**
   * Resolve the session and the Cardano config together, because every verb
   * needs both and each has its own distinct failure the user can act on.
   */

  /** Session + wallet name, or the locked error. Accounts need no config. */
  const requireCardanoWallet = async () => {
    const session = await getSession();
    if (!session) throw new Error(t('cardano_errorLocked'));
    return { network: session.network, walletName: session.walletName, session };
  };

  onMessage('cardanoAccountList', async () => {
    const { network, walletName } = await requireCardanoWallet();
    return offscreen.cardanoAccountList({ network, walletName });
  });

  onMessage('cardanoAccountAdd', async ({ data }) => {
    const { network, walletName, session } = await requireCardanoWallet();
    // A derived account is an index of the wallet's phrase, so a wallet with
    // no phrase cannot have one. Imports are still available to it.
    if (!session.cardanoMnemonic) throw new Error(t('cardano_errorNoMnemonic'));
    return offscreen.cardanoAccountAdd({ network, walletName, ...(data?.label ? { label: data.label } : {}) });
  });

  onMessage('cardanoAccountImport', async ({ data }) => {
    const { network, walletName } = await requireCardanoWallet();
    const { list, id } = await offscreen.cardanoAccountImport({
      network,
      walletName,
      mnemonic: data.mnemonic,
      passphrase: data.passphrase,
      ...(data.label ? { label: data.label } : {}),
    });
    // Cache the plaintext now. It is only otherwise recoverable at unlock, and
    // the account was just made active — the next Cardano call would fail.
    const session = await getSession();
    if (session) {
      await saveSession({
        ...session,
        cardanoImported: { ...(session.cardanoImported ?? {}), [id]: data.mnemonic.trim().replace(/\s+/g, ' ') },
      });
    }
    return list;
  });

  onMessage('cardanoAccountSelect', async ({ data }) => {
    const { network, walletName } = await requireCardanoWallet();
    return offscreen.cardanoAccountSelect({ network, walletName, id: data.id });
  });

  onMessage('cardanoAccountRename', async ({ data }) => {
    const { network, walletName } = await requireCardanoWallet();
    return offscreen.cardanoAccountRename({ network, walletName, id: data.id, label: data.label });
  });

  onMessage('cardanoAccountRemove', async ({ data }) => {
    const { network, walletName } = await requireCardanoWallet();
    const list = await offscreen.cardanoAccountRemove({ network, walletName, id: data.id });
    const session = await getSession();
    if (session?.cardanoImported?.[data.id]) {
      // Drop the cached phrase with the account it belongs to; leaving it would
      // keep a removed account's key in memory for the rest of the session.
      const { [data.id]: _removed, ...rest } = session.cardanoImported;
      await saveSession({ ...session, cardanoImported: rest });
    }
    return list;
  });

  onMessage('cardanoResolveReceiver', async ({ data }) =>
    offscreen.cardanoResolveReceiver({ input: data.input }),
  );

  onMessage('cardanoReceiverAccounts', async () => {
    const { network } = await requireCardanoWallet();
    return offscreen.cardanoReceiverAccounts({ network });
  });

  onMessage('cardanoAddresses', async () => {
    const { config, mnemonic, accountIndex } = await requireCardano(false);
    return offscreen.cardanoAddresses({ mnemonic, config, accountIndex });
  });

  onMessage('cardanoStatus', async () => {
    const { config, mnemonic, session, accountIndex } = await requireCardano(true);
    const network = await getNetworkConfig();
    const status = await offscreen.cardanoStatus({
      mnemonic,
      config,
      indexerUrl: network.indexerUrl,
      accountIndex,
    });
    return {
      ...status,
      // Compared here rather than offscreen: the session is what knows which
      // account is unlocked, and a registration pointing at some *other*
      // wallet is still a valid registration — just not one that pays you.
      registeredToThisWallet:
        status.registeredDustAddress === session.shieldedCoinPublicKey.replace(/^0x/, '').toLowerCase(),
    };
  });

  onMessage('cardanoRegister', async ({ data }) => {
    const { config, mnemonic, session, accountIndex } = await requireCardano(true);
    // This wallet's own DUST address, serialized — the datum records a DUST
    // address, not the shielded coin public key.
    const ownBech32 = session.addresses?.dust?.bech32m?.[session.network] ?? '';
    if (!data?.dustAddress && !ownBech32) {
      throw new Error(t('cardano_errorNoDustAddress'));
    }
    const receiver =
      data?.dustAddress
      ?? (await offscreen.cardanoResolveReceiver({ input: ownBech32 })).dustAddressBytes;
    const r = await offscreen.cardanoRegister({ mnemonic, config, receiver, accountIndex });
    return { ...r, explorer: explorerTxUrl(config, r.txHash) };
  });

  onMessage('cardanoDeregister', async () => {
    const { config, mnemonic, accountIndex } = await requireCardano(true);
    const r = await offscreen.cardanoDeregister({ mnemonic, config, accountIndex });
    return { ...r, explorer: explorerTxUrl(config, r.txHash) };
  });

  onMessage('cardanoSend', async ({ data }) => {
    const { config, mnemonic, accountIndex } = await requireCardano(true);
    const r = await offscreen.cardanoSend({
      mnemonic,
      config,
      request: { to: data.to, lovelace: data.lovelace, cnight: data.cnight },
      accountIndex,
    });
    return { ...r, explorer: explorerTxUrl(config, r.txHash) };
  });

  onMessage('cardanoUpdate', async ({ data }) => {
    const { config, mnemonic, accountIndex } = await requireCardano(true);
    const r = await offscreen.cardanoUpdate({ mnemonic, config, receiver: data.dustAddress, accountIndex });
    return { ...r, explorer: explorerTxUrl(config, r.txHash) };
  });

  onMessage('settingsGet', () => getSettings());

  onMessage('resolveName', ({ data }) => resolveName(data.name));

  onMessage('settingsSet', async ({ data }) => {
    const before = await getNetworkConfig();
    const next = await updateSettings(data);
    const after = await getNetworkConfig();
    const networkChanged =
      before.id !== after.id ||
      before.nodeUrl !== after.nodeUrl ||
      before.indexerUrl !== after.indexerUrl ||
      !proverConfigsEqual(resolveProverConfig(before), resolveProverConfig(after));
    if (networkChanged) {
      // Setup uses settingsSet while choosing the configuration for a new
      // account. Settings → Network uses networkConfigSave above to keep the
      // active account unlocked and apply the appropriate restart semantics.
      await lockNow();
    } else if ('autoLockMinutes' in data && (await getSession())) {
      // Changing the timeout on an unlocked wallet: re-arm and restart the
      // clock so a shorter window doesn't lock immediately on stale activity.
      await recordActivity(Date.now());
      armAutoLock(next.autoLockMinutes);
    }
    return next;
  });
}
