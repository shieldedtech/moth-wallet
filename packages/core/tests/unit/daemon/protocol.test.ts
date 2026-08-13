import {describe, it, expect} from 'vitest';
import {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES,
  DaemonProtocolError,
} from '../../../src/daemon/protocol.js';

describe('encodeFrame / FrameDecoder', () => {
  it('round-trips a request frame', () => {
    const frame = {id: 'a', type: 'request' as const, method: 'ping', params: {n: 1}};
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame(frame));
    expect(out).toEqual([frame]);
  });

  it('round-trips a response frame with result', () => {
    const frame = {id: 'b', type: 'response' as const, result: 'pong'};
    const decoder = new FrameDecoder();
    expect(decoder.push(encodeFrame(frame))).toEqual([frame]);
  });

  it('round-trips a response frame with error', () => {
    const frame = {
      id: 'c',
      type: 'response' as const,
      error: {code: 'METHOD_NOT_FOUND', message: 'no handler'},
    };
    const decoder = new FrameDecoder();
    expect(decoder.push(encodeFrame(frame))).toEqual([frame]);
  });

  it('reassembles a frame split across multiple chunks', () => {
    const frame = {id: 'd', type: 'request' as const, method: 'echo', params: 'hello'};
    const bytes = encodeFrame(frame);
    const decoder = new FrameDecoder();

    // Push one byte at a time — the slowest reasonable chunk shape.
    let out: ReturnType<FrameDecoder['push']> = [];
    for (let i = 0; i < bytes.length; i++) {
      out = out.concat(decoder.push(bytes.subarray(i, i + 1)));
    }
    expect(out).toEqual([frame]);
    expect(decoder.pending).toBe(0);
  });

  it('emits multiple frames from a single chunk', () => {
    const a = {id: '1', type: 'request' as const, method: 'a'};
    const b = {id: '2', type: 'request' as const, method: 'b'};
    const c = {id: '3', type: 'response' as const, result: null};
    const combined = Buffer.concat([encodeFrame(a), encodeFrame(b), encodeFrame(c)]);
    const decoder = new FrameDecoder();
    expect(decoder.push(combined)).toEqual([a, b, c]);
  });

  it('buffers a partial header without throwing', () => {
    const frame = {id: 'e', type: 'request' as const, method: 'noop'};
    const bytes = encodeFrame(frame);
    const decoder = new FrameDecoder();
    // First three bytes of the 4-byte header → no frame complete yet
    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    expect(decoder.pending).toBe(3);
    // Remainder completes the frame
    expect(decoder.push(bytes.subarray(3))).toEqual([frame]);
    expect(decoder.pending).toBe(0);
  });

  it('rejects a frame whose declared length exceeds the cap', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(header)).toThrow(DaemonProtocolError);
  });

  it('rejects a non-JSON payload', () => {
    const garbage = Buffer.from('not json');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(garbage.length, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.concat([header, garbage]))).toThrow(DaemonProtocolError);
  });

  it('rejects a response that carries both result and error', () => {
    const payload = Buffer.from(
      JSON.stringify({
        id: 'x',
        type: 'response',
        result: 1,
        error: {code: 'INTERNAL_ERROR', message: 'oops'},
      }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.concat([header, payload]))).toThrow(
      /cannot carry both result and error/,
    );
  });

  it('rejects a frame with no id', () => {
    const payload = Buffer.from(JSON.stringify({type: 'request', method: 'oops'}));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.concat([header, payload]))).toThrow(/frame.id must be a string/);
  });

  it('rejects a request with no method', () => {
    const payload = Buffer.from(JSON.stringify({id: 'x', type: 'request'}));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.concat([header, payload]))).toThrow(/request.method must be a string/);
  });

  it('encodeFrame refuses to serialize a too-large frame', () => {
    const huge = {
      id: 'big',
      type: 'request' as const,
      method: 'x',
      params: 'a'.repeat(MAX_FRAME_BYTES + 1),
    };
    expect(() => encodeFrame(huge)).toThrow(DaemonProtocolError);
  });
});
