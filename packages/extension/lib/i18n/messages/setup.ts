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
  setup_birthdayTitle: 'When did this phrase start being used?',
  setup_birthdayHint:
    'Telling Moth this lets the first sync skip older blocks — seconds instead of up to an hour. Answer early rather than late: too early only costs time, while too late hides shielded funds received before it, and shielded balances give no sign that anything is missing. Unshielded funds are found either way. Clearing the sync cache recovers everything.',
  setup_birthdayUnknown: "I don't know — scan the whole chain",
  setup_birthdayTip: 'I just generated it — nothing to scan',
  setup_birthdayDate: 'Not used before a date',
  setup_birthdayHeight: 'Not used before a block height',
  setup_birthdayDiscover: 'Look it up for me — unshielded history only',
  setup_birthdayDiscoverNote:
    'Finds the first unshielded transaction for this phrase. Shielded funds cannot be found this way: ' +
    'if this phrase received shielded funds earlier, they will not appear until the account is rescanned.',
  setup_birthdayHeightPlaceholder: 'Block height',
  setup_pastePhrase: 'Paste phrase',
  setup_copyPhrase: 'Copy phrase',
  setup_copyPhraseDone: 'Copied',
  setup_continue: 'Continue',
  setup_settingUp: 'Setting up…',
  setup_passwordTitle: 'Create a password',
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
