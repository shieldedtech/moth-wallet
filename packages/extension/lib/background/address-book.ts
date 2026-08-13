// The user's address book, persisted in storage.local. Purely a local
// convenience: a list of named addresses (shielded / unshielded / DUST) offered
// when choosing a recipient or a DUST-generation receiver. Nothing on-chain
// depends on it, and addresses are public, so one flat list serves every
// account and network — like token-names.ts.

import { browser } from 'wxt/browser';
import type { AddressKind } from '../ui/address';

const ADDRESS_BOOK_KEY = 'addressBook';

export interface AddressBookEntry {
  /** Stable id, so renames/edits don't lose selection. */
  id: string;
  name: string;
  address: string;
  kind: AddressKind;
}

function isEntry(value: unknown): value is AddressBookEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<AddressBookEntry>;
  return (
    typeof e.id === 'string' &&
    typeof e.name === 'string' &&
    typeof e.address === 'string' &&
    (e.kind === 'shielded' || e.kind === 'unshielded' || e.kind === 'dust')
  );
}

export async function getAddressBook(): Promise<AddressBookEntry[]> {
  const stored = await browser.storage.local.get(ADDRESS_BOOK_KEY);
  const saved = stored[ADDRESS_BOOK_KEY];
  return Array.isArray(saved) ? saved.filter(isEntry) : [];
}

async function write(entries: AddressBookEntry[]): Promise<AddressBookEntry[]> {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  await browser.storage.local.set({ [ADDRESS_BOOK_KEY]: sorted });
  return sorted;
}

/** Insert (no id) or update (matching id) an entry. Returns the updated list. */
export async function saveAddressEntry(entry: {
  id?: string;
  name: string;
  address: string;
  kind: AddressKind;
}): Promise<AddressBookEntry[]> {
  const entries = await getAddressBook();
  const record: AddressBookEntry = {
    id: entry.id ?? crypto.randomUUID(),
    name: entry.name.trim(),
    address: entry.address.trim(),
    kind: entry.kind,
  };
  const index = entries.findIndex((e) => e.id === record.id);
  if (index >= 0) entries[index] = record;
  else entries.push(record);
  return write(entries);
}

/** Remove the entry with this id. Returns the updated list. */
export async function removeAddressEntry(id: string): Promise<AddressBookEntry[]> {
  const entries = (await getAddressBook()).filter((e) => e.id !== id);
  return write(entries);
}
