export const accounts = {
  accounts_title: 'Accounts',
  accounts_newAccount: '+ New account',
  accounts_intro: 'Each account has its own shielded and unshielded addresses, plus fee-generation state.',
  accounts_networkAria: 'Network: $1',
  accounts_menuAria: 'Account menu',
  accounts_renameMenu: 'Rename account',
  accounts_removeMenu: 'Remove account',
  accounts_removeNote: 'Removing an account only hides it here. You can bring it back with your secret phrase.',
  accounts_removeTitle: 'Remove $1?',
  accounts_removeBody:
    'This hides the account from Moth. Its addresses and tokens stay on Midnight. You can bring it back anytime with your 24 words.',
  accounts_renameTitle: 'Rename $1',
  accounts_namePlaceholder: 'Account name',
  accounts_renameHint: 'Only shown in this wallet. Leave empty to go back to the default name.',
  accounts_revealMenu: 'Reveal secret phrase',
  // Reveal can show either artifact. Chosen before the password is entered so
  // only what was asked for is ever decrypted.
  accounts_revealAsBackup:
    'Recovery phrase',
  accounts_revealAsSeed:
    'Hex seed',
  accounts_revealAsBackupNote:
    'Reveals what this account was created from. Accounts restored from a seed show that seed, because they have no phrase.',
  accounts_revealAsSeedNote:
    'Reveals the hex seed your 24 words expand to. Some tools take a seed instead of a phrase. It has no built-in check, so copy it exactly.',
  accounts_revealTitle: 'Secret phrase for $1',
  accounts_revealHint: "Enter this account's password to reveal its secret phrase.",
  accounts_revealPasswordPlaceholder: 'Account password',
  accounts_revealButton: 'Reveal',
  accounts_revealWrongPassword: 'Wrong password for this account.',
  accounts_revealWarning:
    "Anyone with these words can spend your tokens. Don't screenshot them, and never share them, not even with us.",
  accounts_revealSeedNote:
    'This account was imported from a raw hex seed, so it has no word phrase. Back up this seed instead.',
  accounts_revealCopy: 'Copy to clipboard',
  accounts_revealCopied: 'Secret phrase copied — paste it somewhere safe. It clears from your clipboard in 1 minute.',
} as const;
