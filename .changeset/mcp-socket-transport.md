---
"@shieldedtech/moth-cli": patch
---

Serve MCP over a Unix socket, and refuse spend tools on the unauthenticated one.

`--transport http` binds a loopback TCP port with no authentication, so any process or any other user on the host can drive it. That is the exposure the daemon refuses outright — it will not start a TCP bind without API keys — and the wallet-service spec puts loopback TCP at "API key required", not "open".

`--transport socket <path>` serves the same MCP Streamable HTTP framing over a Unix socket, chmod 0600 after bind, exactly as the daemon tightens its own socket. Access control becomes the kernel's: no API keys to distribute, no TLS to terminate, and no DNS-rebinding surface at all, since a browser cannot open a Unix socket. Concurrent sessions still share one unlocked wallet and its warm sync. A stale socket left by a killed process is reclaimed, but only when the path is genuinely a socket — never a regular file.

Spend tools are now refused on `--transport http`. They remain available on stdio, where the spawning client owns the process, and on the socket, where the file mode says who may connect. The consent gate is otherwise unchanged.
