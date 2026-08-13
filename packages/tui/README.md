# @shieldedtech/moth-tui

Interactive terminal dashboard for the [Midnight Network](https://midnight.network), built with
[React](https://react.dev) and [Ink](https://github.com/vadimdemedes/ink). It powers the
`moth tui` command in [`@shieldedtech/moth-cli`](https://www.npmjs.com/package/@shieldedtech/moth-cli)
and is published as a reusable component so you can embed it in your own Ink app.

Part of [Moth](https://github.com/shieldedtech/moth-wallet).

> **Experimental — use at your own risk.** This is unaudited software provided AS-IS with no
> warranty, for development and testing only. Do not use it with real funds on mainnet.

## Install

```bash
npm install @shieldedtech/moth-tui
```

## Usage

The package exports the `App` component (the full dashboard). Render it with Ink — this is exactly
what `moth tui` does under the hood:

```typescript
import React from 'react';
import { render } from 'ink';
import { App } from '@shieldedtech/moth-tui';

render(React.createElement(App, { walletName: 'dev', networkId: 'preview' }));
```

`AppProps` is `{ walletName?: string; networkId?: string }`.

The dashboard provides wallet onboarding, balances, token send, contract deploy/call, DUST
operations, and network settings. The proving method selected on the Network
screen is used for wallet and dApp transactions. Local WASM proving is
recommended for simple transactions, such as token transfers; complex
transactions, such as contract calls, require a configured proof server.

### Keybindings

| Key | Action |
| --- | --- |
| `M-m` (Alt+M) | Toggle navigation menu |
| `1`–`9` | Navigate to screen (when menu is open) |
| `M-p` (Alt+P) | Pause/resume wallet sync |
| `M-q` (Alt+Q) | Quit |
| `Esc` | Back/cancel within screens |

Screens: 1 Dashboard, 2 Send, 3 Deploy, 4 Mint, 5 Contract, 6 Keys, 7 DUST, 8 Network, 9 Logs.

## Documentation

See the [project README](https://github.com/shieldedtech/moth-wallet#readme) for full usage and
architecture.

## Acknowledgements

The TUI draws on patterns and screen designs from
[mn-tui](https://github.com/input-output-hk/arc-mn-tui) (Apache-2.0). See
[NOTICE](https://github.com/shieldedtech/moth-wallet/blob/main/NOTICE) for attribution.

## License

Apache-2.0 — see [LICENSE](https://github.com/shieldedtech/moth-wallet/blob/main/LICENSE).
