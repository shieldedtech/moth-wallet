// What the "Speed up new accounts" row should offer, given the reference status.
//
// The setting predates bundling. When it was written, no reference shipped with
// the extension, so building one on the device — a chain walk, 53.6 min measured
// on preprod — was the only way to get one, and offering it everywhere was
// right.
//
// It is no longer right everywhere. preprod ships a reference in the package
// (see offscreen/bundled-preseed.ts), installed on the first unlock. Offering to
// build one there is offering an hour of work to arrive at what the user already
// has on disk. So the control is now scoped to the case it was always for:
// networks this release ships nothing prepared for.
//
// Note what this does NOT claim to fix. Because of the `height <= birthday`
// guard, warming can never help the account whose creation prompted the user to
// turn it on — only later ones. That was true before bundling and stays true;
// the copy says "accounts created after it finishes" for that reason.
//
// Pure and dependency-free so the three states are unit-testable without
// rendering Settings or standing up the offscreen document.

export type PreseedControl =
  /** Status not in yet (offscreen still coming up). Render nothing: guessing
   *  either way shows the user a claim that a poll one tick later retracts. */
  | 'unknown'
  /** A usable reference is in the store. Nothing to offer, nothing to wait for. */
  | 'ready'
  /** This release ships one for this network; it installs on unlock. Show that
   *  it is handled, but offer no build — the build would be redundant work. */
  | 'included'
  /** No reference, and none shipped. The on-device build is the only route, so
   *  this is the one case where the toggle earns its place. */
  | 'offer';

export function preseedControl(status: { ready: boolean; bundled: boolean } | null): PreseedControl {
  if (!status) return 'unknown';
  if (status.ready) return 'ready';
  return status.bundled ? 'included' : 'offer';
}
