// Transaction-progress copy shared by the send, DUST and Home surfaces
// (components/moth/proving.tsx). Kept together because the same note must read
// identically wherever a proof is running.
export const status = {
  /** Proving step, local WASM prover: sets the expectation a proof server never needed. */
  status_provingLocal: 'Proving on this device — a few minutes is normal.',
  status_provingLocalDetail: 'Your transaction details never leave this browser.',
  status_provingServer: 'Runs on your proof server, details never leave it',
  status_provingLoading: 'Loading the proving method…',
  /** Pending-screen hero line while the local prover runs; replaces "under a minute". */
  status_pendingLocalTime: 'Local proving usually takes a few minutes.',
  /** Elapsed clock beside the beating moth, e.g. "1:42 elapsed". */
  status_elapsed: '$1 elapsed',
  /** Home banner for an operation running out of view (a dApp request, a send whose screen was left). */
  status_backgroundTitle: 'Working on a transaction',
  status_backgroundBuilding: 'Building the transaction…',
  status_backgroundProving: 'Generating the proof…',
  status_backgroundSubmitting: 'Submitting to the network…',
  status_backgroundHint: 'It keeps going if you close this panel.',
} as const;
