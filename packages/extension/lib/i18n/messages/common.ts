// Shared, screen-agnostic strings. Owned by the i18n core — screen catalogs
// live in their own files (one per area) so parallel edits never collide.

export const common = {
  common_cancel: 'Cancel',
  common_save: 'Save',
  common_back: 'Back',
  common_close: 'Close',
  common_done: 'Done',
  common_remove: 'Remove',
  common_extName: 'Moth Wallet (Dev)',
  common_extDescription:
    'Reference wallet for the Midnight Network. Development and testing only — not for mainnet funds.',
} as const;
