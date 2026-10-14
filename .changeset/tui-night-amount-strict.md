---
'@shieldedtech/moth-tui': patch
---

The TUI's Send screen parses NIGHT amounts with core's `parseNightAmount`.

It had its own parser, which cut off a seventh decimal place instead of
rejecting it, so `1.1234567` was sent as `1.123456`. The TUI's local
`parseNightAmount` in `utils/balance.ts`, used for a second parse at submit
time, is removed too.
