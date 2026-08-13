// Parsing and formatting for BIP39 recovery phrases as they arrive from, and go
// to, the clipboard. WASM-free and dependency-free so it is unit-testable on its
// own — the same split as token-labels.ts and dust-heal.ts.

/**
 * Split pasted text into recovery words.
 *
 * Accepts whatever a user actually has in hand rather than one blessed format:
 * a phrase pasted from a password manager is space-separated, one exported to a
 * spreadsheet comes back comma-separated, and one copied out of a printed backup
 * arrives with line breaks. All three are the same phrase, so all three parse.
 *
 * Bare numbers are dropped, which lets a numbered phrase — "1 abandon 2 ability"
 * or "1. abandon, 2. ability", the shape you get from selecting a numbered word
 * grid — round-trip back in. This is unambiguous rather than merely convenient:
 * no BIP39 word is numeric, so a purely numeric token can only ever be an index.
 *
 * Never changes case: the caller validates against the wordlist, and silently
 * folding case would hide a genuinely wrong word behind a guess.
 */
export function splitSeedPhrase(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((word) => word.replace(/^\(?\d+[.)\]]?$/, '').trim())
    .filter((word) => word.length > 0);
}

/** The canonical form to put on the clipboard: single spaces, nothing else.
 *  It is what every wallet's import field expects, including ours. */
export function formatSeedPhrase(words: string[]): string {
  return words.map((word) => word.trim()).filter((word) => word.length > 0).join(' ');
}
