export const syncStatus = {
  syncStatus_synced: 'Synced',
  syncStatus_syncing: 'Syncing',
  syncStatus_syncingAria: 'Syncing, $1%',
  syncStatus_percent: '$1%',
  syncStatus_shielded: 'Shielded',
  syncStatus_unshielded: 'Unshielded',
  // Per-unit, following the dust ETA keys: the unit belongs inside the
  // translated sentence, not concatenated in the component.
  syncStatus_etaSeconds: '~$1s left',
  syncStatus_etaMinutes: '~$1 min left',
  syncStatus_etaHours: '~$1 h left',
  syncStatus_etaHoursMinutes: '~$1 h $2 min left',
} as const;
