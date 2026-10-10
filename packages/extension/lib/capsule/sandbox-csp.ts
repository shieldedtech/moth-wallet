// The capsule executor page compiles contract code from text, which only a sandbox page may do,
// and loads its own script, which carries the runtime's wasm inside it; nothing is fetched, so a
// module evaluated there has no network at all. Hand-written and asserted byte-exact by the
// extension's e2e test, since the browser checks only that the sandbox directive is present.
// Chrome's default would also grant 'unsafe-inline', forms, popups and modals; Firefox's would
// grant no eval at all, so both eval tokens are named rather than inherited.
//
// IMPORTANT: no runtime imports — wxt.config.ts and the e2e test both read this.
export const CAPSULE_SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'";

/** The executor page's path in the built extension (WXT drops the `.sandbox` suffix). */
export const CAPSULE_EXECUTOR_PAGE = 'executor.html';
