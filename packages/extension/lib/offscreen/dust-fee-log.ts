// Diagnostics for the DUST fee a transaction actually pays.
//
// The fee preview and the real spend share the SDK's balancing recipe, so both
// emit these passes, but only the preview's number reaches the UI. Logging
// both is the one way to see, without querying the chain, whether a send cost
// what the confirm screen quoted.

import type { DustFeePass } from '@shieldedtech/moth-browser';

const PREFIX = '[moth dust-fee]';
const DUST_UNIT = 10n ** 15n;

/** Whole DUST with six decimals, beside the raw specks so nothing rounds away. */
function dust(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / DUST_UNIT;
  const fraction = (abs % DUST_UNIT).toString().padStart(15, '0').slice(0, 6);
  return `${negative ? '-' : ''}${whole}.${fraction} (${raw} specks)`;
}

/** One line per balancing pass; the converged one carries the fee that will be paid. */
export function formatDustFeePass(pass: DustFeePass): string {
  const parts = [
    `pass ${pass.pass}`,
    `selector ${pass.selector}`,
    `inputs ${pass.inputs}`,
    `coverage ${dust(pass.coverage)}`,
    `fee ${dust(pass.fee)}`,
    pass.converged ? 'converged' : 'short, selecting more',
  ];
  return `${PREFIX} ${parts.join(' · ')}`;
}

/** The quote the confirm screen is about to show, for comparison with the spend. */
export function formatDustFeeEstimate(fee: bigint, transfers: number): string {
  return `${PREFIX} estimate for ${transfers} transfer${transfers === 1 ? '' : 's'}: ${dust(fee)}`;
}

export function logDustFeePass(pass: DustFeePass): void {
  console.log(formatDustFeePass(pass));
}

export function logDustFeeEstimate(fee: bigint, transfers: number): void {
  console.log(formatDustFeeEstimate(fee, transfers));
}
