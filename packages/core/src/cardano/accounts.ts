import type { StorageAdapter } from '../storage/adapter.js';
import { InvalidInputError, WalletError } from '../types/errors.js';
import { decryptKeystore, encryptKeystore, type EncryptedKeystore } from '../wallet/keystore.js';
import { validateMnemonic } from '../wallet/mnemonic.js';

/**
 * A Cardano account belonging to a moth wallet.
 *
 * Two kinds, and the difference is entirely about where the key comes from:
 *
 * - `derived` accounts are CIP-1852 account indices of the wallet's own
 *   recovery phrase. Each has its own address and stake key, and therefore its
 *   own independent DUST registration — but there is still one phrase to back
 *   up, and restoring the wallet restores all of them.
 *
 * - `imported` accounts carry a separate BIP-39 phrase, stored encrypted under
 *   the wallet passphrase. They are Cardano-only: they hold ADA and cNIGHT and
 *   can register for DUST generation, but they are not Midnight accounts and
 *   have no Midnight balance. Restoring the moth wallet does NOT restore them —
 *   their phrase is a separate backup artifact, which is the cost of importing
 *   a key moth did not generate.
 */
export interface CardanoAccountRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: 'derived' | 'imported';
  /**
   * CIP-1852 account index. For `derived`, the index within the wallet's own
   * phrase. For `imported`, always 0 — the imported phrase is the account, and
   * a second index of someone else's phrase is not a thing anyone asked for.
   */
  readonly accountIndex: number;
}

export interface CardanoAccountList {
  readonly accounts: readonly CardanoAccountRecord[];
  readonly activeId: string;
}

/**
 * The account every wallet has without doing anything: index 0 of its own
 * phrase. Synthesized rather than written at wallet creation, so a wallet that
 * predates Cardano support still has one and nothing needs migrating.
 */
export const DEFAULT_CARDANO_ACCOUNT: CardanoAccountRecord = {
  id: 'default',
  label: 'Account 1',
  kind: 'derived',
  accountIndex: 0,
};

interface StoredState {
  accounts: CardanoAccountRecord[];
  activeId: string;
  /**
   * High-water mark for CIP-1852 indices, persisted rather than recomputed.
   *
   * Deriving "next" from the highest index still in the list hands a removed
   * account's index straight back to the next one created — along with its
   * address, its stake key and any DUST registration made against it. Only a
   * stored counter avoids that, because the evidence of the removed account is
   * gone by definition.
   */
  nextDerivedIndex: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Storage keys are namespaced per wallet: two wallets' Cardano accounts are unrelated. */
function stateKey(walletName: string): string {
  return `cardano/${walletName}/accounts.json`;
}

function keystoreKey(walletName: string, id: string): string {
  return `cardano/${walletName}/keys/${id}`;
}

/** Reject anything that could escape the wallet's own storage namespace. */
function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new InvalidInputError(`Invalid Cardano account id "${id}"`);
  }
}

function newId(): string {
  // Short and collision-resistant enough for a per-wallet list a human curates.
  return `ca_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

async function readState(
  storage: Pick<StorageAdapter, 'read'>,
  walletName: string,
): Promise<StoredState> {
  let parsed: Partial<StoredState> | null = null;
  try {
    const data = await storage.read(stateKey(walletName));
    if (data) parsed = JSON.parse(decoder.decode(data)) as Partial<StoredState>;
  } catch {
    // A corrupt or unreadable list must not lock someone out of the account
    // they already had — fall through to the synthesized default.
    parsed = null;
  }
  const accounts = Array.isArray(parsed?.accounts) && parsed.accounts.length > 0
    ? parsed.accounts
    : [DEFAULT_CARDANO_ACCOUNT];
  const activeId = accounts.some(a => a.id === parsed?.activeId)
    ? parsed!.activeId!
    : accounts[0]!.id;
  // Absent in state written before the counter existed: seed it from the list,
  // which is the best that can be known at that point and is correct for any
  // wallet that has not removed an account yet.
  const highest = accounts
    .filter(a => a.kind === 'derived')
    .reduce((max, a) => Math.max(max, a.accountIndex), -1);
  const nextDerivedIndex =
    typeof parsed?.nextDerivedIndex === 'number' && parsed.nextDerivedIndex > highest
      ? parsed.nextDerivedIndex
      : highest + 1;
  return { accounts, activeId, nextDerivedIndex };
}

async function writeState(
  storage: Pick<StorageAdapter, 'write'>,
  walletName: string,
  state: StoredState,
): Promise<void> {
  await storage.write(stateKey(walletName), encoder.encode(JSON.stringify(state)));
}

export async function listCardanoAccounts(
  storage: Pick<StorageAdapter, 'read'>,
  walletName: string,
): Promise<CardanoAccountList> {
  return readState(storage, walletName);
}

export async function getActiveCardanoAccount(
  storage: Pick<StorageAdapter, 'read'>,
  walletName: string,
): Promise<CardanoAccountRecord> {
  const { accounts, activeId } = await readState(storage, walletName);
  return accounts.find(a => a.id === activeId) ?? accounts[0]!;
}

export async function setActiveCardanoAccount(
  storage: Pick<StorageAdapter, 'read' | 'write'>,
  walletName: string,
  id: string,
): Promise<CardanoAccountList> {
  assertSafeId(id);
  const state = await readState(storage, walletName);
  if (!state.accounts.some(a => a.id === id)) {
    throw new InvalidInputError(`No Cardano account "${id}" on wallet "${walletName}"`);
  }
  const next = { ...state, activeId: id };
  await writeState(storage, walletName, next);
  return next;
}

/**
 * Add the next CIP-1852 account index of the wallet's own phrase.
 *
 * "Next" is one past the highest index in use, not `accounts.length` — removing
 * an account must not hand its index, and therefore its address and any DUST
 * registration attached to it, to the next account created.
 */
export async function addDerivedCardanoAccount(
  storage: Pick<StorageAdapter, 'read' | 'write'>,
  walletName: string,
  label?: string,
): Promise<{ list: CardanoAccountList; account: CardanoAccountRecord }> {
  const state = await readState(storage, walletName);
  const accountIndex = state.nextDerivedIndex;
  const account: CardanoAccountRecord = {
    id: newId(),
    label: label?.trim() || `Account ${accountIndex + 1}`,
    kind: 'derived',
    accountIndex,
  };
  const list = {
    accounts: [...state.accounts, account],
    activeId: account.id,
    nextDerivedIndex: accountIndex + 1,
  };
  await writeState(storage, walletName, list);
  return { list, account };
}

/**
 * Import a Cardano account from a separate BIP-39 phrase.
 *
 * The phrase is encrypted under the wallet passphrase, so it is protected by
 * the same secret as the wallet's own keystore and is readable only while the
 * user can unlock. It is NOT covered by the wallet's recovery phrase: whoever
 * imports it keeps their own backup, and this is stated wherever the action is
 * offered rather than only here.
 */
export async function importCardanoAccount(
  storage: Pick<StorageAdapter, 'read' | 'write'>,
  walletName: string,
  mnemonic: string,
  passphrase: string,
  label?: string,
): Promise<{ list: CardanoAccountList; account: CardanoAccountRecord }> {
  const phrase = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(phrase)) {
    throw new InvalidInputError('Invalid BIP-39 recovery phrase');
  }
  const state = await readState(storage, walletName);
  const account: CardanoAccountRecord = {
    id: newId(),
    label: label?.trim() || `Imported ${state.accounts.filter(a => a.kind === 'imported').length + 1}`,
    kind: 'imported',
    accountIndex: 0,
  };
  const keystore = await encryptKeystore(phrase, passphrase);
  await storage.write(
    keystoreKey(walletName, account.id),
    encoder.encode(JSON.stringify(keystore)),
  );
  const list = { ...state, accounts: [...state.accounts, account], activeId: account.id };
  await writeState(storage, walletName, list);
  return { list, account };
}

export async function removeCardanoAccount(
  storage: Pick<StorageAdapter, 'read' | 'write' | 'delete'>,
  walletName: string,
  id: string,
): Promise<CardanoAccountList> {
  assertSafeId(id);
  const state = await readState(storage, walletName);
  const target = state.accounts.find(a => a.id === id);
  if (!target) throw new InvalidInputError(`No Cardano account "${id}" on wallet "${walletName}"`);
  if (state.accounts.length === 1) {
    throw new WalletError('WALLET_ERROR', 'Cannot remove the only Cardano account.');
  }
  if (target.kind === 'imported') {
    // Removing an imported account destroys the only copy moth holds of that
    // phrase. Callers are expected to have confirmed; there is nothing to
    // recover it from afterwards.
    await storage.delete(keystoreKey(walletName, id)).catch(() => {});
  }
  const accounts = state.accounts.filter(a => a.id !== id);
  const list = {
    ...state,
    accounts,
    activeId: state.activeId === id ? accounts[0]!.id : state.activeId,
  };
  await writeState(storage, walletName, list);
  return list;
}

export async function renameCardanoAccount(
  storage: Pick<StorageAdapter, 'read' | 'write'>,
  walletName: string,
  id: string,
  label: string,
): Promise<CardanoAccountList> {
  assertSafeId(id);
  const trimmed = label.trim();
  if (!trimmed) throw new InvalidInputError('Label cannot be empty');
  const state = await readState(storage, walletName);
  if (!state.accounts.some(a => a.id === id)) {
    throw new InvalidInputError(`No Cardano account "${id}" on wallet "${walletName}"`);
  }
  const list = {
    ...state,
    accounts: state.accounts.map(a => (a.id === id ? { ...a, label: trimmed } : a)),
  };
  await writeState(storage, walletName, list);
  return list;
}

/**
 * The phrase and account index to derive a given account's keys from.
 *
 * `walletMnemonic` covers every `derived` account; an `imported` one is read
 * back out of its own keystore. Returning both halves keeps the choice of
 * which phrase to use in one place instead of at every call site.
 */
export async function resolveCardanoAccountKey(
  storage: Pick<StorageAdapter, 'read'>,
  walletName: string,
  account: CardanoAccountRecord,
  walletMnemonic: string | null,
  passphrase?: string,
): Promise<{ mnemonic: string; accountIndex: number }> {
  if (account.kind === 'derived') {
    if (!walletMnemonic) {
      throw new WalletError(
        'WALLET_ERROR',
        `Wallet "${walletName}" has no recovery phrase, so it has no derived Cardano accounts.`,
      );
    }
    return { mnemonic: walletMnemonic, accountIndex: account.accountIndex };
  }

  assertSafeId(account.id);
  const data = await storage.read(keystoreKey(walletName, account.id));
  if (!data) {
    throw new WalletError(
      'WALLET_ERROR',
      `The recovery phrase for imported Cardano account "${account.label}" is missing.`,
    );
  }
  if (passphrase === undefined) {
    throw new InvalidInputError('The wallet passphrase is required to unlock an imported Cardano account.');
  }
  const stored = JSON.parse(decoder.decode(data)) as EncryptedKeystore;
  const keystore: EncryptedKeystore = {
    ...stored,
    // JSON turns the byte arrays into plain objects; the same revival the
    // wallet keystore reader does.
    salt: new Uint8Array(Object.values(stored.salt)),
    nonce: new Uint8Array(Object.values(stored.nonce)),
    ciphertext: new Uint8Array(Object.values(stored.ciphertext)),
    tag: new Uint8Array(Object.values(stored.tag)),
  };
  return { mnemonic: await decryptKeystore(keystore, passphrase), accountIndex: 0 };
}
