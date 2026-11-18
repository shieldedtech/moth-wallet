// ISOLATED-world relay: injects the MAIN-world provider script, then shuttles
// request envelopes from the page to the background and responses back.
// Injection via web_accessible_resources script tag (not manifest
// world: 'MAIN') so it works on Firefox < 128 too.

import { defineContentScript, injectScript } from '#imports';
import { browser, type Browser } from 'wxt/browser';
import { CONNECTOR_PORT, sendMessage } from '../lib/messaging/protocol';
import {
  PAGE_REQUEST_EVENT,
  isPageRequest,
  type PageRequestEnvelope,
  type PageResponseEnvelope,
} from '../lib/messaging/page-transport';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    // One port per document, opened before its first request: the background drops
    // this page's pending prompts when the port closes with the page.
    let presence: Browser.runtime.Port | null = null;
    const announcePresence = () => {
      if (presence) return;
      try {
        presence = browser.runtime.connect({ name: CONNECTOR_PORT });
        // A restarted service worker drops the port; the next request reopens it.
        presence.onDisconnect.addListener(() => {
          presence = null;
        });
      } catch {
        presence = null;
      }
    };

    const relay = ({ id, method, paramsJson }: PageRequestEnvelope) => {
      announcePresence();
      // Do not await here. sendMessage() must start during the synchronous DOM
      // event so Chrome carries the dApp click's user activation to background.
      void sendMessage('connectorRequest', { method, paramsJson })
        .catch((err): { ok: false; error: { code: 'InternalError'; reason: string } } => ({
          ok: false,
          error: { code: 'InternalError', reason: String(err instanceof Error ? err.message : err) },
        }))
        .then((outcome) => {
          const response: PageResponseEnvelope = outcome.ok
            ? { __moth: true, dir: 'cs->page', id, ok: true, resultJson: outcome.resultJson }
            : { __moth: true, dir: 'cs->page', id, ok: false, error: outcome.error };
          window.postMessage(response, '*');
        });
    };

    window.addEventListener(PAGE_REQUEST_EVENT, (event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== 'string') return;
      try {
        const request: unknown = JSON.parse(detail);
        if (isPageRequest(request)) relay(request);
      } catch {
        /* malformed page input */
      }
    });

    await injectScript('/injected.js');
  },
});
