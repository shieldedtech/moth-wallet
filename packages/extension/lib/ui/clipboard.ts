// Clipboard writes for secrets (recovery phrases, hex seeds).
//
// Extracted so every place that puts key material on the clipboard clears it
// again the same way. A recovery phrase left on a shared clipboard is readable
// by any other app on the machine, so the copy button is the start of an
// exposure window, not the end of an action.

/** How long a secret is allowed to sit on the clipboard before we try to take
 *  it back. Long enough to paste somewhere deliberate, short enough that it is
 *  gone before the user has moved on. */
export const SECRET_CLIPBOARD_CLEAR_MS = 60_000;

/**
 * Copy a secret, then best-effort clear it after {@link SECRET_CLIPBOARD_CLEAR_MS}.
 *
 * The clear is guarded by a read so it only wipes the clipboard if it STILL
 * holds this secret — never clobbering something the user copied in the
 * meantime. Silently degrades where the environment forbids the delayed read
 * (clipboard-read permission is not granted everywhere), because failing to
 * clear must not turn into a visible error on a copy that worked.
 */
export async function copySecret(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  setTimeout(() => {
    void navigator.clipboard
      .readText()
      .then((current) => (current === value ? navigator.clipboard.writeText('') : undefined))
      .catch(() => {});
  }, SECRET_CLIPBOARD_CLEAR_MS);
}
