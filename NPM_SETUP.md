# npm Setup Guide

> **Infrastructure setup has moved.** Trusted-publisher configuration, verification, and
> credential cleanup now live in **[SRE_PUBLISHING_SETUP.md](./SRE_PUBLISHING_SETUP.md)**.
> Day-to-day release instructions for developers are in **[RELEASE.md](./RELEASE.md)**.

This monorepo publishes three private packages to npm under the **`@shieldedtech`** scope:

- `@shieldedtech/moth-wallet` (core library)
- `@shieldedtech/moth-cli` (CLI tool)
- `@shieldedtech/moth-tui` (terminal UI)

`@shieldedtech/moth-browser` is excluded from publication because its package manifest marks it
as private.

Publishing uses [Changesets](https://github.com/changesets/changesets) for versioning and
**npm Trusted Publishing (OIDC)** for authentication — there is no long-lived npm token in steady
state. See the SRE runbook for trusted-publisher configuration, verification, and credential
cleanup.

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
