import type { StorageAdapter } from '../storage/adapter.js';
import type { WalletInfo, UnlockedWallet, DerivedKeys, WalletAddresses, AddressEncoding } from '../types/wallet.js';
import { WalletError } from '../types/errors.js';
import { generateMnemonic24, validateMnemonic, mnemonicToSeed, hexSeedToUint8Array } from './mnemonic.js';
import { encryptKeystore, decryptKeystore, keystoreNeedsUpgrade, type EncryptedKeystore } from './keystore.js';
import { deriveAllAddressesFromSeed, deriveRawKeys, Roles } from './address.js';
import { deriveWalletKeys, type WalletKeys } from '../sync/operations.js';
import { removeWalletSyncArtifacts } from '../sync/wallet-sync.js';
import type { SyncStateStore } from '../sync/sync-store.js';

const CONFIG_KEY = 'config.json';

interface WalletConfig {
  activeWallet: string | null;
  wallets: string[];
  defaultNetwork: string;
  configVersion: number;
}

const DEFAULT_CONFIG: WalletConfig = {
  activeWallet: null,
  wallets: [],
  defaultNetwork: 'devnet',
  configVersion: 1,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function walletKey(name: string): string {
  return `wallets/${name}.keystore`;
}

// Unencrypted metadata — name, network, and the public receive address. The
// bech32m address is public (it's what you hand out to receive funds), so it's
// safe to store in the clear; it lets the wallet list show a real address
// without unlocking. No private keys or seed material are stored here.
function metaKey(name: string): string {
  return `wallets/${name}.meta`;
}

interface WalletMeta {
  name: string;
  network: string;
  createdAt: string;
  /** Public night receive address (bech32m). Absent for wallets created before this field existed. */
  address?: string;
  /**
   * Chain tip height at creation, for the network the wallet was created on.
   * Superseded by `birthdays`; kept so wallets written before that field are
   * still readable, and migrated on first load. Never written for new wallets.
   * @deprecated use `birthdays`
   */
  birthday?: number;
  /**
   * First-existence height PER network: the chain tip when this wallet first
   * arrived on that network.
   *
   * Per-network because heights are not comparable across chains, and because a
   * single value is destroyed by a network switch — which used to mean a
   * switched wallet had no birthday at all, so the pre-seed guard
   * (`reference.height <= birthday`) could never pass and every sync after a
   * switch walked from genesis.
   *
   * Only ever recorded for wallets this manager CREATED, and only on first
   * arrival at a network, where "no activity before this height" is a fact
   * rather than an assumption. See `createdHere`.
   */
  birthdays?: Record<string, number>;
  /**
   * True when this wallet was generated here, false when it was imported from a
   * mnemonic or seed.
   *
   * An imported wallet may have history on any chain at any height, so it must
   * never be given a birthday — it has to scan from genesis to be sure of its
   * own funds. That distinction used to be implied by `birthday` being present
   * (generate set it, import did not); splitting birthdays per network dissolves
   * that signal, so it is recorded explicitly.
   *
   * Absent on wallets written before this field existed. Those are treated as
   * imported — the conservative reading, since guessing "created" for a restored
   * wallet would let it skip its own history.
   */
  createdHere?: boolean;
  /** User-chosen display label. The `name` stays the immutable storage key. */
  label?: string;
}

/**
 * Read the per-network birthday, migrating the legacy single value.
 *
 * The old `birthday` belonged to whichever network the wallet was on when it
 * was written, which is `meta.network` — it was discarded on any switch, so a
 * stored one cannot refer to anywhere else.
 */
function birthdayFor(meta: WalletMeta, network: string): number | undefined {
  if (meta.birthdays && meta.birthdays[network] !== undefined) return meta.birthdays[network];
  if (meta.birthday !== undefined && meta.network === network) return meta.birthday;
  return undefined;
}

export class WalletManager {
  private readonly storage: StorageAdapter;
  private readonly syncStore?: SyncStateStore;

  /**
   * `syncStore` is the store this surface keeps its serialized sync state in,
   * and is only used by `remove()` to clean it up. Optional because on node the
   * default resolution (the fs-backed `~/.moth/sync` store) is already the
   * right one — but in the browser it resolves to a volatile in-memory store,
   * so a surface backed by IndexedDB MUST pass its own or removal silently
   * cleans nothing. See `remove()`.
   */
  constructor(storage: StorageAdapter, syncStore?: SyncStateStore) {
    this.storage = storage;
    this.syncStore = syncStore;
  }

  private async loadConfig(): Promise<WalletConfig> {
    const data = await this.storage.read(CONFIG_KEY);
    // Deep-copy the default: a shallow `{ ...DEFAULT_CONFIG }` shares the
    // `wallets` array with the module-level constant, so the first generate()
    // on empty storage would push into DEFAULT_CONFIG itself and every later
    // fresh manager would then see that wallet as already existing.
    if (!data) return { ...DEFAULT_CONFIG, wallets: [...DEFAULT_CONFIG.wallets] };
    return JSON.parse(decoder.decode(data)) as WalletConfig;
  }

  private async saveConfig(config: WalletConfig): Promise<void> {
    await this.storage.write(CONFIG_KEY, encoder.encode(JSON.stringify(config, null, 2)));
  }

  private async saveMeta(meta: WalletMeta): Promise<void> {
    await this.storage.write(metaKey(meta.name), encoder.encode(JSON.stringify(meta)));
  }

  private async loadMeta(name: string): Promise<WalletMeta | null> {
    const data = await this.storage.read(metaKey(name));
    if (!data) return null;
    return JSON.parse(decoder.decode(data)) as WalletMeta;
  }

  /**
   * Config entries whose keystore is actually present.
   *
   * The config is an index of accounts; the keystore is the account. An entry
   * without one cannot be unlocked, renamed or exported — every operation on it
   * fails — yet it still occupies the name and still counts towards "does this
   * profile have any accounts?". A single such entry is a wallet with no way
   * back in: the panel offers Unlock for a keystore that no passphrase can
   * match, and never the "no accounts yet" screen, which needs an EMPTY list.
   *
   * Removal now writes the index before deleting what it points at, so this
   * state is no longer produced. It reads through here rather than being
   * repaired in place because profiles that already reached it are stranded, and
   * a read that skips the entry lets them recover on their own: the account list
   * goes empty, onboarding returns, and creating an account under the same name
   * succeeds instead of colliding with a ghost.
   */
  private async presentWallets(config: WalletConfig): Promise<string[]> {
    const present: string[] = [];
    for (const name of config.wallets) {
      if (await this.storage.exists(walletKey(name))) present.push(name);
    }
    return present;
  }

  /** Whether `name` is taken by an account that actually exists. */
  private async nameTaken(config: WalletConfig, name: string): Promise<boolean> {
    return config.wallets.includes(name) && (await this.storage.exists(walletKey(name)));
  }

  private validateName(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new WalletError('WALLET_ERROR', `Invalid wallet name "${name}": must match [a-zA-Z0-9_-]+`);
    }
  }

  private seedToHex(seed: Uint8Array): string {
    return Array.from(seed).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  private deriveAddressesFromSeed(seedHex: string): WalletAddresses {
    return deriveAllAddressesFromSeed(seedHex);
  }

  /** Public night receive address, preferring the wallet's own network. */
  private primaryAddress(addresses: WalletAddresses, network?: string): string {
    const bech32m = addresses.nightExternal.bech32m;
    return (
      (network ? bech32m[network] : undefined) ??
      bech32m['devnet'] ??
      bech32m['preprod'] ??
      Object.values(bech32m)[0] ??
      ''
    );
  }

  async generate(
    name: string,
    passphrase: string,
    network = 'devnet',
    birthday?: number,
    // Optionally persist a caller-supplied phrase instead of a fresh one. The
    // setup flow shows the words before asking for a password, then hands the
    // same phrase back here so the stored wallet matches what the user wrote down.
    mnemonic?: string,
  ): Promise<WalletInfo & { mnemonic: string }> {
    this.validateName(name);
    const config = await this.loadConfig();

    if (await this.nameTaken(config, name)) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" already exists`);
    }

    if (mnemonic !== undefined && !validateMnemonic(mnemonic)) {
      throw new WalletError('INVALID_INPUT', 'Invalid BIP-39 mnemonic');
    }
    const phrase = mnemonic ?? generateMnemonic24();
    const seed = await mnemonicToSeed(phrase);
    const seedHex = this.seedToHex(seed);
    const addresses = this.deriveAddressesFromSeed(seedHex);
    const address = this.primaryAddress(addresses, network);

    const keystore = await encryptKeystore(phrase, passphrase);
    await this.storage.write(walletKey(name), encoder.encode(JSON.stringify(keystore)));

    const meta: WalletMeta = {
      name,
      network,
      createdAt: new Date().toISOString(),
      address,
      createdHere: true,
      ...(birthday !== undefined ? { birthdays: { [network]: birthday } } : {}),
    };
    await this.saveMeta(meta);

    if (!config.wallets.includes(name)) config.wallets.push(name);
    if (!config.activeWallet) config.activeWallet = name;
    await this.saveConfig(config);

    seed.fill(0);

    return { name, address, addresses, network, active: config.activeWallet === name, mnemonic: phrase, birthday };
  }

  async import(name: string, mnemonic: string, passphrase: string, network = 'devnet'): Promise<WalletInfo> {
    this.validateName(name);

    if (!validateMnemonic(mnemonic)) {
      throw new WalletError('INVALID_INPUT', 'Invalid BIP-39 mnemonic');
    }

    const config = await this.loadConfig();
    if (await this.nameTaken(config, name)) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" already exists`);
    }

    const seed = await mnemonicToSeed(mnemonic);
    const seedHex = this.seedToHex(seed);
    const addresses = this.deriveAddressesFromSeed(seedHex);
    const address = this.primaryAddress(addresses, network);

    const keystore = await encryptKeystore(mnemonic, passphrase);
    await this.storage.write(walletKey(name), encoder.encode(JSON.stringify(keystore)));

    const meta: WalletMeta = { name, network, createdAt: new Date().toISOString(), address, createdHere: false };
    await this.saveMeta(meta);

    if (!config.wallets.includes(name)) config.wallets.push(name);
    if (!config.activeWallet) config.activeWallet = name;
    await this.saveConfig(config);

    seed.fill(0);

    return { name, address, addresses, network, active: config.activeWallet === name };
  }

  async importFromSeed(name: string, hexSeed: string, passphrase: string, network = 'devnet'): Promise<WalletInfo> {
    const addresses = this.deriveAddressesFromSeed(hexSeed);
    const address = this.primaryAddress(addresses, network);

    const keystore = await encryptKeystore(`seed:${hexSeed}`, passphrase);

    this.validateName(name);
    const config = await this.loadConfig();
    if (await this.nameTaken(config, name)) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" already exists`);
    }

    await this.storage.write(walletKey(name), encoder.encode(JSON.stringify(keystore)));
    const meta: WalletMeta = { name, network, createdAt: new Date().toISOString(), address, createdHere: false };
    await this.saveMeta(meta);

    if (!config.wallets.includes(name)) config.wallets.push(name);
    if (!config.activeWallet) config.activeWallet = name;
    await this.saveConfig(config);

    return { name, address, addresses, network, active: config.activeWallet === name };
  }

  /** Read and revive a wallet's keystore from storage (JSON round-trips
   *  Uint8Array fields as index-keyed objects). */
  private async readKeystore(name: string): Promise<EncryptedKeystore> {
    const keystoreData = await this.storage.read(walletKey(name));
    if (!keystoreData) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" not found`);
    }
    const keystore = JSON.parse(decoder.decode(keystoreData)) as EncryptedKeystore;
    return {
      ...keystore,
      salt: new Uint8Array(Object.values(keystore.salt)),
      nonce: new Uint8Array(Object.values(keystore.nonce)),
      ciphertext: new Uint8Array(Object.values(keystore.ciphertext)),
      tag: new Uint8Array(Object.values(keystore.tag)),
    };
  }

  async unlock(name: string, passphrase: string): Promise<UnlockedWallet> {
    const restored = await this.readKeystore(name);

    // Validate field lengths before attempting decryption (CWE-20).
    // Prevents crafted keystores from reaching the cipher with invalid parameters.
    if (restored.salt.length !== 32) throw new WalletError('WALLET_ERROR', 'Corrupted keystore: invalid salt length');
    if (restored.nonce.length !== 12) throw new WalletError('WALLET_ERROR', 'Corrupted keystore: invalid nonce length');
    if (restored.tag.length !== 16) throw new WalletError('WALLET_ERROR', 'Corrupted keystore: invalid auth tag length');
    if (restored.ciphertext.length === 0) throw new WalletError('WALLET_ERROR', 'Corrupted keystore: empty ciphertext');

    const decrypted = await decryptKeystore(restored, passphrase);

    // Transparent KDF upgrade: re-encrypt with stronger scrypt parameters if needed.
    // This runs once per v1 keystore, after the first successful unlock.
    if (keystoreNeedsUpgrade(restored)) {
      try {
        const upgraded = await encryptKeystore(decrypted, passphrase);
        const blob = new TextEncoder().encode(JSON.stringify(upgraded));
        // Must be walletKey(name) (`wallets/<name>.keystore`), not
        // `wallets/<name>`: the latter wrote to a phantom key, so the upgrade
        // never persisted and re-ran on every unlock. unlock() reads
        // walletKey(name), so write the re-encrypted keystore back there.
        await this.storage.write(walletKey(name), blob);
      } catch {
        // Non-fatal — the wallet still works with the old parameters
      }
    }

    // Derive the seed into the typed key bundle, then drop the raw
    // string immediately. The seedHex variable stays scoped to this
    // function — never escapes to the UnlockedWallet object.
    // See docs/spec/wallet-service/05-key-management.md D-KM-3.
    let seedHex: string;
    if (decrypted.startsWith('seed:')) {
      seedHex = decrypted.slice(5);
    } else {
      const seed = await mnemonicToSeed(decrypted);
      seedHex = this.seedToHex(seed);
      seed.fill(0);
    }

    const addresses = this.deriveAddressesFromSeed(seedHex);
    const meta = await this.loadMeta(name);
    const network = meta?.network ?? (await this.loadConfig()).defaultNetwork;
    const address = this.primaryAddress(addresses, network);
    // Backfill the public address for wallets created before it was stored (or
    // re-derive it after a network change), so the account list can show it
    // without another unlock.
    if (meta && meta.address !== address) {
      await this.saveMeta({ ...meta, address });
    }
    const rawKeys = deriveRawKeys(seedHex);
    const keys: DerivedKeys = {
      nightExternal: rawKeys[Roles.NightExternal],
      nightInternal: rawKeys[Roles.NightInternal],
      dust: rawKeys[Roles.Dust],
      zswap: rawKeys[Roles.Zswap],
      metadata: rawKeys[Roles.Metadata],
    };
    const walletKeys: WalletKeys = deriveWalletKeys(seedHex);
    // Seed is no longer needed — overwrite the local variable.
    seedHex = '';

    let locked = false;
    // Actually scrub key material — not just flip a flag. Zero the raw
    // byte arrays and clear() the WASM-held secret keys so a compromised
    // process can't recover them after lock. Best-effort and idempotent:
    // a clear() throw (e.g. already freed) must not stop the rest.
    const lock = (): void => {
      if (locked) return;
      locked = true;
      for (const b of [
        keys.nightExternal,
        keys.nightInternal,
        keys.dust,
        keys.zswap,
        keys.metadata,
        walletKeys.nightExternalKey,
      ]) {
        try {
          b.fill(0);
        } catch {
          /* not a writable view — ignore */
        }
      }
      try {
        walletKeys.shieldedSecretKeys.clear();
      } catch {
        /* already cleared/freed */
      }
      try {
        walletKeys.dustSecretKey.clear();
      } catch {
        /* already cleared/freed */
      }
    };
    return {
      name,
      label: meta?.label,
      network,
      address,
      addresses,
      keys,
      walletKeys,
      lock,
    };
  }

  /**
   * Recover the raw BIP-39 hex seed for a wallet.
   *
   * This is the ONE deliberate exception to Option A's derive-and-drop
   * (D-KM-3): the common `unlock()` path derives `walletKeys` and drops the
   * seed so `UnlockedWallet` is seed-free, and the daemon/CLI/multi-tenant
   * host never see raw seed material. But the browser extension's offscreen
   * document is the key-holder, and Chrome tears it down and recreates it at
   * will — the WASM `walletKeys` cannot cross the runtime-message boundary, so
   * the offscreen needs a *serializable* secret the background can re-supply to
   * rebuild the key bundle after each restart. That secret is the seed.
   *
   * Kept off `unlock()` on purpose so the seed-free invariant holds for every
   * caller that doesn't explicitly opt in here.
   * See docs/spec/wallet-service/05-key-management.md D-KM-3.
   */
  async exportSeedHex(name: string, passphrase: string): Promise<string> {
    const restored = await this.readKeystore(name);
    const decrypted = await decryptKeystore(restored, passphrase);
    if (decrypted.startsWith('seed:')) return decrypted.slice(5);
    const seed = await mnemonicToSeed(decrypted);
    const seedHex = this.seedToHex(seed);
    seed.fill(0);
    return seedHex;
  }

  /**
   * Recover the wallet's backup secret for a user-facing reveal: the original
   * BIP-39 mnemonic when the wallet has one, or the raw hex seed for wallets
   * imported from hex (no mnemonic ever existed). Passphrase-gated by the
   * keystore decrypt itself — a wrong passphrase rejects. Same deliberate
   * D-KM-3 opt-in rationale as exportSeedHex above.
   */
  async exportPhrase(
    name: string,
    passphrase: string,
  ): Promise<{ kind: 'mnemonic' | 'seed'; value: string }> {
    const restored = await this.readKeystore(name);
    const decrypted = await decryptKeystore(restored, passphrase);
    if (decrypted.startsWith('seed:')) return { kind: 'seed', value: decrypted.slice(5) };
    return { kind: 'mnemonic', value: decrypted };
  }

  async remove(name: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config.wallets.includes(name)) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" not found`);
    }

    // Read meta BEFORE deleting it so we know which networks' sync artifacts to
    // clean. `meta.network` is where the wallet is now; `birthdays` records every
    // network it has arrived on, and setNetwork deliberately leaves the previous
    // network's cache in place for a cheap return trip — so a removal that only
    // cleaned the current one would leave the earlier ones behind.
    const networkIds = new Set<string>();
    try {
      const metaBuf = await this.storage.read(metaKey(name));
      if (metaBuf) {
        const meta = JSON.parse(new TextDecoder().decode(metaBuf)) as WalletMeta;
        if (meta.network) networkIds.add(meta.network);
        for (const id of Object.keys(meta.birthdays ?? {})) networkIds.add(id);
      }
    } catch {
      /* meta unreadable — proceed; cache cleanup is best-effort anyway */
    }

    // Update the index FIRST, before deleting anything it points at.
    //
    // The two failure modes are not symmetric. An entry left in the config whose
    // keystore is already gone is an account the wallet lists but no passphrase
    // can open — and when it is the only account, that is a wallet you cannot
    // get back into, since the "no accounts yet" path never runs. An orphaned
    // keystore with no entry is invisible, costs a few encrypted bytes, and is
    // overwritten by the next wallet created under that name. So the index goes
    // first and everything below it is cleanup.
    config.wallets = config.wallets.filter(w => w !== name);
    if (config.activeWallet === name) {
      config.activeWallet = config.wallets[0] ?? null;
    }
    await this.saveConfig(config);

    await this.storage.delete(walletKey(name));
    await this.storage.delete(metaKey(name));

    // Clean per-wallet sync artifacts: the serialized sub-wallet state in the
    // sync store, plus (on node) ~/.moth/sync/<network>/<name>/ and the matching
    // .sock. Without this, regenerating a wallet under the same name would
    // silently inherit stale sync state belonging to the prior seed — a real
    // footgun observed during 2026-06-22 debugging. See
    // docs/spec/wallet-service/COMMANDS.md §"Wallet lifecycle" for the full list
    // of what remove touches.
    //
    // `this.syncStore` matters here: with no store the resolution falls back to
    // the fs-backed one on node — correct for the CLI/TUI/daemon — but to a
    // volatile in-memory store in the browser, where it cleaned nothing at all
    // and a re-added account resumed the removed one's sync (#90).
    //
    // Best-effort by construction: this is the slowest part of the removal and
    // the one reaching outside this manager, so a store that rejects must not
    // take the removal down with it. The account is already gone from the index
    // by this point; a cache left behind is a stale-state risk on re-create,
    // which is bad, but a half-removed account is worse.
    for (const networkId of networkIds) {
      try {
        await removeWalletSyncArtifacts(name, networkId, this.syncStore);
      } catch {
        /* cache cleanup is best-effort — never fail a removal over it */
      }
    }
  }

  /**
   * List wallets. Returns the name, network and public receive address (stored
   * in the clear at create/import time). The full per-role address set and any
   * key material still require unlock — only the primary night address is here.
   */
  async list(): Promise<WalletInfo[]> {
    const config = await this.loadConfig();
    const wallets: WalletInfo[] = [];
    const emptyAddr: AddressEncoding = { hex: '', bech32m: {} };
    const lockedAddresses: WalletAddresses = {
      nightExternal: emptyAddr, nightInternal: emptyAddr,
      dust: emptyAddr, zswap: emptyAddr, metadata: emptyAddr,
    };

    for (const name of await this.presentWallets(config)) {
      const meta = await this.loadMeta(name);
      wallets.push({
        name,
        address: meta?.address ?? '(locked)',
        addresses: lockedAddresses,
        network: meta?.network ?? config.defaultNetwork,
        active: config.activeWallet === name,
        birthday: meta ? birthdayFor(meta, meta.network) : undefined,
        label: meta?.label,
      });
    }
    return wallets;
  }

  async getActive(): Promise<string | null> {
    const config = await this.loadConfig();
    return config.activeWallet;
  }

  async setActive(name: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config.wallets.includes(name)) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" not found`);
    }
    config.activeWallet = name;
    await this.saveConfig(config);
  }

  /**
   * Set or clear a wallet's display label. Labels are presentation-only
   * metadata: the wallet keeps its immutable `name` (the storage key), so
   * keystores, sync caches and sessions all stay valid across renames.
   * An empty (or whitespace-only) label reverts to showing the name.
   */
  async setLabel(name: string, label: string): Promise<void> {
    const meta = await this.loadMeta(name);
    if (!meta) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" not found`);
    }
    const trimmed = label.trim();
    const { label: _cleared, ...rest } = meta;
    await this.saveMeta(trimmed ? { ...rest, label: trimmed } : rest);
  }

  /**
   * Move a wallet to another network. Only this wallet's metadata changes —
   * other wallets keep their own networks. The public address and chain
   * birthday are network-scoped, so the old values are discarded. A caller
   * that already has the unlocked seed may provide the newly derived public
   * address to keep the locked account list immediately useful.
   */
  async setNetwork(name: string, network: string, address?: string, birthday?: number): Promise<void> {
    const meta = await this.loadMeta(name);
    if (!meta) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" not found`);
    }
    if (meta.network === network) {
      if (address !== undefined && address !== meta.address) await this.saveMeta({ ...meta, address });
      return;
    }
    // The legacy single `birthday` is folded into the per-network map before it
    // is dropped, so a wallet written before `birthdays` existed keeps the value
    // for the network it earned it on. Dropping it outright — which is what this
    // used to do — left the wallet with no birthday anywhere, and the pre-seed
    // guard (`reference.height <= birthday`) can never pass without one, so
    // every sync after a switch walked from genesis.
    const birthdays = { ...(meta.birthdays ?? {}) };
    if (meta.birthday !== undefined && birthdays[meta.network] === undefined) {
      birthdays[meta.network] = meta.birthday;
    }

    // First arrival at `network`: record the caller-supplied first-existence
    // height. Two guards, both load-bearing:
    //
    //   createdHere — an imported wallet may hold funds on any chain at any
    //   height, so it never gets a birthday and always scans from genesis. A
    //   wallet written before this field existed has it undefined, which reads
    //   as imported: the conservative answer, since the cost of being wrong that
    //   way is a slow sync, and the cost of the other way is invisible funds.
    //
    //   birthdays[network] === undefined — only the FIRST arrival counts.
    //   Returning to a network reuses the height recorded then, because the
    //   wallet may have transacted there before leaving; overwriting it with a
    //   later tip would skip that history.
    if (birthday !== undefined && meta.createdHere === true && birthdays[network] === undefined) {
      birthdays[network] = birthday;
    }

    const { address: _staleAddress, birthday: _staleBirthday, ...rest } = meta;
    await this.saveMeta({
      ...rest,
      network,
      ...(Object.keys(birthdays).length > 0 ? { birthdays } : {}),
      ...(address ? { address } : {}),
    });
  }
}
