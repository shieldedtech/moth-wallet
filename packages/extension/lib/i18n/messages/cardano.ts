export const cardano = {
  cardano_title: 'Cardano',
  cardano_subtitle: 'cNIGHT and DUST designation',
  cardano_openFromHome: 'Cardano',
  cardano_homeSubtitle: 'Generate $1 from cNIGHT you hold on Cardano',

  // Account — derived, never created. This is the question people ask first.
  cardano_accountSection: 'Your Cardano account',
  cardano_accountDerived:
    "Derived from this wallet's recovery phrase. There is no separate Cardano account to create, and nothing extra to back up.",
  cardano_accountFundHint: 'Send ADA and cNIGHT to this address to get started.',
  cardano_copy: 'Copy',
  cardano_addressCopied: 'Address copied',
  cardano_txCopied: 'Transaction ID copied',
  cardano_viewInExplorer: 'View in explorer',
  cardano_chainUnavailable: 'Balances and registration cannot be read yet.',

  // Overview
  cardano_networkRow: 'Cardano network',
  cardano_addressRow: 'Address',
  cardano_stakeAddressRow: 'Stake address',
  cardano_adaRow: 'ADA',
  cardano_cnightRow: 'cNIGHT',
  cardano_cnightUtxos: 'across $1 UTXOs',
  cardano_cnightUtxosOne: 'in 1 UTXO',
  cardano_designationRow: 'DUST designation',
  cardano_registered: 'Registered',
  cardano_registeredElsewhere: 'Registered to another wallet',
  cardano_notRegistered: 'Not registered',
  cardano_dustToRow: 'DUST goes to',
  cardano_dustToThisWallet: 'This wallet',
  cardano_generatingRow: 'Generating',
  cardano_notYetObserved: 'Not yet observed on Midnight',
  cardano_midnightRow: 'On Midnight',
  cardano_midnightPending: 'Not seen yet',
  cardano_midnightRejected: 'Rejected',
  cardano_midnightLive: 'Generating',
  cardano_midnightPendingHint:
    'Cardano has the registration and Midnight has not picked it up. Before finality that is expected; long after it, the bridge may not be ingesting registrations.',
  cardano_midnightRejectedHint:
    'Midnight read this registration and rejected it. Waiting will not change that \u2014 deregister and register again.',
  cardano_deregisteredCleared:
    'Cleared $1 registrations. That duplicate state was why nothing was generating \u2014 you can register once now.',
  cardano_multipleRegistrations:
    'This Cardano stake key has $1 registrations. More than one forces deregistration, so nothing is generating. Deregister to clear them, then register once.',
  cardano_legacyDustAddress:
    'This registration records an older, unusable receiver, so it will never generate DUST — Cardano accepted it, but Midnight cannot match it. Use Update to point it at your current DUST address; you do not need to deregister first.',
  cardano_notYetObservedHint:
    'Cardano has the registration; Midnight has not acted on it yet. This is normal right after registering.',
  cardano_generatingAccruing: 'Accruing since registration',
  cardano_generationRateValue: '$1 $2/s',
  cardano_meterSubtitle: 'From your cNIGHT',
  cardano_dustAddressRow: 'DUST is paid to',
  cardano_usableRow: 'Usable',
  cardano_usableIn: 'in about $1',
  cardano_usableAnyMoment: 'any moment now',
  cardano_usableNow: 'Now',
  cardano_usableUnknown: 'Waiting for confirmation',
  cardano_finalityHint:
    'DUST accrues from the moment you registered. It becomes usable once Cardano finalises the registration \u2014 about 12 hours \u2014 and nothing is wrong in the meantime.',

  // Actions
  cardano_register: 'Register',
  cardano_deregister: 'Deregister',
  cardano_update: 'Change DUST address',
  cardano_refresh: 'Refresh',
  cardano_registerHint: 'Generate DUST on Midnight from the cNIGHT you hold on Cardano.',
  cardano_updateHint: 'Send the generated DUST to a different Midnight address.',
  cardano_rotationNote:
    'Every cNIGHT you hold is sent back to your own address in the same transaction. That is what makes the change take effect.',
  cardano_confirmTitle: 'Confirm on Cardano',
  cardano_confirm: 'Confirm',
  cardano_confirmActionLabel: 'Action',
  cardano_confirmNetworkLabel: 'Cardano network',
  cardano_confirmAccountLabel: 'Account',
  cardano_confirmDustToLabel: 'DUST to',
  cardano_confirmCnightMovedLabel: 'cNIGHT moved',
  cardano_confirmThisWallet: 'This wallet',
  cardano_confirmMinAda: 'Minimum carried with cNIGHT',
  cardano_confirmDeregisterNote:
    'This cNIGHT stops generating DUST once the deregistration is on chain. You can register again later.',
  cardano_cancel: 'Cancel',
  cardano_submitting: 'Submitting to Cardano…',
  cardano_submitted: 'Submitted',
  cardano_notSubmitted: 'Not submitted',
  cardano_receiverUnchanged: 'That is already where this cNIGHT sends its DUST.',
  cardano_txRow: 'Transaction',
  cardano_afterRegisterNote:
    'Registered. DUST accrues from now, and becomes usable once Cardano finalises the registration \u2014 about 12 hours.',

  // Receiver entry
  cardano_receiverPickAccount: 'Send DUST to one of your accounts',
  cardano_receiverSelected: 'Selected',
  cardano_receiverLabel: 'Midnight DUST address',
  cardano_receiverPlaceholder: 'mn_dust_\u2026',
  cardano_receiverUseThisWallet: 'Use this wallet',
  cardano_receiverInvalid:
    'Paste a Midnight DUST address (mn_dust_\u2026) or its 66-character hex.',

  // Errors / unavailable states
  cardano_errorLocked: 'Unlock your wallet to use Cardano.',
  cardano_errorImportedLocked:
    'This imported account could not be unlocked. Lock and unlock your wallet, then try again.',
  cardano_errorNoDustAddress:
    'This wallet has no DUST address on the current network, so there is nowhere to send generated DUST.',
  cardano_errorNoMnemonic:
    'This account was restored from a hex seed, so it has no Cardano address. Cardano keys come from a recovery phrase.',
  cardano_errorNoBlockfrostKey:
    'Add a Blockfrost project ID in Settings to read Cardano and submit transactions.',
  cardano_errorNoCnight: 'You need at least one cNIGHT to register.',
  cardano_loading: 'Reading Cardano…',
  cardano_retry: 'Try again',

  // Accounts
  cardano_accountsTitle: 'Cardano accounts',
  cardano_accountsManage: 'Manage accounts',
  cardano_accountActive: 'Active',
  cardano_accountDerivedTag: 'From recovery phrase',
  cardano_accountImportedTag: 'Imported',
  cardano_accountAdd: 'Add account',
  cardano_accountAddHint:
    'Creates the next account from this wallet\u2019s recovery phrase. It gets its own address and its own DUST registration, and the phrase you already have restores it.',
  cardano_accountImport: 'Import from recovery phrase',
  cardano_accountImportHint:
    'Adds a Cardano-only account from a separate 12 or 24 word phrase. It will not hold Midnight funds, and your moth recovery phrase does NOT restore it \u2014 keep that phrase safe yourself.',
  cardano_accountImportPhrase: 'Recovery phrase',
  cardano_accountImportPhrasePlaceholder: 'word one word two word three\u2026',
  cardano_accountImportPassphrase: 'Wallet passphrase',
  cardano_accountImportPassphraseHint: 'Used to encrypt the imported phrase on this device.',
  cardano_accountLabel: 'Name (optional)',
  cardano_accountRename: 'Rename',
  cardano_accountRenameTitle: 'Rename account',
  cardano_accountRenamed: 'Account renamed',
  cardano_accountNameEmpty: 'Enter a name.',
  cardano_accountRemove: 'Remove',
  cardano_accountRemoveConfirm:
    'Remove this account? For an imported account this deletes the only copy of its phrase held here.',
  cardano_accountSwitch: 'Switch',
  cardano_accountInvalidPhrase: 'That is not a valid BIP-39 recovery phrase.',
  cardano_accountPassphraseRequired: 'Enter your wallet passphrase.',
  cardano_accountAdded: 'Account added',
  cardano_accountImported: 'Account imported',
  cardano_accountRemoved: 'Account removed',
  cardano_accountBack: 'Done',

  // Send
  cardano_send: 'Send',
  cardano_sendTitle: 'Send on Cardano',
  cardano_sendTo: 'To address',
  cardano_sendToPlaceholder: 'addr_test1\u2026',
  cardano_sendAda: 'ADA',
  cardano_sendCnight: 'cNIGHT',
  cardano_sendAvailable: 'Available: $1',
  cardano_sendNothing: 'Enter an ADA amount, a cNIGHT amount, or both.',
  cardano_sendBadAddress: 'That is not a Cardano address for this network.',
  cardano_sendBadAmount: 'Enter a number.',
  cardano_sendRegisteredWarning:
    'This account is registered for DUST. cNIGHT you send away stops generating, and sending rotates the rest.',
  cardano_sendSent: 'Sent',

  // Settings
  cardano_settingsSection: 'Cardano',
  cardano_settingsBlockfrostLabel: 'Blockfrost project ID',
  cardano_settingsBlockfrostFor: 'Blockfrost project ID for $1',
  cardano_settingsNoNetwork: 'Cardano has no network paired with $1.',
  cardano_settingsBlockfrostHint:
    'Needed to read Cardano and submit cNIGHT transactions. Get one free at blockfrost.io.',
  cardano_settingsBlockfrostStored: 'Stored. Enter a new ID to replace it.',
  cardano_settingsSaved: 'Cardano settings saved',
} as const;
