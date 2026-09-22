// The confirm screen quotes a DUST fee, and nothing showed what the send
// actually paid. On preprod a quote of 0.3 accompanied a balance drop of about
// 3.8 once regeneration over the same window was added back, so these lines
// exist to pin the two numbers side by side.

import { describe, expect, it } from 'vitest';
import type { DustFeePass } from '@shieldedtech/moth-browser';
import { formatDustFeeEstimate, formatDustFeePass } from '../lib/offscreen/dust-fee-log';

const DUST = 10n ** 15n;

const pass = (over: Partial<DustFeePass> = {}): DustFeePass => ({
  selector: 'configured',
  pass: 1,
  deficit: DUST / 2n,
  added: 1,
  inputs: 1,
  coverage: 3_605_140_000_000_000_000n,
  fee: 3_820_000_000_000_000n,
  converged: true,
  ...over,
});

describe('formatDustFeePass', () => {
  it('reports the converged fee in DUST and in raw specks', () => {
    const line = formatDustFeePass(pass());

    expect(line).toContain('fee 3.820000 (3820000000000000 specks)');
    expect(line).toContain('coverage 3605.140000');
    expect(line).toContain('inputs 1');
    expect(line).toContain('converged');
  });

  it('says a pass fell short rather than calling it converged', () => {
    const line = formatDustFeePass(pass({ pass: 2, inputs: 3, converged: false }));

    expect(line).toContain('pass 2');
    expect(line).toContain('short, selecting more');
    expect(line).not.toContain('· converged');
  });

  it('keeps sub-speck precision that a rounded DUST figure would hide', () => {
    const line = formatDustFeePass(pass({ fee: 1n }));

    expect(line).toContain('fee 0.000000 (1 specks)');
  });

  it('names the selector, since the fallback picks different coins', () => {
    expect(formatDustFeePass(pass({ selector: 'largest-first-fallback' }))).toContain(
      'selector largest-first-fallback',
    );
  });
});

describe('formatDustFeeEstimate', () => {
  it('labels the quote the confirm screen is about to show', () => {
    expect(formatDustFeeEstimate(300_000_000_000_000n, 1)).toBe(
      '[moth dust-fee] estimate for 1 transfer: 0.300000 (300000000000000 specks)',
    );
  });

  it('pluralises a batch', () => {
    expect(formatDustFeeEstimate(DUST, 3)).toContain('estimate for 3 transfers');
  });
});
