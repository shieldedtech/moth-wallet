import type { ProverConfig } from '@shieldedtech/moth-wallet/types/network';
import { t } from '../i18n';

export type ProverType = ProverConfig['type'];

/** User-facing status for the proving backend resolved from Network settings. */
export function provingMethodStatus(proverType: ProverType | null): string {
  if (proverType === 'wasm') return t('status_provingLocal');
  if (proverType === 'server') return t('status_provingServer');
  return t('status_provingLoading');
}
