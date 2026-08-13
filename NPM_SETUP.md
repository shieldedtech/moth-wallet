# npm Setup Guide

> **Infrastructure setup has moved.** The one-time steps to create the npm org, do the first
> publish, and enable Trusted Publishing now live in **[SRE_PUBLISHING_SETUP.md](./SRE_PUBLISHING_SETUP.md)**.
> Day-to-day release instructions for developers are in **[RELEASE.md](./RELEASE.md)**.

This monorepo publishes four packages to npm under the **`@shieldedtech`** scope:

- `@shieldedtech/moth-wallet` (core library)
- `@shieldedtech/moth-cli` (CLI tool)
- `@shieldedtech/moth-browser` (browser library)
- `@shieldedtech/moth-tui` (terminal UI)

Publishing uses [Changesets](https://github.com/changesets/changesets) for versioning and
**npm Trusted Publishing (OIDC)** for authentication — there is no long-lived npm token in steady
state. See the SRE runbook for the (one-time) token bootstrap and OIDC cutover.

## Consuming the packages

```bash
npm install @shieldedtech/moth-wallet
# or
yarn add @shieldedtech/moth-wallet
```

```typescript
import { deployContract, createWallet } from '@shieldedtech/moth-wallet';
```

## Quick reference

- **View releases:** `npm view @shieldedtech/moth-wallet versions`
- **Check collaborators:** `npm access ls-collaborators @shieldedtech/moth-wallet`
- **Package page:** https://www.npmjs.com/package/@shieldedtech/moth-wallet
