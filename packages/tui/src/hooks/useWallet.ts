import { useState, useEffect, useCallback, useRef } from 'react';
import { WalletManager, type WalletInfo, type UnlockedWallet, type StorageAdapter, type WalletAddresses, type WalletKeys , chainTip, DEFAULT_NETWORKS, deriveShieldedPublicKeys, mnemonicToSeed} from '@shieldedtech/moth-wallet';
import type { WalletState } from '../types.js';

/**
 * Cardano key material for an unlocked wallet.
 *
 * Kept beside the Midnight key bundle rather than inside it: CIP-1852 derives
 * from BIP-39 entropy, which `unlock()` drops on purpose (D-KM-3), so the
 * mnemonic has to be re-read from the keystore at unlock time and cached for
 * exactly as long as the wallet is unlocked.
 *
 * `mnemonic` is null for a wallet imported from a raw hex seed — one never
 * existed, so it has no Cardano identity at all.
 */
export interface CardanoSecret {
  readonly mnemonic: string | null;
  /** The wallet's own Midnight coin public key: the default DUST receiver. */
  readonly coinPublicKey: string;
}

interface UnlockedEntry {
  wallet: UnlockedWallet;
  addresses: WalletAddresses;
  cardano: CardanoSecret;
}

async function loadCardanoSecret(
  manager: WalletManager,
  name: string,
  passphrase: string,
): Promise<CardanoSecret> {
  const phrase = await manager.exportPhrase(name, passphrase);
  if (phrase.kind !== 'mnemonic') return { mnemonic: null, coinPublicKey: '' };
  const seed = await mnemonicToSeed(phrase.value);
  const seedHex = Array.from(seed).map(b => b.toString(16).padStart(2, '0')).join('');
  seed.fill(0);
  return {
    mnemonic: phrase.value,
    coinPublicKey: deriveShieldedPublicKeys(seedHex).coinPublicKey.replace(/^0x/, '').toLowerCase(),
  };
}

export function useWallet(storage: StorageAdapter) {
  const [manager] = useState(() => new WalletManager(storage));
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [activeWallet, setActiveWallet] = useState<WalletState | null>(null);
  const [loading, setLoading] = useState(true);

  // Session-only cache: name → unlocked wallet. Keys zeroed on lockAll().
  const sessionCache = useRef<Map<string, UnlockedEntry>>(new Map());
  // Track wallets generated this session (eligible for pre-seed optimization)
  const newWallets = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const list = await manager.list();
    setWallets(list);

    const active = list.find(w => w.active);
    if (active) {
      const cached = sessionCache.current.get(active.name);
      setActiveWallet({
        name: active.name,
        address: cached?.wallet.address ?? '(locked)',
        nightBalance: '0',
        dustBalance: '0',
        synced: false,
        syncProgress: 0,
      });
    } else {
      setActiveWallet(null);
    }
    setLoading(false);
  }, [manager]);

  useEffect(() => { refresh(); }, [refresh]);

  const isUnlocked = useCallback((name: string): boolean => {
    return sessionCache.current.has(name);
  }, []);

  const getUnlocked = useCallback((name: string): UnlockedEntry | undefined => {
    return sessionCache.current.get(name);
  }, []);

  const unlock = useCallback(async (name: string, passphrase: string): Promise<UnlockedWallet> => {
    const cached = sessionCache.current.get(name);
    if (cached) return cached.wallet;

    const wallet = await manager.unlock(name, passphrase);
    const cardano = await loadCardanoSecret(manager, name, passphrase);
    sessionCache.current.set(name, { wallet, addresses: wallet.addresses, cardano });

    setActiveWallet(prev => {
      if (prev?.name === name) return { ...prev, address: wallet.address };
      return prev;
    });

    return wallet;
  }, [manager]);

  const lockAll = useCallback(() => {
    for (const [, entry] of sessionCache.current) {
      entry.wallet.lock();
    }
    sessionCache.current.clear();
    setActiveWallet(prev => prev ? { ...prev, address: '(locked)' } : null);
  }, []);

  const lockOne = useCallback((name: string) => {
    const entry = sessionCache.current.get(name);
    if (entry) {
      entry.wallet.lock();
      sessionCache.current.delete(name);
    }
    setActiveWallet(prev => {
      if (prev?.name === name) return { ...prev, address: '(locked)' };
      return prev;
    });
  }, []);

  const generate = useCallback(async (name: string, passphrase: string, network: string) => {
    // Record the chain tip as this wallet's birthday, so its first sync can start
    // from a pre-seed reference rather than walking from genesis. Only wallets
    // generated here get one — importWallet below deliberately passes none, since
    // a restored wallet may hold funds at any height (ADR 0003).
    //
    // Resolved from the network preset rather than any custom endpoints the user
    // has configured: this runs before a connection exists, and it is best-effort
    // anyway — no tip simply means the slow first sync.
    const preset = DEFAULT_NETWORKS[network];
    const birthday = preset ? await chainTip(preset.indexerUrl) : undefined;
    const info = await manager.generate(name, passphrase, network, birthday);
    const wallet = await manager.unlock(name, passphrase);
    sessionCache.current.set(name, {
      wallet,
      addresses: wallet.addresses,
      cardano: await loadCardanoSecret(manager, name, passphrase),
    });
    newWallets.current.add(name);
    await refresh();
    return info;
  }, [manager, refresh]);

  const importWallet = useCallback(async (name: string, mnemonic: string, passphrase: string, network: string) => {
    await manager.import(name, mnemonic, passphrase, network);
    const wallet = await manager.unlock(name, passphrase);
    sessionCache.current.set(name, {
      wallet,
      addresses: wallet.addresses,
      cardano: await loadCardanoSecret(manager, name, passphrase),
    });
    await refresh();
  }, [manager, refresh]);

  const importFromSeed = useCallback(async (name: string, hexSeed: string, passphrase: string, network: string) => {
    await manager.importFromSeed(name, hexSeed, passphrase, network);
    const wallet = await manager.unlock(name, passphrase);
    sessionCache.current.set(name, {
      wallet,
      addresses: wallet.addresses,
      cardano: await loadCardanoSecret(manager, name, passphrase),
    });
    await refresh();
  }, [manager, refresh]);

  const switchWallet = useCallback(async (name: string) => {
    await manager.setActive(name);
    await refresh();
  }, [manager, refresh]);

  const removeWallet = useCallback(async (name: string) => {
    const entry = sessionCache.current.get(name);
    if (entry) {
      entry.wallet.lock();
      sessionCache.current.delete(name);
    }
    await manager.remove(name);
    await refresh();
  }, [manager, refresh]);

  // Daemon write verbs read the typed key bundle. The raw seedHex
  // never escapes walletManager.unlock — see D-KM-3.
  const getActiveWalletKeys = useCallback((): WalletKeys | null => {
    if (!activeWallet) return null;
    const entry = sessionCache.current.get(activeWallet.name);
    return entry?.wallet.walletKeys ?? null;
  }, [activeWallet]);

  /**
   * The active wallet's Cardano secret, or null when nothing is unlocked.
   *
   * Dropped by lockAll / lockOne / removeWallet on the same beat as the
   * Midnight keys — a cached mnemonic outliving the key bundle it belongs to
   * would quietly widen what "locked" means.
   */
  const getActiveCardano = useCallback((): CardanoSecret | null => {
    if (!activeWallet) return null;
    return sessionCache.current.get(activeWallet.name)?.cardano ?? null;
  }, [activeWallet]);

  const isActiveWalletNew = useCallback((): boolean => {
    return activeWallet ? newWallets.current.has(activeWallet.name) : false;
  }, [activeWallet]);

  /**
   * The active wallet's birthday for a SPECIFIC network.
   *
   * Not `activeWallet.birthday`: `list()` resolves that against the wallet's own
   * `meta.network`, so on a different network it returns a height belonging to
   * another chain, or nothing. The sync needs the birthday for the network it is
   * about to sync, or the pre-seed gate never opens.
   */
  const activeWalletBirthdayOn = useCallback(
    async (networkId: string): Promise<number | undefined> => {
      if (!activeWallet) return undefined;
      return manager.birthdayOn(activeWallet.name, networkId);
    },
    [activeWallet, manager],
  );

  return {
    wallets,
    activeWallet,
    loading,
    isUnlocked,
    getUnlocked,
    getActiveWalletKeys,
    getActiveCardano,
    isActiveWalletNew,
    activeWalletBirthdayOn,
    unlock,
    lockAll,
    lockOne,
    generate,
    importWallet,
    importFromSeed,
    switchWallet,
    removeWallet,
    refresh,
    manager,
  };
}
