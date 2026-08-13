import { SyncStatus } from '@shieldedtech/moth-extension';

export const Syncing = () => (
  <div className="flex justify-end" style={{ minHeight: 56 }}>
    <SyncStatus view={{ shielded: 64, unshielded: 100, dust: 91 }} />
  </div>
);

export const PopoverOpen = () => (
  <div className="flex justify-end" style={{ minHeight: 210 }}>
    <SyncStatus view={{ shielded: 64, unshielded: 100, dust: 91 }} defaultOpen />
  </div>
);

export const Synced = () => (
  <div className="flex justify-end" style={{ minHeight: 56 }}>
    <SyncStatus view={{ shielded: 100, unshielded: 100, dust: 100 }} />
  </div>
);
