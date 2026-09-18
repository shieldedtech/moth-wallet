import type {NetworkConfig} from '@shieldedtech/moth-wallet/types/network';
import type {EmptyRefStates, WarmProgress} from '@shieldedtech/moth-wallet/sync/preseed';
import type {ReferenceSnapshot, ReferenceVersion} from '@shieldedtech/moth-wallet/sync/reference-versions';

export type ReferenceJob =
  | {kind: 'contribute'; network: NetworkConfig; snapshot: Omit<EmptyRefStates, 'height'>; source: ReferenceVersion | null}
  | {kind: 'refresh'; network: NetworkConfig; reference: ReferenceVersion | null; prefix: string};
export type ReferenceJobMessage =
  | {kind: 'progress'; message?: string; progress?: WarmProgress}
  | {kind: 'complete'; snapshot: ReferenceSnapshot | null}
  | {kind: 'failed'};
