// Request/response envelopes shared by the injected provider (MAIN world) and
// the content-script relay (ISOLATED world). Requests use a synchronous DOM
// event so a dApp click's user activation reaches gesture-gated extension APIs
// such as sidePanel.open(); responses use window.postMessage as before.
//
// SECURITY: nothing in this envelope is trusted for authorization. The
// background derives the requesting origin exclusively from the content
// script's message sender, never from page-supplied data.

import type { SerializedConnectorError } from '../connector/errors';

export const ENVELOPE_MARK = '__moth' as const;
export const PAGE_REQUEST_EVENT = '__moth_connector_request__';

export interface PageRequestEnvelope {
  __moth: true;
  dir: 'page->cs';
  id: string;
  method: string;
  /** bigint-JSON encoded argument array */
  paramsJson: string;
}

export interface PageResponseEnvelope {
  __moth: true;
  dir: 'cs->page';
  id: string;
  ok: boolean;
  /** bigint-JSON encoded result (when ok) */
  resultJson?: string;
  error?: SerializedConnectorError;
}

export function isPageRequest(data: unknown): data is PageRequestEnvelope {
  const d = data as PageRequestEnvelope | null;
  return (
    !!d &&
    typeof d === 'object' &&
    d.__moth === true &&
    d.dir === 'page->cs' &&
    typeof d.id === 'string' &&
    typeof d.method === 'string' &&
    typeof d.paramsJson === 'string'
  );
}

export function isPageResponse(data: unknown): data is PageResponseEnvelope {
  const d = data as PageResponseEnvelope | null;
  return (
    !!d &&
    typeof d === 'object' &&
    d.__moth === true &&
    d.dir === 'cs->page' &&
    typeof d.id === 'string' &&
    typeof d.ok === 'boolean'
  );
}

export interface PageClient {
  request(method: string, paramsJson: string, timeoutMs?: number): Promise<string>;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60_000; // approvals + proving are slow

/**
 * Page-side requester: correlates responses by id, times out, and surfaces
 * connector errors via the onError factory so the caller controls the shape.
 */
export function createPageClient(
  target: Pick<Window, 'dispatchEvent'>,
  listen: (handler: (event: MessageEvent) => void) => void,
  onError: (error: SerializedConnectorError) => Error,
  randomId: () => string = () => crypto.randomUUID(),
): PageClient {
  const pending = new Map<string, { resolve: (resultJson: string) => void; reject: (err: Error) => void }>();

  listen((event) => {
    if (!isPageResponse(event.data)) return;
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) {
      entry.resolve(event.data.resultJson ?? 'null');
    } else {
      entry.reject(onError(event.data.error ?? { code: 'InternalError', reason: 'Unknown error' }));
    }
  });

  return {
    request(method, paramsJson, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const id = randomId();
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(onError({ code: 'InternalError', reason: `Request timed out: ${method}` }));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        const envelope: PageRequestEnvelope = { __moth: true, dir: 'page->cs', id, method, paramsJson };
        // Keep detail string-only: Firefox blocks cross-world access to
        // non-string CustomEvent details, while JSON works in both browsers.
        target.dispatchEvent(new CustomEvent(PAGE_REQUEST_EVENT, { detail: JSON.stringify(envelope) }));
      });
    },
  };
}
