# Passkey backup: design (experimental)

An optional second backup of a Moth account's recovery phrase, encrypted with a key that only a synced passkey can produce. The written recovery phrase stays the primary backup.

## How it works

1. Create a platform passkey for relying party `moth.shielded.io`, requesting the PRF extension (`ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest.prf`, iOS 18+). Stop if the result reports PRF unsupported.
2. Derive the wrapping key: `HKDF<SHA256>(ikm: prf.first, salt: "moth-backup", info: "moth:backup:v1:" + walletName)`, 32 bytes.
3. Encrypt the **recovery phrase** with AES-GCM under that key. The keystore passphrase alone would be useless on a new phone, because the keystore it opens lives in the engine's on-device IndexedDB.
4. Store the ciphertext and the credential ID as a synchronizable Keychain item (iCloud Keychain). The item holds only ciphertext, so it doesn't need `.userPresence`.
5. **Restore** on a new phone: find the synced item, assert the passkey with the same salt (`ASAuthorizationPublicKeyCredentialPRFAssertionInput`), decrypt, and import the phrase through the normal restore path. The import creates a fresh device-only Vault entry.

The salt is Moth's own. Passport (`midnightntwrk/passport`, `demo/mn-passport-foundations/app/src/lib/passkey.ts`) uses the raw PRF output with salt `midnight:passport:prf:device:v0` as a signing key; reusing that salt would tie Moth backups to Passport accounts.

## Threat model

- With the backup enabled, recovering the phrase requires the user's Apple Account and a device passcode, because iCloud Keychain escrows both the passkey and the ciphertext. That is the same bar as today's `.userPresence`, which already falls back to the passcode. Apple never sees the phrase in plaintext.
- If the passkey is deleted in the Passwords app, the backup is unrecoverable. Moth should detect a missing credential and say so.
- If the user signs out of iCloud or turns off Keychain sync, nothing syncs.
- iOS 17 devices and some third-party credential managers have no PRF; gate on `#available(iOS 18, *)` and the registration result.

## Blockers before it can be built and tested

- **An associated domain.** Native passkeys need the `webcredentials:moth.shielded.io` entitlement and `https://moth.shielded.io/.well-known/apple-app-site-association` listing `<TeamID>.bob.shielded.moth`, served over https with no redirects. The relying-party ID is permanent: changing it orphans every backup. For development, `webcredentials:<domain>?mode=developer` skips Apple's CDN but still needs a reachable https host and a development-signed build.
- **A provisioning profile with Associated Domains.** The wildcard team profile Moth signs with today doesn't include that capability.
- **A device.** Passkey PRF in the Simulator is unverified.

## Social recovery

Passport's guardian scheme (`contract/src/wallet/recovery.ts`, ANARKey/BUSS) does its secret sharing in client code. Without its contract, though, there is no delay, no cancellation and no proof that a successor device is involved: any t+1 colluding guardians would get the phrase outright. Its hash and AEAD choices are also still interim. It belongs after MIP-0012/0013 are accepted and Moth supports contract custody. Passport's `shamir.ts` is marked "do not ship" and should not be used.
