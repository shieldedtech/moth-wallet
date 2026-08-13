// Typed message lookup over the standard web-extension `_locales` format.
//
// `t(key)` asks `browser.i18n.getMessage` first — Chrome resolves the browser
// locale against `_locales/<lang>/messages.json` (the `en` catalog is emitted
// from `messages/` at build time; see wxt.config.ts). When the API is absent
// (vitest's node environment) or the key is missing from the packed catalogs,
// it falls back to the bundled English source, so tests assert real copy and a
// missing translation can never render a blank string.
//
// Substitutions use the format's positional `$1`…`$9`.

import { browser } from 'wxt/browser';
import { MESSAGES, type MessageKey } from './messages';

export type { MessageKey };

function substitute(text: string, subs: string[]): string {
  return text.replace(/\$(\d)/g, (match, index) => subs[Number(index) - 1] ?? match);
}

export function t(key: MessageKey, substitutions?: Array<string | number>): string {
  const subs = substitutions?.map(String) ?? [];
  try {
    // WXT types getMessage against the checked-in public/_locales (none — the
    // en catalog is emitted at build time), so widen to the real signature.
    const getMessage = browser.i18n?.getMessage as
      | ((key: string, substitutions?: string[]) => string)
      | undefined;
    const translated = getMessage?.(key, subs);
    if (translated) return translated;
  } catch {
    /* no extension runtime (tests) — fall through to the bundled English */
  }
  return substitute(MESSAGES[key], subs);
}
