// User-assigned token display names, persisted in storage.local and keyed by
// the full token id. Purely presentational: nothing on-chain or in the wallet
// SDK knows about them, and token ids are hashes, so one flat map serves every
// account and network.

import { browser } from 'wxt/browser';

const TOKEN_NAMES_KEY = 'tokenNames';

export async function getTokenNames(): Promise<Record<string, string>> {
  const stored = await browser.storage.local.get(TOKEN_NAMES_KEY);
  const saved = stored[TOKEN_NAMES_KEY];
  return saved && typeof saved === 'object' ? (saved as Record<string, string>) : {};
}

/** Set a token's display name; an empty (or whitespace-only) name clears it.
 *  Returns the updated map. */
export async function setTokenName(tokenId: string, name: string): Promise<Record<string, string>> {
  const names = await getTokenNames();
  const trimmed = name.trim();
  if (trimmed) {
    names[tokenId] = trimmed;
  } else {
    delete names[tokenId];
  }
  await browser.storage.local.set({ [TOKEN_NAMES_KEY]: names });
  return names;
}
