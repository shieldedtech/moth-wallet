---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-extension': patch
---

The dApp approval screen tells a contract deploy from a contract call.

It used to count every contract action under "Contract calls", so deploying a
contract looked the same as calling one. It now shows a row for each kind
present: contract deploys, contract calls and contract maintenance updates. The
new labels stay in English in de/fr/es until someone reviews the translations.

In core, `TransactionSummary` gains `contractCalls`, `contractDeploys` and
`maintenanceUpdates`; `contractActions` is still their total.
