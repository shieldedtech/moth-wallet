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

/**
 * Four to a row so the grid fits an 80-column terminal: 4 cells of
 * WORD_CELL_WIDTH plus the screen's padding and the box's border come to 64
 * columns. Six to a row needed about 92, and Ink then wraps a word mid-way on
 * the one screen whose whole job is copying words exactly.
 */
export const WORDS_PER_ROW = 4;

/** "24." + a space + the longest BIP-39 word (8 letters), with a gap after it. */
export const WORD_CELL_WIDTH = 14;

/**
 * The message for a failed reveal. Only a failed decryption means the
 * passphrase may be wrong; anything else (a removed wallet, an unreadable
 * keystore, an unsupported keystore version) says what happened, so a user
 * with the right passphrase is not sent to retype it.
 */
export function revealErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // decryptKeystore's message for a failed authentication tag.
  if (message.startsWith('Decryption failed')) return 'Wrong passphrase or corrupted keystore';
  return `Could not read the recovery phrase: ${message}`;
}

/**
 * Tracks passphrase submissions so a decrypt that finishes after the user has
 * left the reveal is dropped, not painted. Decrypting takes a noticeable moment
 * (scrypt), and ESC during it must mean the phrase never appears. It also
 * refuses a second submit while one is still decrypting.
 */
export interface RevealAttempts {
  /** Starts an attempt and returns its id, or null while one is still decrypting. */
  begin(): number | null;
  /** Whether attempt `id`'s result may still be shown: nothing cancelled or replaced it since. */
  isCurrent(id: number): boolean;
  /** Attempt `id` has finished. A cancelled attempt already freed the slot. */
  settle(id: number): void;
  /** The user left the reveal: every attempt so far is void. */
  cancel(): void;
}

export function createRevealAttempts(): RevealAttempts {
  let current = 0;
  let inFlight = false;
  return {
    begin() {
      if (inFlight) return null;
      inFlight = true;
      current += 1;
      return current;
    },
    isCurrent(id) {
      return id === current;
    },
    settle(id) {
      if (id === current) inFlight = false;
    },
    cancel() {
      current += 1;
      inFlight = false;
    },
  };
}

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
