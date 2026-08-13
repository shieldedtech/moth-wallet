// Send-to-name (.shielded name registry, Phase 1) — pure, WASM-free helpers.
//
// Convention: the user types a `.shielded` name (e.g. `alice.shielded`) in the
// recipient field; the wallet strips the suffix and forward-resolves the bare
// name against the registry's read API (the network call happens in the
// background — see lib/background/name-resolve.ts). Resolution is forward-only:
// name → records.address. There is NO reverse (address → name) lookup —
// ownership is private by design. The actual send is gated on the resolved
// value being a valid Midnight address (safe-degrade until the registry
// canonicalizes the address record format). See docs/adr/0002.

const SHIELDED_SUFFIX = '.shielded';

/** True when `input` is a `.shielded` name rather than a raw address. */
export function isShieldedName(input: string): boolean {
  const v = input.trim().toLowerCase();
  return v.endsWith(SHIELDED_SUFFIX) && v.length > SHIELDED_SUFFIX.length;
}

/** The bare registry name for a `.shielded` input, normalized to match the
 *  resolver's `normalizeName` (NFC + trim + lowercase), or null if `input`
 *  isn't a `.shielded` name. */
export function shieldedNameOf(input: string): string | null {
  if (!isShieldedName(input)) return null;
  const bare = input.trim().slice(0, -SHIELDED_SUFFIX.length);
  return bare.normalize('NFC').trim().toLowerCase();
}

/** Send-to-name is a phishing surface: a name containing non-ASCII characters
 *  can mimic a familiar ASCII name (homograph attack). Warn on any non-ASCII
 *  codepoint. Pure-ASCII names — the overwhelmingly common case — never warn.
 *  Conservative by design: the cost of a spurious warning is far lower than a
 *  missed lookalike before an irreversible send. */
export function hasConfusableChars(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7f]/.test(name);
}
