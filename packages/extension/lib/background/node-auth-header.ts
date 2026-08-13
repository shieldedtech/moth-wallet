// Attach an auth header to requests to the node.
//
// Why this needs declarativeNetRequest at all: the node connection is a
// WebSocket, and a browser cannot set headers on a WS handshake —
// `new WebSocket(url, protocols)` takes no header argument. Nothing in JS
// reaches it. declarativeNetRequest's `modifyHeaders` action does, because it
// operates on the request before it leaves the browser and its resource types
// include `websocket`.
//
// Scoped to the node host only. The indexer is not rate-limited today, and a
// credential should reach as few destinations as it can. If that changes it
// wants its own field rather than widening this one.
//
// The rule contains the credential, so it is dynamic (never in a static
// ruleset that would ship in the package) and is REMOVED when the header is
// cleared or the node URL changes, rather than left behind pointing at a host
// the wallet no longer uses.

import { browser } from 'wxt/browser';
import type { NodeAuthHeader } from '../messaging/protocol';

/** Fixed id so each update replaces the previous rule instead of accumulating
 *  one per settings save. */
const RULE_ID = 1;

declare const chrome: {
  declarativeNetRequest?: {
    updateDynamicRules(options: {
      removeRuleIds?: number[];
      addRules?: unknown[];
    }): Promise<void>;
    getDynamicRules?(): Promise<unknown[]>;
  };
};

/** Host of the node endpoint, or null if the URL is unusable. Only the host is
 *  matched: the node speaks both `wss://` and `https://` on the same origin, and
 *  a scheme-specific filter would silently miss one. */
export function nodeHostFor(nodeUrl: string): string | null {
  try {
    const { hostname } = new URL(nodeUrl);
    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}

/**
 * Install, replace or remove the header rule.
 *
 * Best-effort: a browser without declarativeNetRequest (or a Firefox build,
 * where the extension is unsupported anyway) simply gets no rule. Failing to
 * install a rule must not stop the wallet from starting — the visible symptom
 * is the node refusing connections, which the relay banner already reports.
 */
export async function applyNodeAuthHeader(
  nodeUrl: string,
  header: NodeAuthHeader | undefined,
): Promise<boolean> {
  const dnr = chrome?.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return false;

  const host = header ? nodeHostFor(nodeUrl) : null;

  try {
    // Always clear first, so removing the header or repointing the node URL
    // cannot leave a stale rule attaching a credential to the wrong host.
    if (!header || !host) {
      await dnr.updateDynamicRules({ removeRuleIds: [RULE_ID] });
      return false;
    }

    await dnr.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        {
          id: RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: header.name, operation: 'set', value: header.value }],
          },
          condition: {
            // requestDomains, not urlFilter: matching on the host avoids
            // depending on how the URL was spelled (scheme, trailing slash,
            // default port), the same normalisation trap that made the relay
            // backoff inert.
            requestDomains: [host],
            resourceTypes: ['websocket', 'xmlhttprequest', 'other'],
          },
        },
      ],
    });
    return true;
  } catch {
    // Never let a rule problem break startup.
    return false;
  }
}

/** Drop the rule — used when settings are cleared or the wallet is reset. */
export async function clearNodeAuthHeader(): Promise<void> {
  try {
    await chrome?.declarativeNetRequest?.updateDynamicRules({ removeRuleIds: [RULE_ID] });
  } catch {
    /* nothing to clear */
  }
}
