/**
 * Presentation logic for the recovery-phrase reveal (#166).
 *
 * Kept out of the screen because the TUI has no Ink render harness — the same
 * reason `onboarding/seed-input.ts` exists. Anything worth asserting has to be
 * a plain module, so the word grid and the has-no-phrase case are decided here
 * and `keys.tsx` only paints the result.
 */

/** What `WalletManager.exportPhrase` gives back. */
export interface RevealedSecret {
  kind: 'mnemonic' | 'seed';
  value: string;
}

export interface RevealWord {
  /** 1-based position, as the user is expected to write it down. */
  index: number;
  word: string;
}

export interface RevealView {
  kind: 'mnemonic' | 'seed';
  /** Numbered word rows for a mnemonic; empty for a hex-seed wallet. */
  rows: RevealWord[][];
  /** The raw hex seed, for a wallet that never had a mnemonic. */
  seedHex: string | null;
  /** Shown only when there is no phrase, so a seed is not mistaken for one. */
  note: string | null;
}

export const WORDS_PER_ROW = 6;

/**
 * A wallet imported from a hex seed has no mnemonic to give back. The CLI's
 * `wallet export-phrase` says which one it is holding rather than presenting a
 * seed as a phrase; this does the same, because a user told "here is your
 * recovery phrase" over 64 hex characters will write down the wrong thing and
 * may try to restore it as words elsewhere.
 */
const NO_PHRASE_NOTE = 'This wallet was imported from a hex seed, so it has no recovery phrase. The seed below is its only backup.';

export function buildRevealView(
  secret: RevealedSecret,
  wordsPerRow: number = WORDS_PER_ROW,
): RevealView {
  if (secret.kind === 'seed') {
    return { kind: 'seed', rows: [], seedHex: secret.value, note: NO_PHRASE_NOTE };
  }

  // Split on any whitespace: the stored mnemonic is space-separated, but a
  // phrase that ever round-tripped through a file may carry newlines, and a
  // stray blank must not become an empty numbered slot.
  const words = secret.value.split(/\s+/).filter(Boolean);

  // Not hardcoded to 24 words in 4 rows the way the onboarding display is:
  // core validates 24 today, but a grid that silently drops words if that ever
  // changes is a backup screen that lies.
  const rows: RevealWord[][] = [];
  for (let i = 0; i < words.length; i += wordsPerRow) {
    rows.push(words.slice(i, i + wordsPerRow).map((word, j) => ({ index: i + j + 1, word })));
  }

  return { kind: 'mnemonic', rows, seedHex: null, note: null };
}
