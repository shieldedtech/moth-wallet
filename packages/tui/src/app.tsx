// Moth TUI — interactive terminal wallet for the Midnight Network
// Screen layouts and navigation patterns inspired by mn-tui (Apache-2.0)
// https://github.com/input-output-hk/arc-mn-tui — see NOTICE for attribution

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Box, useApp, useInput, useWindowSize } from 'ink';
import {
  FilesystemStorageAdapter,
  sendTokensWithKeys,
  designateForDustWithKeys,
  dedesignateFromDustWithKeys,
  listNightUtxos,
  clearSyncCache,
  WarmSyncPool,
  NIGHT_TOKEN_ID,
  DustRegistrationNotYetError,
  type SendRequest,
} from '@shieldedtech/moth-wallet';
import { syncedWalletStub } from './utils/synced-wallet-stub.js';
import { parseNightAmount } from './utils/balance.js';
import { useStackNavigator } from './navigation/index.js';
import type { CompletedOnboarding, OnComplete, OnUnlock } from './navigation/index.js';
import { OnboardingHost, isOnboardingRoute } from './screens/onboarding/index.js';
import { DashboardHub } from './screens/dashboard/index.js';
import { ConfirmationModal } from './components/ConfirmationModal.js';
import { ConfirmationQueue } from '@shieldedtech/moth-wallet';
import { useDaemonHost } from './hooks/useDaemonHost.js';
import type { WalletBalances } from '@shieldedtech/moth-wallet';
import { Send } from './screens/send.js';
import { Deploy } from './screens/deploy.js';
import { Mint } from './screens/mint.js';
import { Contract } from './screens/contract.js';
import { Keys } from './screens/keys.js';
import { Dust } from './screens/dust.js';
import { Network } from './screens/network.js';
import { Logs } from './screens/logs.js';
import { useWallet } from './hooks/useWallet.js';
import { useNetwork } from './hooks/useNetwork.js';
import { useBalance } from './hooks/useBalance.js';
import { useLogs } from './hooks/useLogs.js';
import { useChainStatus } from './hooks/useChainStatus.js';
import { loadSettings, saveSettings, resolveWarmWallets, type TuiSettings } from './settings.js';

export interface AppProps {
  walletName?: string;
  networkId?: string;
}

export function App({ networkId: networkIdProp }: AppProps) {
  const { exit } = useApp();
  const { rows: termHeight } = useWindowSize();
  const nav = useStackNavigator({ name: 'dashboard', params: undefined });
  const inOnboarding = isOnboardingRoute(nav.route.name);
  const [lastLogsSeen, setLastLogsSeen] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [initialNetwork, setInitialNetwork] = useState(networkIdProp ?? 'devnet');
  const [paused, setPaused] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | undefined>();
  const firstRunHandledRef = useRef(false);

  const storage = useMemo(() => new FilesystemStorageAdapter(), []);
  const wallet = useWallet(storage);
  const network = useNetwork(initialNetwork);
  const logs = useLogs();
  const connectNetwork = useCallback(async (id: string) => {
    const settings = await loadSettings(storage).catch(() => null);
    await network.connect(id, settings?.networkOverrides?.[id]);
  }, [network.connect, storage]);
  // getConfig() builds a fresh object per call; memoize on the callback's
  // identity (stable until a network field changes) so effects keyed on the
  // config object — useDaemonHost in particular — don't re-fire every render.
  const networkConfig = useMemo(() => network.getConfig(), [network.getConfig]);
  const chain = useChainStatus(networkConfig);
  const activeWalletKeys = wallet.getActiveWalletKeys();
  // Starts disabled and is given its capacity once settings load (below). Held
  // here rather than inside useBalance because the paths that free key material
  // or clear stored state — locking, removing, clearing a sync cache, quitting —
  // all live in this component and must evict from it. See WarmSyncPool.
  const warmPool = useMemo(() => new WarmSyncPool(0), []);
  const balance = useBalance(activeWalletKeys, networkConfig, logs.info, wallet.activeWallet?.name, wallet.isActiveWalletNew(), wallet.activeWalletBirthdayOn, warmPool);
  const [lastWalletName, setLastWalletName] = useState<string | null>(null);

  // Daemon: keep a ref to the latest WalletBalances snapshot so daemon
  // handlers (which live outside the React render tree) can read current
  // state at call time, not at bind time.
  const balancesRef = useRef<WalletBalances | null>(null);
  balancesRef.current = {
    shielded: balance.shieldedBalances,
    unshielded: balance.unshieldedBalances,
    dust: balance.dustRaw,
    dustGeneration: balance.dustGeneration,
    syncProgress: balance.syncProgress ?? {
      percentage: 0,
      etaSeconds: null,
      slowest: null,
      shieldedSynced: false,
      unshieldedSynced: false,
      dustSynced: false,
    },
    synced: balance.synced,
    coins: balance.coins,
    subProgress: balance.subProgress,
  };
  const confirmationQueue = useMemo(() => new ConfirmationQueue(), []);
  const [hasPendingConfirmation, setHasPendingConfirmation] = useState(false);
  useEffect(() => {
    const sync = () => setHasPendingConfirmation(confirmationQueue.size > 0);
    sync();
    return confirmationQueue.subscribe(sync);
  }, [confirmationQueue]);
  useDaemonHost({
    network: networkConfig,
    walletName: wallet.activeWallet?.name,
    balancesRef,
    getFacade: balance.getFacade,
    getWalletKeys: wallet.getActiveWalletKeys,
    queue: confirmationQueue,
    daemonVersion: '0.1.0',
    logs: { info: logs.info, warn: logs.warn, error: logs.error },
  });

  useEffect(() => {
    loadSettings(storage).then(settings => {
      // loadSettings resolves renamed network ids on both the selection and the
      // override keys, so nothing here has to know about them.
      const targetNetwork = networkIdProp ?? settings.lastNetwork ?? 'devnet';
      setInitialNetwork(targetNetwork);
      network.connect(targetNetwork, settings.networkOverrides?.[targetNetwork]);
      setLastWalletName(settings.lastWallet ?? null);
      const warm = resolveWarmWallets(settings);
      warmPool.setCapacity(warm);
      setSettingsLoaded(true);
      logs.info(`Session started (network: ${targetNetwork}, wallet: ${settings.lastWallet ?? 'none'})`);
      if (warm > 0) logs.info(`Keeping up to ${warm} previously-used wallet${warm === 1 ? '' : 's'} warm for instant switching`);
    }).catch(err => {
      // Storage failure (permissions, corrupt file): surface it and still start
      // with defaults so the app never hangs waiting on settingsLoaded.
      const msg = err instanceof Error ? err.message : String(err);
      logs.error(`Failed to load settings — starting with defaults: ${msg}`);
      const targetNetwork = networkIdProp ?? 'devnet';
      setInitialNetwork(targetNetwork);
      network.connect(targetNetwork);
      setLastWalletName(null);
      // The env override still applies with no settings file to read.
      warmPool.setCapacity(resolveWarmWallets({ warmWallets: 0 }));
      setSettingsLoaded(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const persistSettings = useCallback(async () => {
    if (!settingsLoaded) return;
    try {
      const existing = await loadSettings(storage);
      const settings: TuiSettings = {
        ...existing,
        lastNetwork: network.id,
        lastWallet: wallet.activeWallet?.name ?? null,
      };
      await saveSettings(storage, settings);
    } catch (err) {
      // Non-fatal background write — warn but don't disrupt the session.
      const msg = err instanceof Error ? err.message : String(err);
      logs.warn(`Failed to persist settings: ${msg}`);
    }
  }, [storage, network.id, wallet.activeWallet?.name, settingsLoaded]);

  useEffect(() => { persistSettings(); }, [persistSettings]);

  // Quitting frees key material, and the sync must be stopped first: lockAll()
  // zeroes the dust secret key in WASM, and a dust batch still in flight then
  // throws `Dust secret key was cleared` from replayEventsWithChanges — once per
  // live facade, printed over the exiting terminal. Bounded so a sync that will
  // not settle cannot keep the TUI open.
  const quit = useCallback(() => {
    void (async () => {
      try {
        // Warm facades are still syncing with live keys, so they have to come
        // down with the foreground one — before lockAll() zeroes anything.
        await Promise.all([balance.stop(), warmPool.evictAll(3_000)]);
      } catch {
        /* stopping is best-effort; exiting is not optional */
      }
      wallet.lockAll();
      exit();
    })();
  }, [balance, wallet, warmPool, exit]);

  useEffect(() => {
    // Unmount that did not come through `quit` — Ctrl-C, a crash, the process
    // ending. Ask the sync to stop before freeing the keys. It cannot be awaited
    // in a cleanup, so this narrows the window rather than closing it: a batch
    // already inside the WASM call can still find the key gone. The explicit
    // quit path awaits properly.
    return () => {
      void balance.stop().catch(() => {});
      void warmPool.evictAll().catch(() => {});
      wallet.lockAll();
    };
  }, [wallet.lockAll]); // eslint-disable-line react-hooks/exhaustive-deps

  // Onboarding handler — fired by the wizard's final step. Uses a ref so
  // route params can hold a stable callback while we still see latest state.
  const onboardingHandlerRef = useRef<OnComplete>(() => {});
  onboardingHandlerRef.current = async (state: CompletedOnboarding) => {
    setOnboardingError(undefined);
    try {
      if (state.source === 'random') {
        const info = await wallet.generate(state.name, state.passphrase, state.network);
        nav.replace('onboarding-mnemonic-display', {
          onComplete: onboardingCompleteStable,
          partial: { ...state, generatedMnemonic: info.mnemonic },
        });
      } else if (state.source === 'mnemonic') {
        await wallet.importWallet(state.name, state.seedInput!, state.passphrase, state.network);
        nav.reset('dashboard', undefined);
      } else if (state.source === 'hex') {
        await wallet.importFromSeed(state.name, state.seedInput!, state.passphrase, state.network);
        nav.reset('dashboard', undefined);
      }
      await wallet.switchWallet(state.name);
      if (state.network !== network.id) {
        await connectNetwork(state.network);
      }
      logs.info(`Wallet "${state.name}" created on ${state.network}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOnboardingError(msg);
      logs.error(`Onboarding failed: ${msg}`);
      if (nav.route.name === 'onboarding-initializing') nav.pop();
    }
  };
  const onboardingCompleteStable: OnComplete = useCallback((state) => {
    onboardingHandlerRef.current(state);
  }, []);

  // Unlock handler used by the onboarding-unlock screen. Activates the
  // selected wallet (if needed) and unlocks it; throws on bad passphrase
  // so the screen can show an error.
  const onUnlockHandlerRef = useRef<OnUnlock>(async () => {});
  onUnlockHandlerRef.current = async (name: string, passphrase: string) => {
    // Only the decrypt can fail with a bad passphrase — await it so the
    // screen can show the error, then report success immediately. The
    // activation + network switch (which kicks off the multi-second sync
    // restore) continues in the background; the dashboard renders sync
    // progress as it goes.
    await wallet.unlock(name, passphrase);
    logs.info(`Wallet unlocked: ${name}`);
    void (async () => {
      try {
        if (wallet.activeWallet?.name !== name) {
          await wallet.switchWallet(name);
        }
        const target = wallet.wallets.find(w => w.name === name);
        if (target && target.network !== network.id) {
          await connectNetwork(target.network);
          logs.info(`Switched to network: ${target.network}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logs.error(`Post-unlock activation failed for ${name}: ${msg}`);
      }
    })();
  };
  const onUnlockStable: OnUnlock = useCallback((name, pass) => {
    return onUnlockHandlerRef.current(name, pass);
  }, []);

  // First-run: kick off the right onboarding flow on cold start.
  // No wallets → create flow. Wallets present → pick-and-unlock flow.
  useEffect(() => {
    if (!settingsLoaded || firstRunHandledRef.current) return;
    if (wallet.loading) return;
    if (nav.route.name !== 'dashboard') return;
    firstRunHandledRef.current = true;
    if (wallet.wallets.length === 0) {
      nav.push('onboarding-network', { onComplete: onboardingCompleteStable, partial: {} });
    } else {
      nav.push('onboarding-select', {
        wallets: wallet.wallets,
        lastWallet: lastWalletName,
        onComplete: onboardingCompleteStable,
        onUnlock: onUnlockStable,
      });
    }
  }, [settingsLoaded, wallet.loading, wallet.wallets, lastWalletName, nav, onboardingCompleteStable, onUnlockStable]);

  const unreadLogs = logs.count - lastLogsSeen;

  const walletState = wallet.activeWallet ? {
    ...wallet.activeWallet,
    nightBalance: balance.nightBalance,
    dustBalance: balance.dustBalance,
    synced: balance.synced,
    syncProgress: balance.synced ? 1 : 0,
  } : null;

  // Global hotkeys — Esc walks back through onboarding; Meta combos as before.
  useInput((input, key) => {
    if (key.escape && inOnboarding && nav.canGoBack()) {
      setOnboardingError(undefined);
      nav.pop();
      return;
    }
    if (!key.meta) return;
    if (input === 'q') { quit(); return; }
    if (input === 'p') { setPaused(p => !p); logs.info(paused ? 'Resumed' : 'Paused'); return; }
  });

  // A daemon-issued confirmation takes over the screen until answered.
  // Rendering the modal instead of (not on top of) the current view means
  // its useInput handler is the only one active — the underlying screen
  // can't race with the y/n keystroke. Approving/denying advances the
  // queue and this branch flips back to the dashboard or onboarding view.
  if (hasPendingConfirmation) {
    return (
      <Box flexDirection="column" height={termHeight}>
        <ConfirmationModal queue={confirmationQueue} />
      </Box>
    );
  }

  if (inOnboarding) {
    return (
      <Box flexDirection="column" height={termHeight}>
        <OnboardingHost route={nav.route} nav={nav} initError={onboardingError} />
      </Box>
    );
  }

  const unlocked = walletState ? wallet.isUnlocked(walletState.name) : false;
  const entry = walletState ? wallet.getUnlocked(walletState.name) : undefined;
  const addrs = entry ? {
    unshielded: entry.addresses.nightExternal.bech32m[network.id] ?? '(unknown)',
    shielded: entry.addresses.zswap.bech32m[network.id] ?? '(unknown)',
    dust: entry.addresses.dust.bech32m[network.id] ?? '(unknown)',
  } : undefined;
  return (
    <Box flexDirection="column" height={termHeight}>
      <DashboardHub
        wallet={walletState}
        isUnlocked={unlocked}
        network={network}
        chain={chain}
        paused={paused}
        addresses={addrs}
        shieldedBalances={balance.shieldedBalances}
        unshieldedBalances={balance.unshieldedBalances}
        dustBalance={balance.dustRaw}
        coins={balance.coins}
        subProgress={balance.subProgress}
        unreadLogs={unreadLogs}
        onQuit={quit}
        onViewLogs={() => setLastLogsSeen(logs.count)}
        renderSend={(onBack) => (
          <Send wallet={walletState}
            shieldedBalances={balance.shieldedBalances}
            unshieldedBalances={balance.unshieldedBalances}
            onSend={async (to, amount, shielded, tokenId) => {
              const facade = balance.getFacade();
              if (!facade || !activeWalletKeys) { logs.error('Wallet not synced — unlock and wait for sync'); return; }
              // NIGHT is only the native unshielded token; shielded all-zeros is a custom raw-integer token.
              const isNight = !shielded && tokenId === NIGHT_TOKEN_ID;
              const raw = isNight ? parseNightAmount(amount) : BigInt(amount);
              logs.info(`Transfer ${amount} ${isNight ? 'NIGHT' : tokenId.slice(0, 8)} to ${to.slice(0, 16)}... (shielded: ${shielded})`);
              const req: SendRequest = { type: shielded ? 'shielded' : 'unshielded', tokenId, amount: raw, to };
              const txHash = await sendTokensWithKeys(facade, activeWalletKeys, network.id, [req], (stage) => {
                logs.info(`Send: ${stage}`);
              });
              logs.info(`Transfer submitted: ${txHash}`);
              await balance.refresh();
            }}
            onBack={onBack} />
        )}
        renderDeploy={(onBack) => (
          <Deploy
            onDeploy={async (path, witnesses, projDir) => {
              logs.info(`Deploying ${path}${witnesses ? ` with ${witnesses}` : ''}`);
              const { deployContract, loadContractArtifact } = await import('@shieldedtech/moth-wallet');
              const artifact = await loadContractArtifact(path);
              const walletEntry = wallet.getUnlocked(wallet.activeWallet?.name ?? '');
              if (!walletEntry) throw new Error('Wallet not unlocked');
              const facade = balance.getFacade();
              if (!facade) throw new Error('Wallet not synced — wait for sync to complete');
              const result = await deployContract({
                artifact,
                walletKeys: walletEntry.wallet.walletKeys,
                network: networkConfig,
                syncedWallet: syncedWalletStub(facade),
                witnessPath: witnesses ?? undefined,
                projectDir: projDir ?? undefined,
                onProgress: (stage) => logs.info(`Deploy: ${stage}`),
              });
              logs.info(`Deployed: ${result.contractAddress}`);
              return result.contractAddress ?? result.hash;
            }}
            onBack={onBack} />
        )}
        renderMint={(onBack) => (
          <Mint
            defaultShieldedRecipient={wallet.getUnlocked(wallet.activeWallet?.name ?? '')?.addresses.zswap.bech32m[network.id]}
            defaultUnshieldedRecipient={wallet.getUnlocked(wallet.activeWallet?.name ?? '')?.addresses.nightExternal.bech32m[network.id]}
            onMint={async (addr, amount, shielded, recipient) => {
              const { mintFungibleToken } = await import('@shieldedtech/moth-wallet');
              const walletEntry = wallet.getUnlocked(wallet.activeWallet?.name ?? '');
              if (!walletEntry) throw new Error('Wallet not unlocked');
              const facade = balance.getFacade();
              if (!facade) throw new Error('Wallet not synced — wait for sync to complete');
              logs.info(`Minting ${amount} ${shielded ? 'shielded' : 'unshielded'} token(s) on ${addr.slice(0, 16)}… → ${recipient.slice(0, 16)}…`);
              const result = await mintFungibleToken({
                contractAddress: addr,
                recipientAddress: recipient,
                amount: BigInt(amount),
                shielded,
                keys: walletEntry.wallet.keys,
                walletKeys: walletEntry.wallet.walletKeys,
                network: networkConfig,
                syncedWallet: syncedWalletStub(facade),
              });
              logs.info(`Mint submitted: ${result.hash}`);
              await balance.refresh();
            }}
            onDeployFT={async () => {
              const { deployFungibleToken } = await import('@shieldedtech/moth-wallet');
              const walletEntry = wallet.getUnlocked(wallet.activeWallet?.name ?? '');
              if (!walletEntry) throw new Error('Wallet not unlocked');
              const facade = balance.getFacade();
              if (!facade) throw new Error('Wallet not synced — wait for sync to complete');
              logs.info('Auto-deploying fungible token contract...');
              const result = await deployFungibleToken({
                walletKeys: walletEntry.wallet.walletKeys,
                network: networkConfig,
                syncedWallet: syncedWalletStub(facade),
                onProgress: (stage) => logs.info(`Deploy FT: ${stage}`),
              });
              const address = result.contractAddress ?? result.hash;
              logs.info(`FT contract deployed: ${address}`);
              return address;
            }}
            onBack={onBack} />
        )}
        renderContract={(onBack) => (
          <Contract indexerUrl={network.indexerUrl} onBack={onBack} />
        )}
        renderKeys={(onBack) => (
          <Keys
            wallets={wallet.wallets}
            isUnlocked={wallet.isUnlocked}
            getAddresses={(name) => {
              const e = wallet.getUnlocked(name);
              if (!e) return null;
              const w = wallet.wallets.find(x => x.name === name);
              const net = w?.network ?? network.id;
              return {
                unshielded: e.addresses.nightExternal.bech32m[net] ?? '(unknown)',
                shielded: e.addresses.zswap.bech32m[net] ?? '(unknown)',
                dust: e.addresses.dust.bech32m[net] ?? '(unknown)',
              };
            }}
            onUnlock={async (name, pass) => {
              // Await only the decrypt (bad-passphrase errors surface on the
              // screen); activation + network switch continue in the
              // background so the unlock prompt isn't held hostage by the
              // sync-cache restore.
              await wallet.unlock(name, pass);
              logs.info(`Wallet unlocked: ${name}`);
              void (async () => {
                try {
                  if (wallet.activeWallet?.name !== name) {
                    await wallet.switchWallet(name);
                    logs.info(`Switched to wallet: ${name}`);
                  }
                  const target = wallet.wallets.find(w => w.name === name);
                  if (target && target.network !== network.id) {
                    await connectNetwork(target.network);
                    logs.info(`Switched to network: ${target.network}`);
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  logs.error(`Post-unlock activation failed for ${name}: ${msg}`);
                }
              })();
            }}
            onLock={async (name) => {
              // Take the syncs down FIRST: lockOne zeroes this wallet's keys in
              // WASM, and anything still syncing with them throws `Dust secret
              // key was cleared` mid-batch — from a warm facade nobody is
              // watching, or from the foreground one. Same ordering as quit.
              await Promise.all([
                warmPool.evictWallet(name),
                wallet.activeWallet?.name === name ? balance.stop() : Promise.resolve(),
              ]);
              wallet.lockOne(name);
              logs.info(`Wallet locked: ${name}`);
            }}
            onSwitch={async (name) => {
              await wallet.switchWallet(name);
              logs.info(`Switched to wallet: ${name}`);
              const target = wallet.wallets.find(w => w.name === name);
              if (target && target.network !== network.id) {
                await connectNetwork(target.network);
                logs.info(`Switched to network: ${target.network}`);
              }
            }}
            onRemove={async (name) => {
              await warmPool.evictWallet(name);
              await wallet.removeWallet(name);
              logs.info(`Wallet removed: ${name}`);
            }}
            onClearCache={(name) => {
              // A warm facade for this wallet would rewrite the entries on its
              // next save, so the clear has to take it down first or it silently
              // does nothing.
              void warmPool.evictWallet(name, network.id)
                .then(() => clearSyncCache(name, network.id))
                .then(() => {
                  logs.info(`Sync cache cleared for ${name} on ${network.id}`);
                });
            }}
            onCreateNew={() => {
              nav.push('onboarding-network', { onComplete: onboardingCompleteStable, partial: {} });
            }}
            onBack={onBack} />
        )}
        renderDust={(onBack) => (
          <Dust
            dustAddress={addrs?.dust ?? ''}
            // DUST registration only reads unshielded NIGHT UTXOs (see
            // designateForDust), so gate on the unshielded sub-wallet being
            // synced — not the aggregate `synced`, which never completes for a
            // fresh NIGHT-only wallet whose empty shielded/DUST streams never
            // reach strict completion.
            synced={balance.syncProgress?.unshieldedSynced ?? balance.synced}
            syncStatus={balance.syncStatus}
            loadUtxos={async () => {
              const facade = balance.getFacade();
              if (!facade) throw new Error('Wallet not synced — wait for sync to complete');
              return listNightUtxos(facade);
            }}
            onRegister={async (utxos, receiver) => {
              const facade = balance.getFacade();
              if (!facade || !activeWalletKeys) return { success: false, error: 'Wallet not synced' };
              logs.info(`Registering ${utxos.length} UTXO(s) for DUST${receiver ? ` (receiver: ${receiver.slice(0, 20)}...)` : ''}`);
              try {
                const txHash = await designateForDustWithKeys(
                  facade, activeWalletKeys, network.id, receiver,
                  (s) => logs.info(`DUST register: ${s}`),
                  utxos,
                );
                if (!txHash) return { success: false, error: 'No UTXOs registered' };
                logs.info(`DUST registration submitted: ${txHash}`);
                await balance.refresh();
                return { success: true, txId: txHash };
              } catch (err) {
                // Registration self-funds from the DUST its NIGHT would already
                // have generated, and that amount starts at zero — so on a
                // freshly funded wallet this is "not yet", not a failure.
                // Nothing was built, booked or spent. The panel and the CLI both
                // say so; without this the TUI showed the raw SDK message, which
                // reads as a broken wallet.
                if (err instanceof DustRegistrationNotYetError) {
                  logs.info(`DUST registration not possible yet: ${err.message}`);
                  return { success: false, error: err.message };
                }
                const msg = err instanceof Error ? err.message : String(err);
                logs.error(`DUST register failed: ${msg}`);
                return { success: false, error: msg };
              }
            }}
            onDeregister={async (utxos) => {
              const facade = balance.getFacade();
              if (!facade || !activeWalletKeys) return { success: false, error: 'Wallet not synced' };
              logs.info(`Deregistering ${utxos.length} UTXO(s) from DUST`);
              try {
                const txHash = await dedesignateFromDustWithKeys(
                  facade, activeWalletKeys, network.id,
                  (s) => logs.info(`DUST deregister: ${s}`),
                  utxos,
                );
                logs.info(`DUST deregistration submitted: ${txHash}`);
                await balance.refresh();
                return { success: true, txId: txHash };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logs.error(`DUST deregister failed: ${msg}`);
                return { success: false, error: msg };
              }
            }}
            onBack={onBack} />
        )}
        renderNetwork={(onBack) => (
          <Network network={network}
            onSwitch={(id) => {
              void connectNetwork(id).then(() => {
                logs.info(`Switched to network: ${id}`);
              });
            }}
            onSaveOverrides={async (netId, overrides) => {
              try {
                const settings = await loadSettings(storage);
                settings.networkOverrides = settings.networkOverrides ?? {};
                settings.networkOverrides[netId] = {
                  ...settings.networkOverrides[netId],
                  ...overrides,
                };
                await saveSettings(storage, settings);
                logs.info(`Network overrides saved for ${netId}`);
                network.connect(netId, settings.networkOverrides[netId]);
              } catch (err) {
                // User-initiated save — surface the failure as an error.
                const msg = err instanceof Error ? err.message : String(err);
                logs.error(`Failed to save network overrides for ${netId}: ${msg}`);
              }
            }}
            onBack={onBack} />
        )}
        renderLogs={(onBack) => (
          <Logs entries={logs.entries} onClear={logs.clear} onBack={onBack} />
        )}
      />
    </Box>
  );
}
