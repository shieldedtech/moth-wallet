import type { StorageAdapter } from '../storage/adapter.js';
import type { WalletInfo, UnlockedWallet, DerivedKeys, WalletAddresses, AddressEncoding } from '../types/wallet.js';
import { WalletError } from '../types/errors.js';
import { generateMnemonic24, validateMnemonic, mnemonicToSeed, hexSeedToUint8Array } from './mnemonic.js';
import { encryptKeystore, decryptKeystore, keystoreNeedsUpgrade, type EncryptedKeystore } from './keystore.js';
import { deriveAllAddressesFromSeed, deriveRawKeys, Roles } from './address.js';
import type { SignatureKind } from './signature-encoding.js';
import { initSdk } from '../sdk/index.js';
import { detectLedgerVersion } from '../ledger/protocol-version.js';
import { DEFAULT_NETWORKS } from '../types/network.js';
import { deriveWalletKeys, type WalletKeys } from '../sync/operations.js';
import { removeWalletSyncArtifacts } from '../sync/wallet-sync.js';

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
  /**
   * Which signature algorithm this wallet's unshielded identity uses. Absent
   * means schnorr, which is what every wallet written before this field used
   * and the only kind ledger v8 has.
   *
   * Fixed at creation and never rewritten: it determines the unshielded
   * address, and DustRegistration binds the tagged night key, so changing it
   * would strand NIGHT at the old address and silently stop DUST generation
   * until re-registered.
   */
  signatureKind?: SignatureKind;
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

  constructor(storage: StorageAdapter) {
    this.storage = storage;
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

  private validateName(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new WalletError('WALLET_ERROR', `Invalid wallet name "${name}": must match [a-zA-Z0-9_-]+`);
    }
  }

  private seedToHex(seed: Uint8Array): string {
    return Array.from(seed).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Bring up the ledger and SDK a network needs. Detection prefers what the
   * network reports and falls back to the shipped table, so an unreachable
   * indexer still unlocks the wallet.
   */
  /**
   * ECDSA exists only on ledger v9, so asking for it on a v8 network cannot
   * produce a usable wallet — it would have no unshielded address there at all.
   * Refusing beats creating something that silently cannot receive.
   */
  private async assertKindUsable(networkId: string, kind: SignatureKind): Promise<void> {
    if (kind !== 'ecdsa') return;
    if (await this.networkSupportsKind(networkId, kind)) return;
    throw new WalletError(
      'INVALID_INPUT',
      `ECDSA signing needs a ledger v9 network; ${networkId} is on v8. ` +
        `Use schnorr there, or pick a v9 network.`,
    );
  }

  /** Whether a network's ledger has the signing algorithm this wallet uses. */
  private async networkSupportsKind(networkId: string, kind: SignatureKind): Promise<boolean> {
    if (kind !== 'ecdsa') return true;
    const preset = DEFAULT_NETWORKS[networkId];
    const version = preset ? (await detectLedgerVersion(preset)).version : 'v8';
    return version === 'v9';
  }

  /**
   * Refuse to open an existing wallet on a network its signing algorithm does
   * not exist on. An ECDSA wallet has no unshielded identity on a v8 network,
   * so the sync would fail somewhere deep and unhelpfully; saying so here names
   * the cause and the remedy at the moment the user chose the network.
   */
  private async assertWalletUsableOn(networkId: string, kind: SignatureKind): Promise<void> {
    if (await this.networkSupportsKind(networkId, kind)) return;
    const usable = Object.entries(DEFAULT_NETWORKS)
      .filter(([, cfg]) => cfg.ledgerVersion === 'v9')
      .map(([id]) => id)
      .join(', ');
    throw new WalletError(
      'INVALID_INPUT',
      `This account signs with ECDSA, which exists only on ledger v9 networks, so it has no ` +
        `address on ${networkId}. Switch to ${usable || 'a v9 network'} to use it.`,
    );
  }

  private async ensureRuntimeFor(networkId: string): Promise<void> {
    const preset = DEFAULT_NETWORKS[networkId];
    const version = preset ? (await detectLedgerVersion(preset)).version : 'v8';
    await initSdk(version);
  }

  private deriveAddressesFromSeed(seedHex: string, kind: SignatureKind = 'schnorr'): WalletAddresses {
    return deriveAllAddressesFromSeed(seedHex, kind);
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
    // Fixed at creation: it selects the unshielded identity, and switching later
    // strands NIGHT and de-registers DUST. Only offer it on ledger v9 networks —
    // v8 has no ECDSA at all.
    signatureKind: SignatureKind = 'schnorr',
  ): Promise<WalletInfo & { mnemonic: string }> {
    this.validateName(name);
    const config = await this.loadConfig();

    if (config.wallets.includes(name)) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" already exists`);
    }

    if (mnemonic !== undefined && !validateMnemonic(mnemonic)) {
      throw new WalletError('INVALID_INPUT', 'Invalid BIP-39 mnemonic');
    }
    const phrase = mnemonic ?? generateMnemonic24();
    const seed = await mnemonicToSeed(phrase);
    await this.ensureRuntimeFor(network);
    await this.assertKindUsable(network, signatureKind);
    const seedHex = this.seedToHex(seed);
    const addresses = this.deriveAddressesFromSeed(seedHex, signatureKind);
    const address = this.primaryAddress(addresses, network);

    const keystore = await encryptKeystore(phrase, passphrase);
    await this.storage.write(walletKey(name), encoder.encode(JSON.stringify(keystore)));

    const meta: WalletMeta = {
      name,
      network,
      createdAt: new Date().toISOString(),
      address,
      createdHere: true,
      // Only recorded when it is not the default, so existing records and new
      // schnorr wallets stay byte-identical.
      ...(signatureKind !== 'schnorr' ? { signatureKind } : {}),
      ...(birthday !== undefined ? { birthdays: { [network]: birthday } } : {}),
    };
    await this.saveMeta(meta);

    config.wallets.push(name);
    if (!config.activeWallet) config.activeWallet = name;
    await this.saveConfig(config);

    seed.fill(0);

    return { name, address, addresses, network, active: config.activeWallet === name, mnemonic: phrase, birthday };
  }

  async import(
    name: string,
    mnemonic: string,
    passphrase: string,
    network = 'devnet',
    signatureKind: SignatureKind = 'schnorr',
  ): Promise<WalletInfo> {
    this.validateName(name);

    if (!validateMnemonic(mnemonic)) {
      throw new WalletError('INVALID_INPUT', 'Invalid BIP-39 mnemonic');
    }

    const config = await this.loadConfig();
    if (config.wallets.includes(name)) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" already exists`);
    }

    await this.ensureRuntimeFor(network);
    await this.assertKindUsable(network, signatureKind);
    const seed = await mnemonicToSeed(mnemonic);
    const seedHex = this.seedToHex(seed);
    const addresses = this.deriveAddressesFromSeed(seedHex, signatureKind);
    const address = this.primaryAddress(addresses, network);

    const keystore = await encryptKeystore(mnemonic, passphrase);
    await this.storage.write(walletKey(name), encoder.encode(JSON.stringify(keystore)));

    const meta: WalletMeta = {
      name,
      network,
      createdAt: new Date().toISOString(),
      address,
      createdHere: false,
      ...(signatureKind !== 'schnorr' ? { signatureKind } : {}),
    };
    await this.saveMeta(meta);

    config.wallets.push(name);
    if (!config.activeWallet) config.activeWallet = name;
    await this.saveConfig(config);

    seed.fill(0);

    return { name, address, addresses, network, active: config.activeWallet === name };
  }

  async importFromSeed(
    name: string,
    hexSeed: string,
    passphrase: string,
    network = 'devnet',
    signatureKind: SignatureKind = 'schnorr',
  ): Promise<WalletInfo> {
    await this.ensureRuntimeFor(network);
    await this.assertKindUsable(network, signatureKind);
    const addresses = this.deriveAddressesFromSeed(hexSeed, signatureKind);
    const address = this.primaryAddress(addresses, network);

    const keystore = await encryptKeystore(`seed:${hexSeed}`, passphrase);

    this.validateName(name);
    const config = await this.loadConfig();
    if (config.wallets.includes(name)) {
      throw new WalletError('WALLET_ERROR', `Wallet "${name}" already exists`);
    }

    await this.storage.write(walletKey(name), encoder.encode(JSON.stringify(keystore)));
    const meta: WalletMeta = {
      name,
      network,
      createdAt: new Date().toISOString(),
      address,
      createdHere: false,
      ...(signatureKind !== 'schnorr' ? { signatureKind } : {}),
    };
    await this.saveMeta(meta);

    config.wallets.push(name);
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

    // Meta first: it carries the signature kind, which selects the unshielded
    // identity. Deriving before reading it would silently produce schnorr
    // addresses for an ECDSA wallet.
    const meta = await this.loadMeta(name);
    const network = meta?.network ?? (await this.loadConfig()).defaultNetwork;
    // Then the runtime, before any derivation. Schnorr derives from a direct v8
    // import and needs nothing loaded, but ECDSA goes through the seam — so an
    // ECDSA wallet cannot even have its address derived until the SDK is up.
    await this.ensureRuntimeFor(network);
    await this.assertWalletUsableOn(network, meta?.signatureKind ?? 'schnorr');
    const addresses = this.deriveAddressesFromSeed(seedHex, meta?.signatureKind ?? 'schnorr');
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
    // The stored kind must reach the bundle, or an ECDSA wallet signs and
    // watches with the schnorr key. The runtime is already up (see above).
    const walletKeys: WalletKeys = deriveWalletKeys(seedHex, meta?.signatureKind ?? 'schnorr');
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

    // Read meta BEFORE deleting it so we know which network's sync
    // artifacts to clean. A wallet records exactly one network at
    // generation; subsequent unlocks always run on that same id.
    let networkId: string | null = null;
    try {
      const metaBuf = await this.storage.read(metaKey(name));
      if (metaBuf) {
        const meta = JSON.parse(new TextDecoder().decode(metaBuf)) as WalletMeta;
        networkId = meta.network ?? null;
      }
    } catch {
      /* meta unreadable — proceed; cache cleanup is best-effort anyway */
    }

    await this.storage.delete(walletKey(name));
    await this.storage.delete(metaKey(name));

    // Clean per-wallet sync artifacts (~/.moth/sync/<network>/<name>/
    // and the matching .sock). Without this, regenerating a wallet
    // under the same name would silently inherit stale sync state
    // belonging to the prior seed — a real footgun observed during
    // 2026-06-22 debugging. See docs/spec/wallet-service/COMMANDS.md
    // §"Wallet lifecycle" for the full list of what remove touches.
    if (networkId) {
      await removeWalletSyncArtifacts(name, networkId);
    }

    config.wallets = config.wallets.filter(w => w !== name);
    if (config.activeWallet === name) {
      config.activeWallet = config.wallets[0] ?? null;
    }
    await this.saveConfig(config);
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

    for (const name of config.wallets) {
      const meta = await this.loadMeta(name);
      wallets.push({
        name,
        address: meta?.address ?? '(locked)',
        addresses: lockedAddresses,
        network: meta?.network ?? config.defaultNetwork,
        active: config.activeWallet === name,
        birthday: meta ? birthdayFor(meta, meta.network) : undefined,
        label: meta?.label,
        signatureKind: meta?.signatureKind,
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
