# Translation status (de / es / fr)

The English catalog (`messages/`) is the source of truth. Shipped locales live in
`public/_locales/<lang>/messages.json`.

## Status

- **Pre-existing keys** (the original i18n set): professionally translated. Leave as-is.
- **58 new UI-chrome keys** added during the branch reconciliation (address book,
  theme, prover labels, auto-lock durations, multi-output send, register/deregister
  buttons, activity labels): **AI-assisted drafts, NOT reviewed by a native speaker.**
  Safe UI chrome only (buttons, labels, titles, durations). Review recommended before
  a user-facing release, but low-risk.
- **`network_descStagenet`** (stagenet in the network picker): **AI-assisted draft, NOT
  reviewed by a native speaker.** UI chrome describing a developer network, so low-risk
  under the same rule as the 58 keys above.
- **Sensitive copy: intentionally left in English**, pending native-speaker review.
  These carry security / financial / consequence meaning where a mistranslation could
  mislead, so they were NOT machine-drafted. Translate these with care and review:

  - `send_checkAddresses` — irreversibility warning
  - `send_overspent`, `send_addressKindInvalid` — amount / address validation
  - `send_failureSubSingle`, `send_failureSubMulti` — "Nothing was spent" assurance
  - `send_oneTransactionNote` — combined-fee semantics
  - `send_provingFootnote`, `dust_provingFootnote` — prover-choice guidance
  - `network_wasmDesc`, `network_proofServerDesc`, `network_provingHelp` — prover guidance
  - `settings_autoLockDemo`, `settings_autoLockDescription` — auto-lock/demo-mode meaning
  - `dust_noteRegisteredHold`, `dust_noteRegisterPrompt`, `dust_noteUnregisteredSome`,
    `dust_noteNotGenerating` — DUST-generation advisories
  - `dust_generateBodyReceiver`, `dust_deregisterBody`, `dust_deregisteredSub`,
    `dust_deregisterFailureSub`, `dust_generationStopped`, `dust_fromYourNightGenerating`
    — DUST register/deregister consequences
  - `dust_receiverHint`, `dust_receiverInvalid`, `dust_addressLabel` — where funds go / address validity
  - `addressBook_detected`, `addressBook_notMidnight`, `addressBook_autoRecognized` — address validity

- **Verbatim by design** (correct as English in every locale — do NOT translate):
  protocol terms *Shielded* / *Unshielded* / *WASM* / *NIGHT* / *DUST*, `mn_…` address
  prefixes, the *Moth* brand, and numeric/symbol strings (`0`, `25%`, `$1 $2`).

## Guardrails

`tests/i18n.test.ts` enforces that every locale carries exactly the catalog keys with
matching `$1..$9` placeholders and preserves the untranslatable terms. Adding a key to
`messages/` without adding it to each locale fails the test. `tests/no-hardcoded-strings.test.ts`
fails on any hard-coded UI string in components.
