/**
 * Proving that a stored sync cursor still means what it meant when it was written.
 *
 * Sync cursors (`offset` / `appliedIndex`) are indexer-assigned event sequence
 * numbers, not chain-derived ones. Nothing in the event payload ties an id to a
 * block: `DustLedgerEvent` exposes only `id`, `raw`, `maxId` and
 * `protocolVersion`. So when the same URL starts serving a differently-numbered
 * stream — a re-index, a blue/green cutover — a stored cursor keeps pointing at
 * a number that now names a different event, and nothing anywhere notices.
 *
 * That happened on preprod. The default indexer had a 22-wide hole in its dust id
 * space; the host now serving that name numbers contiguously, so cursors written
 * before the change sit 22 events too high, silently skipping events rather than
 * failing.
 *
 * A WITNESS closes that. When a cursor is stored, also store a hash of the event
 * at that id. On resume, re-read the event at the id and compare: equal means the
 * numbering underneath this cursor is unchanged, different means it moved and the
 * cursor must not be trusted.
 *
 * Why a witness rather than one global indexer fingerprint: a fingerprint has to
 * be sampled at some fixed id, and any id below the point where two numberings
 * diverge returns the SAME event from both. Sampled at preprod's hole (989781),
 * old and new both return the event new calls 989781 — old's first existing id at
 * or above the probe was 989803, which is the same event. A fingerprint there
 * would have matched across the exact cutover it existed to detect, and the
 * divergence point is not knowable in advance. A witness has no such blind spot,
 * because it asks about the one id the cache actually depends on.
 */

/** Which event stream a cursor belongs to. */
export type WitnessStream = 'dustLedgerEvents' | 'zswapLedgerEvents';

export interface CursorWitness {
  /** Event stream the cursor indexes into. */
  readonly stream: WitnessStream;
  /** The cursor value witnessed. */
  readonly id: number;
  /** Hash of the event payload found at `id`. */
  readonly digest: string;
}

/** Verdict for a stored witness re-checked against a live indexer. */
export type WitnessVerdict =
  /** Same event at the same id: the cursor is still valid. */
  | {kind: 'valid'}
  /** A different event now sits at that id: every cursor from this store is suspect. */
  | {kind: 'renumbered'; expected: string; actual: string}
  /** Could not be established. Callers must NOT treat this as valid. */
  | {kind: 'unknown'; reason: string};

/** Derive the subscription endpoint from the indexer's HTTP URL. */
function wsUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
  return url.toString();
}

/**
 * Hash an event payload.
 *
 * SHA-256 via WebCrypto, which Node 18+ and browsers both provide — this module
 * lives in `core`, so `node:crypto` is not available to it. Truncated to 16 hex
 * characters: this detects a changed event, it does not authenticate one, and a
 * shorter value keeps the stored witness small.
 */
async function digestOf(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * Read the first event at or after `id` and hash it.
 *
 * Returns null when the stream yields nothing — which is itself informative: an
 * id above the indexer's `maxId` produces an ack and then silence, no error, and
 * that is the state a cursor from a longer stream lands in.
 */
export async function readEventWitness(
  indexerUrl: string,
  stream: WitnessStream,
  id: number,
  opts: {timeoutMs?: number} = {},
): Promise<CursorWitness | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const ws = new WebSocket(wsUrl(indexerUrl), 'graphql-transport-ws');

  return new Promise<CursorWitness | null>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn();
    };
    // A stream that goes quiet is the "cursor past the end" case, not a failure
    // to reach the indexer, so it resolves null rather than rejecting.
    const timer = setTimeout(() => finish(() => resolve(null)), timeoutMs);

    ws.onopen = () => ws.send(JSON.stringify({type: 'connection_init'}));
    ws.onerror = () => finish(() => reject(new Error(`Could not reach ${wsUrl(indexerUrl)}`)));

    ws.onmessage = (event: MessageEvent) => {
      let msg: {type?: string; payload?: unknown};
      try {
        msg = JSON.parse(String(event.data)) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === 'connection_ack') {
        ws.send(
          JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: {query: `subscription { ${stream}(id: ${id}) { id raw } }`},
          }),
        );
        return;
      }

      if (msg.type === 'next') {
        const data = (msg.payload as {data?: Record<string, {id?: number; raw?: string}>} | undefined)?.data;
        const event_ = data?.[stream];
        if (!event_ || typeof event_.raw !== 'string' || typeof event_.id !== 'number') return;
        const {id: gotId, raw} = event_;
        void digestOf(raw).then((digest) => finish(() => resolve({stream, id: gotId, digest})));
        return;
      }

      if (msg.type === 'error') {
        finish(() => reject(new Error(`Indexer rejected the witness subscription: ${JSON.stringify(msg.payload)}`)));
        return;
      }
      if (msg.type === 'complete') finish(() => resolve(null));
    };
  });
}

/**
 * Compare a stored witness against what the indexer actually returned.
 *
 * Pure, and separate from the read on purpose: the interesting behaviour is the
 * verdict, and a verdict function that also performs I/O can only be tested by
 * mocking a transport. `observed` is null when the stream yielded nothing.
 *
 * Fails closed. Anything short of a positive match is `renumbered` or `unknown`,
 * and callers must discard the cursor for both — treating `unknown` as valid
 * would reintroduce the silence this exists to break.
 */
export function compareWitness(stored: CursorWitness, observed: CursorWitness | null): WitnessVerdict {
  if (observed === null) {
    // The id is past this stream's end. On a shorter stream that is precisely
    // what a cursor from a longer one looks like, so it is a signal, not an
    // absence of one.
    return {
      kind: 'unknown',
      reason: `no event at or after id ${stored.id} — the stream may be shorter than this cursor`,
    };
  }

  // The id may legitimately advance: subscribing at an id inside a gap returns
  // the next existing event. What must not change is the event found there.
  if (observed.digest === stored.digest) return {kind: 'valid'};
  return {kind: 'renumbered', expected: stored.digest, actual: observed.digest};
}

/**
 * Re-check a stored witness against the indexer now serving that URL.
 *
 * Convenience over `readEventWitness` + `compareWitness`, with an unreachable
 * indexer mapped to `unknown` rather than thrown, so a caller deciding whether to
 * trust a cache has one shape to handle.
 */
export async function verifyCursorWitness(
  indexerUrl: string,
  witness: CursorWitness,
  opts: {timeoutMs?: number} = {},
): Promise<WitnessVerdict> {
  try {
    return compareWitness(witness, await readEventWitness(indexerUrl, witness.stream, witness.id, opts));
  } catch (err) {
    return {kind: 'unknown', reason: `indexer unreachable: ${err instanceof Error ? err.message : String(err)}`};
  }
}
