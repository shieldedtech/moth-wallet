export const dust = {
  dust_waitingForSync: 'Waiting for sync…',
  dust_startGenerating: 'Start generating $1',
  dust_registerAmount: 'Register $1 $2',
  dust_stopGenerating: 'Stop generating $1',
  dust_percentGenerated: '$1% generated',
  dust_generatedNow: 'Generated now',
  dust_amountLabel: '$1 $2',
  dust_totalPossible: 'Total possible',
  dust_fromYourNight: 'From your $1 $2',
  dust_fromYourNightGenerating: 'From your $1 $2 generating now',
  dust_generationRate: 'Generation rate',
  dust_setByNetwork: 'Set by the network',
  dust_variable: 'Variable',
  dust_generationRow: 'Dust generation',
  dust_registeredGenerating: 'Registered — generating',
  dust_notRegistered: 'Not registered',
  dust_noteRegistered:
    'Your $1 is registered — $2 builds up on its own while you hold it. $1 you receive later registers automatically.',
  dust_noteRegisteredHold:
    'Your $1 is registered — $2 builds up on its own while you hold it, and $1 you receive later joins in by itself.',
  dust_noteUnregistered: 'Register your $1 to start generating $2. Any $1 you receive later registers automatically.',
  dust_noteRegisterPrompt: 'Register your $1 to start generating $2. $1 you receive afterwards joins in by itself.',
  dust_noteNoNight: '$1 builds up on its own while you hold $2. Paying fees uses some, then it refills.',
  dust_noteUnregisteredSome: "$1 $2 isn't registered for $3 generation. Register it to raise your total.",
  dust_noteNotGenerating:
    "$1 $2 isn't generating $3 yet — new or recently moved $2 starts on its own after a short delay. If this amount doesn't shrink, resync from Settings → Network.",
  dust_syncingWallet: 'Syncing $1…',
  dust_finalAmounts: 'Final amounts show once sync completes.',
  dust_generateTitle: 'Generate $1?',
  dust_register: 'Register',
  dust_stop: 'Stop',
  dust_stopTitle: 'Stop generating $1?',
  dust_generateBody: 'This registers your $1 so it starts generating $2. Any $1 you receive later registers automatically.',
  dust_generateBodyReceiver:
    'This registers your unregistered $1 so it starts generating $2. You can do this again whenever you receive more $1.',
  dust_receiveRegisterNudge: 'Received $1 — register it now so it starts generating $2 right away.',
  dust_staleRegisterWarning:
    "Some of this $1 has been sitting unregistered for a while. On some networks, registering $1 long after receiving it — rather than right away — has been linked to a rare, serious network fault with no fix but a network reset. It's safest to register $1 as soon as it arrives.",
  dust_deregisterBody:
    "This deregisters your $1 from $2 generation. The $2 you have stays and still pays fees, but it won't refill. You can register again anytime.",
  dust_addressLabel: '$1 address',
  dust_receiverHint: "Where the generated $1 goes. Prefilled with this wallet's own address.",
  dust_receiverInvalid: "That doesn't look like a $1 address (mn_dust…).",
  dust_registeringFor: 'Registering for $1…',
  dust_stoppingGeneration: 'Stopping $1 generation…',
  dust_pendingSub1: 'This usually takes under a minute.',
  dust_pendingSub2: "You can close the panel, we'll keep going.",
  dust_stepBuilt: 'Registration built',
  dust_stepBuiltTx: 'Transaction built',
  dust_stepProving: 'Generating proof',
  dust_stepProvingSub: 'Runs on your proof server, details never leave it',
  dust_stepSubmitting: 'Submitting to network',
  dust_alreadyGeneratingTitle: 'Already generating $1',
  /** Registration registered nothing because the wallet holds no NIGHT. */
  dust_registerNoNight: "You don't have any $1 to register yet.",
  /** Registration registered nothing because the NIGHT is not spendable —
   *  usually booked by an earlier transaction that hasn't settled. */
  dust_registerUnavailable:
    'Your $1 is not available to register right now. An earlier transaction may still be in flight — wait for it to settle, then try again.',
  /** Per-coin breakdown. Exists because the displayed balance folds in booked
   *  coins, so "500 $1" and "$1 you can register" are different numbers. */
  dust_coinsTitle: 'Your $1 coins',
  dust_coinsShow: 'Show breakdown',
  dust_coinsHide: 'Hide breakdown',
  dust_coinsRegistered: 'Generating',
  dust_coinsUnregistered: 'Not registered',
  dust_coinsBooked: 'Booked by a pending transaction',
  dust_coinsBookedNote:
    '$1 of your $2 is reserved by a transaction that has not settled. Booked coins count toward your balance but cannot be registered until it does.',
  dust_coinsEmpty: 'No $1 coins.',
  dust_generatingTitle: "You're generating $1",
  dust_alreadyGeneratingSub: 'Your $1 was already registered. $2 keeps building as you hold it.',
  dust_generatingSub: 'Your $1 is registered. $2 will start building up as it syncs.',
  dust_generationStopped: '$1 generation stopped',
  dust_deregisteredSub: 'Your $1 is deregistered. The $2 you have keeps paying fees; register again anytime.',
  dust_failureTitle: "That didn't go through",
  dust_failureSub: "Your $1 wasn't registered. Nothing was spent.",
  dust_deregisterFailureSub: 'Nothing changed — your $1 is still registered.',
  dust_tryAgain: 'Try again',
  dust_backToHome: 'Back to home',
  dust_reason: 'Reason',
  dust_unknownError: 'Unknown error',
  dust_failureFootnote: "If the proof server didn't respond, check Settings, then Network.",
  dust_provingFootnote:
    'If proving failed, check the selected method under Settings → Network. Complex transactions require a proof server.',
  // Bare durations, so a wait can be composed into different sentences. See
  // lib/ui/wait-phrase.ts for why the buckets are coarse.
  dust_waitSeconds: 'about $1 seconds',
  dust_waitMinutes: 'about $1 minutes',
  dust_waitHour: 'about an hour',
  dust_waitHours: 'about $1 hours',
  dust_waitDays: 'about $1 days',
  // Registration self-funds from the DUST its NIGHT would already have earned,
  // and that amount starts at zero — so on a freshly funded wallet this is "not
  // yet", not a failure. Worded to say so, because the old screen said
  // "That didn't go through" and pointed at the proof server.
  dust_notYetTitle: 'Not quite yet',
  dust_notYetSub: 'Nothing was spent. Your $1 needs a little longer.',
  dust_notYetReason:
    'Registering pays its own fee from the $1 your $2 has earned since it arrived, so a new wallet has to wait a little. Ready in $3.',
  dust_notYetNeedMore:
    'Registering pays its own fee from the $1 your $2 earns, and this balance is too small to ever cover it. Add more $2, then try again.',
  dust_paysYourFees: 'Pays your fees',
  dust_ofMax: 'of $1',
  dust_ofMaxWithLabel: 'of $1 $2',
  dust_etaWaitingFor: 'Waiting for $1',
  // Shown when the wallet HOLDS $1 but none is registered — capacity it has
  // and is not using. 'Waiting' would be wrong: nothing is being waited for.
  dust_etaNotRegistered: '$1 not registered yet',
  dust_etaSyncing: 'Syncing…',
  dust_etaFullyGenerated: 'Fully generated',
  dust_etaFullInMin: 'Full in about $1 min',
  dust_etaFullInHour: 'Full in about 1 hour',
  dust_etaFullInHours: 'Full in about $1 hours',
  dust_etaFullInDays: 'Full in about $1 days',
  dust_rebuildRecords: 'Rebuild $1 records',
  dust_rebuildNote:
    "Some registered $1 still isn't generating $2. Rebuilding rescans your records from the chain — it spends nothing, but takes several minutes.",
} as const;
