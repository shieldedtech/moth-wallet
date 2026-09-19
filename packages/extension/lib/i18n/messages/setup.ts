export const setup = {
// The tagline describes the tool, not the network. "Money, but private." made
// two claims this wallet does not keep: a fresh install lands on preprod (see
// DEFAULT_SETTINGS — deliberately not mainnet, because this is unaudited), so
// there is no money; and the unshielded sub-wallet is public on chain, so
// privacy is not unconditional. Both lines stay short because the setup tab
// sets them at 72px in a 520px column.
  setup_taglineLine1: 'Your wallet',
  setup_taglineLine2: 'for Midnight.',
  setup_intro:
    'A developer wallet for the Midnight network. Send, receive and hold $1, with your details shielded.',
  setup_devNote: 'Unaudited and built for development. New wallets start on a test network.',
  setup_createWallet: 'Create a new wallet',
  setup_alreadyHaveOne: 'I already have one',
  setup_freeToCreate: 'Free to create. Your keys stay on this device.',
  setup_stepProgress: '$1 of $2',
  setup_importTitle: 'Bring your wallet back',
  setup_importSubtitle: 'Type your 24-word secret phrase in order, or paste the whole thing at once.',
  setup_pastePhrase: 'Paste phrase',
  setup_copyPhrase: 'Copy phrase',
  setup_copyPhraseDone: 'Copied',
  setup_continue: 'Continue',
  setup_settingUp: 'Setting up…',
  setup_passwordTitle: 'Create a password',
  // Restore-from-seed. A wallet created from a raw hex seed has no mnemonic and
  // cannot be given one, so these sit alongside the phrase copy rather than
  // replacing it. The no-checksum warning is load-bearing: it is the only thing
  // standing between a mistyped seed and a silently different, empty wallet.
  setup_importKindPhrase:
    'Recovery phrase',
  setup_importKindSeed:
    'Hex seed',
  setup_importSeedSubtitle:
    'Paste the hex seed for this wallet. It stays visible so you can read it back against your backup.',
  setup_importSeedLabel:
    'Hex seed',
  setup_importSeedPlaceholder:
    '64 hexadecimal characters, or 128 for a seed derived from a recovery phrase',
  setup_importSeedNoChecksum:
    'A seed has no built-in check, unlike a recovery phrase. One wrong character restores a different, empty wallet and reports no error, so compare it against your backup before continuing.',
  setup_importSeedUnusualLength:
    'This seed is $1 bytes. Tools produce 32 or 64, so check the paste is complete — an incomplete seed restores a different wallet.',
  setup_importSeedErrNotHex:
    'A seed uses hexadecimal only: digits 0-9 and letters a-f.',
  setup_importSeedErrOddLength:
    'This seed has an odd number of characters, so one is missing.',
  setup_importSeedErrTooShort:
    'Too short at $1 bytes. A seed is 16 to 64 bytes — 64 hexadecimal characters, or 128 for one derived from a recovery phrase.',
  setup_importSeedErrTooLong:
    'Too long at $1 bytes. A seed is 16 to 64 bytes — 64 hexadecimal characters, or 128 for one derived from a recovery phrase.',
  setup_passwordSubtitleSeed:
    "It unlocks Moth on this device. It can't recover your wallet, only your seed can.",
  setup_passwordSubtitle: "It unlocks Moth on this device. It can't recover your wallet, only your 24 words can.",
  setup_accountNameLabel: 'Account name',
  setup_accountNameHint: 'Optional, shown only in this wallet. You can change it later.',
  setup_passwordLabel: 'Password',
  setup_show: 'Show',
  setup_hide: 'Hide',
  setup_passwordHint: 'At least 8 characters',
  setup_confirmPasswordLabel: 'Confirm password',
  setup_passwordMismatch: "Passwords don't match",
  setup_networkTitle: 'Choose a network',
  setup_networkFirstRun: 'Choose which Midnight network this wallet should use.',
  setup_networkNewAccount:
    'The new account gets its own addresses on this network. Your other accounts stay where they are.',
  setup_networkNote: 'You can change these anytime in Settings, under Network.',
  setup_phraseTitle: 'Write down your secret phrase',
  setup_phraseSubtitle: 'These 24 words are the only way back into your wallet. Write them on paper, in order.',
  setup_phraseWarning:
    "Anyone with these words can spend your tokens. Don't screenshot them, and never share them, not even with us.",
  setup_phraseSavedCheckbox: "I've written my phrase down",
  setup_doneTitle: "You're all set",
  setup_doneLine1: 'Your wallet lives in the side panel.',
  setup_doneLine2: 'Pin Moth to your toolbar for quick access.',
  setup_closeTab: 'Close this tab',
} as const;
