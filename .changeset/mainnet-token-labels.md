---
"@shieldedtech/moth-extension": patch
---

Make the DUST components' asset labels a required prop, so mainnet cannot
silently render tNIGHT/tDUST.

`DustMeterCard` and `DustRingGauge` defaulted `labels` to
`TESTNET_NATIVE_ASSET_LABELS`. Any caller that omitted the prop got testnet
naming on every network, mainnet included, with nothing to indicate it — a
default that is wrong on the one network where being wrong matters. Calling real
NIGHT "tNIGHT" tells someone their funds are test funds.

Both existing callers already pass labels, so this changes no rendering today.
It makes the failure a compile error rather than a silent one, which is the
point: the next caller cannot introduce it.

Adds tests for `nativeAssetLabelsForNetwork`, including that it tolerates case
and whitespace in the network id — it is fed from stored settings and message
payloads, neither normalised — and that an unknown network falls back to testnet
names. That direction is deliberate: understating real assets as test assets is
recoverable, while labelling test assets as real could persuade someone to send
funds they cannot get back.
