// Length-prefixed JSON-over-stream framing for the moth wallet daemon.
//
// Wire format: 4-byte big-endian uint32 payload length, then that many bytes
// of UTF-8 JSON. Streams are bidirectional and full-duplex; either side may
// emit Request or Response frames at any time, correlated by `id`. There is
// no built-in keepalive — the underlying Unix stream socket detects
// peer-close cleanly and that's enough.
//
// All sizes are bounded. A frame larger than MAX_FRAME_BYTES is rejected
// without buffering, so a misbehaving peer can't drive the daemon into an
// unbounded allocation.

export const PROTOCOL_VERSION = 'moth-wallet-daemon/1';

/** Bound on a single frame's payload size. Practical state snapshots are well
 *  under 1MB today; cap above lets the wire format grow without immediate
 *  ceiling changes. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type RequestFrame = {
  readonly id: string;
  readonly type: 'request';
  readonly method: string;
  readonly params?: unknown;
};

export type ResponseFrame = {
  readonly id: string;
  readonly type: 'response';
  readonly result?: unknown;
  readonly error?: {readonly code: string; readonly message: string};
};

export type Frame = RequestFrame | ResponseFrame;

export type RpcErrorCode =
  | 'METHOD_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR'
  | 'CLOSED'
  | 'TIMEOUT'
  | 'UNAUTHORIZED';

export class DaemonProtocolError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonProtocolError';
  }
}

export function encodeFrame(frame: Frame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf-8');
  if (json.length > MAX_FRAME_BYTES) {
    throw new DaemonProtocolError(
      'INVALID_REQUEST',
      `frame too large: ${json.length} bytes (max ${MAX_FRAME_BYTES})`,
    );
  }
  const lenHeader = Buffer.alloc(4);
  lenHeader.writeUInt32BE(json.length, 0);
  return Buffer.concat([lenHeader, json]);
}

/**
 * Streaming decoder. push() accepts arbitrary chunks; complete frames come
 * out in order, partial bytes stay buffered. Throws DaemonProtocolError on
 * an over-large declared length so the caller can disconnect the peer
 * before allocating.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Frame[] = [];

    while (this.buffer.length >= 4) {
      const payloadLen = this.buffer.readUInt32BE(0);
      if (payloadLen > MAX_FRAME_BYTES) {
        throw new DaemonProtocolError(
          'INVALID_REQUEST',
          `declared frame length ${payloadLen} exceeds max ${MAX_FRAME_BYTES}`,
        );
      }
      if (this.buffer.length < 4 + payloadLen) break;

      const json = this.buffer.subarray(4, 4 + payloadLen).toString('utf-8');
      this.buffer = this.buffer.subarray(4 + payloadLen);
      const parsed = parseFrame(json);
      out.push(parsed);
    }

    return out;
  }

  /** Bytes still buffered (incomplete frame). Useful for diagnostics/tests. */
  get pending(): number {
    return this.buffer.length;
  }
}

function parseFrame(json: string): Frame {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new DaemonProtocolError(
      'INVALID_REQUEST',
      `frame is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!raw || typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_REQUEST', 'frame is not a JSON object');
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== 'string') {
    throw new DaemonProtocolError('INVALID_REQUEST', 'frame.id must be a string');
  }
  if (f.type === 'request') {
    if (typeof f.method !== 'string') {
      throw new DaemonProtocolError('INVALID_REQUEST', 'request.method must be a string');
    }
    return {id: f.id, type: 'request', method: f.method, params: f.params};
  }
  if (f.type === 'response') {
    if (f.error !== undefined && f.result !== undefined) {
      throw new DaemonProtocolError(
        'INVALID_REQUEST',
        'response cannot carry both result and error',
      );
    }
    if (f.error !== undefined) {
      const e = f.error as Record<string, unknown>;
      if (typeof e.code !== 'string' || typeof e.message !== 'string') {
        throw new DaemonProtocolError(
          'INVALID_REQUEST',
          'response.error must have string code and message',
        );
      }
      return {
        id: f.id,
        type: 'response',
        error: {code: e.code, message: e.message},
      };
    }
    return {id: f.id, type: 'response', result: f.result};
  }
  throw new DaemonProtocolError(
    'INVALID_REQUEST',
    `frame.type must be "request" or "response", got ${String(f.type)}`,
  );
}
