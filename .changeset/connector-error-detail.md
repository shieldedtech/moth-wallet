---
'@shieldedtech/moth-extension': patch
---

Carry an error's structured fields through to the dApp, by allowlist.

`serializeError` reduces every failure to `{code, reason}` with `reason` a plain
string, so a dApp receives the message and nothing else. Wallet SDK errors keep
the useful part in their fields: `InsufficientFundsError` carries `tokenType`
and `amount` — exactly which token is short and by how much. Debugging a
contract call that could not be balanced, the page saw only

```
Insufficient funds for fallible segment 31897
```

with no way to tell whether the shortfall was the contract's token or the fee
token, which need entirely different fixes.

`describeErrorFields` now folds a fixed set of fields — `tokenType` and
`amount` — from an error and its `cause` chain into the reason, with per-value
and total length caps, following only `cause` values that are themselves
Errors.

Errors crossing the offscreen → service worker hop now have their bigints
converted to decimal strings first. That hop is JSON, and @webext-core
serializes an Error by spreading its own enumerable properties, so the SDK's
`amount` reached `JSON.stringify` and threw "Do not know how to serialize a
BigInt" — failing the entire reply rather than dropping one field. The error a
dApp most needs was the one that could not arrive.

An allowlist rather than a denylist because this is a trust boundary into an
untrusted page. Forwarding every scalar own property, as the first version of
this did, reached further than intended: a probe with an HTTP context hung off
a cause produced `url=https://user:tok@indexer.example/...`, its `status` and
its response `body`; a 200 KB `responseText` was copied whole; and the
`originalStack` that `core/contract/deploy.ts` attaches to a failed deploy
would have put a stack trace on the page. It also changed `reason` for errors
that were never the point — every `WalletError` gained `[category=...]`, and a
thrown array rendered as `0=a, 1=b, length=2` — which would break a dApp
matching exact reason strings.
