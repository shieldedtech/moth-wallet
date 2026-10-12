---
'@shieldedtech/moth-extension': patch
---

The side panel no longer stays blank while a large chain restores. It shows the
loading screen right away, with the network being loaded and a Settings
button, so a wallet opened on the wrong network can switch without waiting for
the restore to finish. A network switch made during the restore closes the
still-restoring engine immediately instead of waiting 45 seconds for a stop it
cannot answer.
