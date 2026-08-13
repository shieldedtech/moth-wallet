import type { ProverConfig } from '@shieldedtech/moth-wallet/types/network';

export type ProverType = ProverConfig['type'];

/** User-facing status for the proving backend resolved from Network settings. */
export function provingMethodStatus(proverType: ProverType | null): string {
  if (proverType === 'wasm') return 'Using local WASM proving.';
  if (proverType === 'server') return 'Using the configured proof server.';
  return 'Loading the proving method…';
}
