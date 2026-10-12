// Build flavor: a side-by-side variant of the extension (e.g. `WXT_MOTH_FLAVOR=gloam`).
// A flavored build gets its own dApp-connector slots (window.midnight.<id> and the
// CIP-30 window.cardano.<id>), rdns, display name and page request event, so it can be installed next to the regular
// Moth Wallet without either one shadowing or answering for the other. Unset = the
// regular build, unchanged. Browser storage and the extension ID are already
// per-install, so they need nothing here.

export const flavorOf = (raw: string | undefined): string => {
  const f = (raw ?? '').trim().toLowerCase();
  if (f !== '' && !/^[a-z][a-z0-9]{0,15}$/.test(f)) throw new Error(`invalid WXT_MOTH_FLAVOR: ${raw}`);
  return f;
};

export const FLAVOR = flavorOf(import.meta.env?.WXT_MOTH_FLAVOR as string | undefined);

const title = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);

export const flavored = (f: string) => ({
  walletId: f ? `moth${title(f)}` : 'moth',
  /** CIP-30 key under window.cardano. Kept equal to walletId so a flavored build's
   *  Cardano provider sits beside — never on top of — a regular Moth's. */
  cardanoId: f ? `moth${title(f)}` : 'moth',
  rdns: f ? `io.shielded.moth.${f}` : 'io.shielded.moth',
  name: f ? `Moth Wallet (${title(f)})` : 'Moth Wallet',
  requestEvent: f ? `__moth_${f}_connector_request__` : '__moth_connector_request__',
});

/**
 * Where `wxt build` writes. `MOTH_EXT_OUT_DIR` pins a fixed directory (stable
 * extension ID); a flavored build suffixes it — or uses `.output-<flavor>` — so
 * building one flavor never overwrites the other's unpacked extension.
 */
export const flavoredOutDir = (fixedDir: string | undefined, f: string): string => {
  const base = fixedDir?.trim() ? fixedDir.trim().replace(/\/+$/, '') : '';
  if (base) return f ? `${base}-${f}` : base;
  return f ? `.output-${f}` : '.output';
};
