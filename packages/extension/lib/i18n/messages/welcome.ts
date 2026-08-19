export const welcome = {
// The tagline describes the tool, not the network. "Money, but private." made
// two claims this wallet does not keep: a fresh install lands on preprod (see
// DEFAULT_SETTINGS — deliberately not mainnet, because this is unaudited), so
// there is no money; and the unshielded sub-wallet is public on chain, so
// privacy is not unconditional. Both lines stay short because the setup tab
// sets them at 72px in a 520px column.
  welcome_taglineLine1: 'Your wallet',
  welcome_taglineLine2: 'for Midnight.',
  welcome_intro:
    'A developer wallet for the Midnight network. Send, receive and hold $1, with your details shielded.',
  welcome_devNote: 'Unaudited and built for development. New wallets start on a test network.',
  welcome_createWallet: 'Create a new wallet',
  welcome_alreadyHaveOne: 'I already have one',
  welcome_settingUpAccount: 'Setting up your account',
  welcome_finishInSetupTab: 'Finish creating your account in the open setup tab. This panel will update on its own.',
  welcome_goToSetupTab: 'Go to setup tab',
  welcome_cancelSetup: 'Cancel setup',
  welcome_gettingThingsReady: 'Getting things ready',
  welcome_loadingFailedTitle: 'Could not open your wallet',
  welcome_loadingFailedHint: 'This usually means the selected network is unreachable, or is not the one this account works on.',
  welcome_loadingFailedAction: 'Change network',
  welcome_loadingPreparingWallet: 'Preparing your wallet',
  welcome_loadingCatchingUp: 'Catching up with Midnight',
  welcome_loadingPreparingNewWallet: 'Preparing your new wallet',
  welcome_loadingStartingServices: 'Starting secure wallet services',
  welcome_loadingOpeningWallet: 'Opening your secure wallet',
} as const;
