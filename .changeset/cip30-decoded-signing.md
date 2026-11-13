---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

Show what a CIP-30 request signs before asking (#205).

`signTx` and `submitTx` approvals now decode the dApp's transaction against this account's own UTXOs: what leaves the wallet, each output with its ADA and assets, the fee, the net change, inputs supplied by others, certificates, reward withdrawals, minting, and which of this account's keys would sign. `signData` shows the message, as text when it is printable UTF-8 and as hex otherwise. A transaction that cannot be decoded is refused without prompting. Core gains `describeTx` and `describeSignDataPayload` in `cardano/cip30`.
