---
'@shieldedtech/moth-extension': patch
---

Round sync percentages down and cap unfinished sub-wallets at 99% until their
completion flags are true. This prevents the header and popover from reporting
100% and "Synced" while the DUST panel is still syncing.
