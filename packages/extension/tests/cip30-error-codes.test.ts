import { describe, expect, it } from 'vitest';
import {
  asCip30Error,
  CIP30_CODES,
  describeCip30Error,
} from '../lib/connector/errors';
import {
  CIP30_DATA_SIGN_ERROR,
  CIP30_ERROR,
  CIP30_TX_SEND_ERROR,
  CIP30_TX_SIGN_ERROR,
} from '@shieldedtech/moth-wallet/cardano/cip30';

// The background service worker cannot import core's Cardano module — CML's
// WASM needs top-level await and the background bundle is an IIFE — so the few
// codes the connector raises are mirrored in lib/connector/errors.ts. This test
// is the only thing keeping the mirror honest, which is why it imports core
// directly: under vitest there is no IIFE constraint.
describe('mirrored CIP-30 codes match core', () => {
  it('pins each mirrored code to its spec constant', () => {
    expect(CIP30_CODES.apiRefused).toBe(CIP30_ERROR.Refused);
    expect(CIP30_CODES.txSignUserDeclined).toBe(CIP30_TX_SIGN_ERROR.UserDeclined);
    expect(CIP30_CODES.dataSignUserDeclined).toBe(CIP30_DATA_SIGN_ERROR.UserDeclined);
    expect(CIP30_CODES.txSendRefused).toBe(CIP30_TX_SEND_ERROR.Refused);
  });

  it('keeps the signing codes distinct from APIError.Refused', () => {
    // The bug this guards: reporting a declined signature as APIError.Refused
    // (-3). A dApp catching TxSignError would never see it and would hang.
    expect(CIP30_CODES.txSignUserDeclined).not.toBe(CIP30_CODES.apiRefused);
    expect(CIP30_CODES.dataSignUserDeclined).not.toBe(CIP30_CODES.apiRefused);
  });
});

describe('asCip30Error', () => {
  it('recognises an APIError-shaped throw', () => {
    expect(asCip30Error({ code: -1, info: 'bad' })).toEqual({ code: -1, info: 'bad' });
  });

  it('recognises a PaginateError, which has no code at all', () => {
    expect(asCip30Error({ maxSize: 3 })).toEqual({ maxSize: 3 });
  });

  it('ignores a Midnight connector error, whose code is a string', () => {
    // Left to the existing path: it has a message, and its string code is what
    // a Midnight dApp switches on.
    const err = Object.assign(new Error('nope'), { code: 'Rejected', reason: 'nope' });
    expect(asCip30Error(err)).toBeUndefined();
  });

  it('ignores a plain Error and non-objects', () => {
    expect(asCip30Error(new Error('boom'))).toBeUndefined();
    expect(asCip30Error('boom')).toBeUndefined();
    expect(asCip30Error(null)).toBeUndefined();
  });

  it('describes both shapes without stringifying to [object Object]', () => {
    // The failure this replaced: a plain CIP-30 throw has no `.message`, so the
    // generic path reduced it to String(err) and dropped `info` entirely.
    expect(describeCip30Error({ code: -1, info: 'bad request' })).toContain('bad request');
    expect(describeCip30Error({ maxSize: 3 })).toContain('3');
    expect(describeCip30Error({ code: -1, info: 'x' })).not.toContain('[object Object]');
  });
});
