export const network = {
  network_title: 'Network',
  network_intro: 'Choose a named network and adjust its endpoints when needed.',
  network_groupAria: 'Midnight network',
  network_descMainnet: 'Live production network',
  network_descDevnet: 'Development and testing',
  network_descPreview: 'Preview upcoming changes',
  network_descPreprod: 'Pre-production testing',
  network_descQanet: 'Quality assurance network',
  network_descStagenet: 'Demo network on the v9 ledger',
  network_descUndeployed: 'Node running on this machine',
  network_endpointUrls: 'Endpoint URLs',
  network_useDefaults: 'Use defaults',
  network_nodeUrl: 'Node URL',
  network_indexerUrl: 'Indexer URL',
  network_proofServerUrl: 'Proof server URL',
  network_proving: 'Proving',
  network_provingMethodAria: 'Proving method',
  network_wasm: 'WASM',
  network_wasmDesc: 'On-device · Fetches proving data on first use',
  network_proofServer: 'Proof server',
  network_proofServerDesc: 'Remote · Required for complex transactions',
  network_provingHelp:
    'The wallet uses the proving method selected here for wallet and dApp transactions. WASM is recommended for simple transactions, such as token transfers. Complex transactions, such as contract calls, require a proof server. Run one locally — a Docker container is available — or use one operated by a party you trust, running in a TEE with appropriate attestation. Proving reveals transaction details to whoever runs the server, so a remote one without attestation sees everything you prove.',
  network_resyncNote:
    'Changing the indexer clears local sync data and resyncs this account. Switching networks keeps each network\u2019s synced state, so switching back resumes where it left off. Other endpoint edits keep the current sync state.',
  network_authHeaderName: 'Node auth header',
  network_authHeaderValue: 'Header value',
  network_authHeaderHelp:
    'Optional. Some node endpoints rate-limit and refuse connections without an operator-issued header. Sent only to the node, never to the indexer. Stored unencrypted on this device and not protected by your password — treat it as a shared secret.',
  network_saveError: 'The network configuration could not be saved.',
  network_saving: 'Saving…',
  network_mainnetHidden:
    'Networks with real value are hidden. This wallet is unaudited and unsupported — turn on Developer mode in Settings to show them.',
  network_valueWarningTitle: 'Switch to $1 — real funds?',
  network_valueWarningBody:
    '$1 carries real value. This wallet is experimental, unaudited and comes with no support or warranty — it is intended for development and testing. Anything you lose here is unrecoverable. Do not use it to hold funds you care about.',
  network_switchTitle: 'Switch to $1?',
  network_changeIndexerTitle: 'Change indexer and resync?',
  network_switchResync: 'Switch & resync',
  network_saveResync: 'Save & resync',
  network_switchBody:
    'Switching from $1 shows this account on the new network. Each network\u2019s synced state is kept, so switching back resumes where it left off.',
  network_changeIndexerBody:
    "Changing the indexer clears this account's local sync state and cached balances, because a different indexer can disagree about history. The resync reuses this network's prepared reference where there is one, so it is usually quick.",
  network_freshSync: 'Moth will start a fresh sync on $1.',
  network_fundsSafe: 'Your funds, account, and secret phrase are not affected.',
} as const;
